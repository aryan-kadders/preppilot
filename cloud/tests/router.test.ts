// The model router: order, keys, failover before the first words, timeouts,
// Claude request shape and usage. No database: rpc is recorded in memory.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../supabase/functions/_shared/router.ts';
import { routeFor, parseRef, tierOf, FIRST_TOKEN_TIMEOUT_MS } from '../supabase/functions/_shared/models.ts';
import { toClaudeRequest, type AnthropicLike } from '../supabase/functions/_shared/claude.ts';
import type { Deps } from '../supabase/functions/_shared/core.ts';

type ClaudeScript = (params: any, signal?: AbortSignal) => AsyncIterable<any>;

function fakeClaude(script: ClaudeScript) {
  const sent: Array<{ beta: boolean; params: any }> = [];
  const client: AnthropicLike = {
    messages: { stream: (params, o) => { sent.push({ beta: false, params }); return script(params, o?.signal); } },
    beta: { messages: { stream: (params, o) => { sent.push({ beta: true, params }); return script(params, o?.signal); } } },
  };
  return { client, sent };
}

const claudeEvents = (texts: string[], opts: { stop?: string; input?: number; output?: number } = {}): ClaudeScript => async function* () {
  yield { type: 'message_start', message: { usage: { input_tokens: opts.input ?? 100, cache_read_input_tokens: 900 } } };
  for (const t of texts) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } };
  yield { type: 'message_delta', delta: { stop_reason: opts.stop ?? 'end_turn' }, usage: { output_tokens: opts.output ?? 7 } };
  yield { type: 'message_stop' };
};

const geminiSse = (texts: string[]) => new Response(new ReadableStream({
  start(c) {
    const enc = new TextEncoder();
    texts.forEach((t, i) => c.enqueue(enc.encode(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: t }] } }],
      ...(i === texts.length - 1 ? { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } } : {}),
    })}\n\n`)));
    c.close();
  },
}), { status: 200 });

function makeDeps(o: { claude?: AnthropicLike; gemini?: (url: string) => Response | Promise<Response>; geminiKey?: string; routes?: any } = {}) {
  const usage: any[] = [];
  const fetched: string[] = [];
  const logs: any[] = [];
  const deps: Deps = {
    async rpc(fn, args) { if (fn === 'pp_record_usage') usage.push(args); return null; },
    async fetch(url: any) { fetched.push(String(url)); return o.gemini ? o.gemini(String(url)) : geminiSse(['gem']); },
    env: { geminiKey: o.geminiKey ?? 'g', deepgramKey: '', routes: o.routes },
    anthropic: o.claude,
    randomToken: () => 'x',
    log: (line, extra) => logs.push([line, extra]),
  };
  return { deps, usage, fetched, logs };
}

const ask = (deps: Deps, extra: Record<string, unknown> = {}) =>
  chat({ messages: [{ role: 'user', content: 'Tell me about yourself' }], system: 'SYS', stream: true, ...extra } as any, 'sess-1', new AbortController().signal, deps);

async function deltas(r: Response) {
  const text = await r.text();
  const events = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  return { text: events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e).delta ?? '').join(''), done: events.at(-1) === '[DONE]', events };
}

describe('routes', () => {
  test('Claude first when its key is set; skipped without it', () => {
    assert.deepEqual(routeFor('fast', { gemini: true, claude: true }).map((r) => r.model), ['claude-haiku-5-5', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']);
    assert.deepEqual(routeFor('fast', { gemini: true, claude: false }).map((r) => r.model), ['gemini-3.1-flash-lite', 'gemini-3.8-flash']);
    assert.deepEqual(routeFor('long', { gemini: true, claude: true }).map((r) => r.model), ['claude-sonnet-5-5', 'gemini-3.8-flash']);
    assert.deepEqual(routeFor('long', { gemini: false, claude: false }), []);
  });
  test('MODEL_ROUTES overrides the order; bad and duplicate entries are dropped', () => {
    const r = routeFor('fast', { gemini: true, claude: true }, { fast: ['gemini:gemini-3.8-flash', 'nope', 'openai:gpt', 'gemini:gemini-3.8-flash', 'claude:claude-haiku-5-5'] });
    assert.deepEqual(r.map((x) => `${x.provider}:${x.model}`), ['gemini:gemini-3.8-flash', 'claude:claude-haiku-5-5']);
    assert.equal(parseRef('claude:Claude Haiku'), null);
    assert.equal(tierOf({ model_tier: 'long' }), 'long');
    assert.equal(tierOf({ model_tier: 'LONG' }), 'fast');
  });
});

describe('Claude request', () => {
  test('Haiku: thinking off, low effort, cached system, images first on the last user turn, starts with the user', () => {
    const p: any = toClaudeRequest({
      system: 'SYS',
      messages: [{ role: 'assistant', content: 'earlier' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'what is this?' }],
      images: [{ mime_type: 'image/png', data: 'AAAA' }],
    }, 'claude-haiku-5-5');
    assert.deepEqual(p.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(p.messages[2].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    assert.deepEqual(p.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(p.thinking, { type: 'disabled' });
    assert.deepEqual(p.output_config, { effort: 'low' });
    assert.equal(p.temperature, undefined);
    assert.equal(p.betas, undefined);
  });
  test('Sonnet: between_tools at medium effort, with the server-side refusal fallback', () => {
    const p: any = toClaudeRequest({ messages: [{ role: 'user', content: 'build it' }] }, 'claude-sonnet-5-5');
    assert.deepEqual(p.thinking, { type: 'between_tools' });
    assert.deepEqual(p.output_config, { effort: 'medium' });
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p.fallbacks, 'default');
    assert.equal(p.max_tokens, 64000);
  });
});

describe('answering', () => {
  test('Claude answers when its key is set; usage counts cached input', async () => {
    const { client, sent } = fakeClaude(claudeEvents(['I am ', 'a developer.']));
    const { deps, usage, fetched } = makeDeps({ claude: client });
    const r = await ask(deps);
    assert.equal(r.headers.get('x-preppilot-model'), 'claude-haiku-5-5');
    const d = await deltas(r);
    assert.equal(d.text, 'I am a developer.');
    assert.ok(d.done);
    assert.equal(sent[0].beta, false);
    assert.equal(fetched.length, 0, 'Gemini is not called');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].p_model, 'claude-haiku-5-5');
    assert.equal(usage[0].p_input, 1000);
    assert.equal(usage[0].p_output, 7);
    assert.ok(usage[0].p_cost > 0);
  });

  test('a long build goes to Sonnet through the beta (fallback) endpoint', async () => {
    const { client, sent } = fakeClaude(claudeEvents(['files']));
    const { deps } = makeDeps({ claude: client });
    await deltas(await ask(deps, { model_tier: 'long' }));
    assert.equal(sent[0].params.model, 'claude-sonnet-5-5');
    assert.equal(sent[0].beta, true);
  });

  test('without the Claude key, Gemini answers exactly as before', async () => {
    const { deps, fetched, usage } = makeDeps();
    const d = await deltas(await ask(deps));
    assert.equal(d.text, 'gem');
    assert.match(fetched[0], /gemini-3\.1-flash-lite/);
    assert.equal(usage[0].p_model, 'gemini-3.1-flash-lite');
  });

  test('a Claude error before any words falls over to Gemini, unseen', async () => {
    const { client } = fakeClaude(async function* () { throw Object.assign(new Error('overloaded'), { status: 529 }); });
    const { deps, usage, logs } = makeDeps({ claude: client });
    const d = await deltas(await ask(deps));
    assert.equal(d.text, 'gem');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].p_model, 'gemini-3.1-flash-lite');
    assert.equal(logs[0][1].status, 529);
  });

  test('a refusal before any words falls over to the next model', async () => {
    const { client } = fakeClaude(claudeEvents([], { stop: 'refusal' }));
    const { deps } = makeDeps({ claude: client });
    assert.equal((await deltas(await ask(deps))).text, 'gem');
  });

  test('Gemini refusing moves to the next Gemini model', async () => {
    const { deps, fetched } = makeDeps({ gemini: (url) => url.includes('flash-lite') ? new Response('{"error":"cap"}', { status: 429 }) : geminiSse(['flash']) });
    assert.equal((await deltas(await ask(deps))).text, 'flash');
    assert.equal(fetched.length, 2);
  });

  test('a model silent past the first-token limit is abandoned for the next', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = false;
    const { client } = fakeClaude(async function* (_p, signal) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { aborted = true; resolve(); }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { deps } = makeDeps({ claude: client });
    const pending = ask(deps);
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(FIRST_TOKEN_TIMEOUT_MS.fast + 1);
    t.mock.timers.reset();
    assert.equal((await deltas(await pending)).text, 'gem');
    assert.ok(aborted, 'the slow model is cancelled');
  });

  test('every model refusing: 502 without provider details; no keys at all: 503', async () => {
    const { deps } = makeDeps({ gemini: () => new Response('{"error":"Your project has exceeded its monthly spending cap"}', { status: 429 }) });
    const r = await ask(deps);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'upstream_unavailable' });
    const none = makeDeps({ geminiKey: '' });
    assert.equal((await ask(none.deps)).status, 503);
  });

  test('a break after the first words ends the answer with an error event, still billed', async () => {
    const { client } = fakeClaude(async function* () {
      yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Half ' } };
      throw Object.assign(new Error('connection reset'), { status: 0 });
    });
    const { deps, usage, fetched } = makeDeps({ claude: client });
    const d = await deltas(await ask(deps));
    assert.equal(d.text, 'Half ');
    assert.deepEqual(JSON.parse(d.events.at(-1)!), { error: 'upstream_stream_failed' });
    assert.equal(fetched.length, 0, 'no second model continues the sentence');
    assert.equal(usage[0].p_model, 'claude-haiku-5-5');
  });

  test('a whole (non-streamed) answer', async () => {
    const { client } = fakeClaude(claudeEvents(['O', 'K']));
    const { deps } = makeDeps({ claude: client });
    const r = await ask(deps, { stream: false });
    assert.deepEqual(await r.json(), { content: 'OK', model: 'claude-haiku-5-5' });
  });
});
