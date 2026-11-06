// /v1/chat: picks the models for the answer, tries them in order, and
// answers in the desktop app's hosted-provider format.
//
// A model gets until its first words (FIRST_TOKEN_TIMEOUT_MS) to start; an
// error or a silence before that moves to the next model, unseen by the
// candidate. Once words have been sent, the answer stays on that model: a
// second model cannot continue the first one's sentence.
import { json, type Deps } from './core.ts';
export type { ChatBody } from './models.ts';
import { costUsd, FIRST_TOKEN_TIMEOUT_MS, ProviderError, routeFor, tierOf, type ChatBody, type ModelEvent, type ModelRef } from './models.ts';
import { geminiStream } from './gemini.ts';
import { claudeStream } from './claude.ts';

/** Opens one model; throws before any text if it refuses. */
function open(ref: ModelRef, body: ChatBody, signal: AbortSignal, deps: Deps): Promise<AsyncIterable<ModelEvent>> {
  if (ref.provider === 'claude') {
    if (!deps.anthropic) throw new ProviderError('claude', ref.model, 0, 'no ANTHROPIC_API_KEY');
    return claudeStream(ref.model, body, signal, deps.anthropic);
  }
  return geminiStream(ref.model, body, signal, { fetch: deps.fetch, key: deps.env.geminiKey });
}

interface Started { ref: ModelRef; first: string; rest: AsyncIterator<ModelEvent>; firstUsage?: ModelEvent['usage']; controller: AbortController }

/** The first model in the route that starts answering in time, with its first words. */
async function start(route: ModelRef[], body: ChatBody, signal: AbortSignal, deps: Deps, timeoutMs: number): Promise<Started | null> {
  for (const ref of route) {
    if (signal.aborted) return null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const firstText = (async () => {
        const it = (await open(ref, body, controller.signal, deps))[Symbol.asyncIterator]();
        let usage: ModelEvent['usage'];
        while (true) {
          const { value, done } = await it.next();
          if (done) return { it, first: '', usage };
          if (value.usage) usage = value.usage;
          if (value.text) return { it, first: value.text, usage };
        }
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError(ref.provider, ref.model, 0, `no first token in ${timeoutMs} ms`)), timeoutMs);
      });
      const r = await Promise.race([firstText, timeout]);
      clearTimeout(timer);
      if (!r.first) throw new ProviderError(ref.provider, ref.model, 200, 'empty answer');
      return { ref, first: r.first, rest: r.it, firstUsage: r.usage, controller };
    } catch (e) {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return null;
      const err = e as ProviderError;
      // The provider's words stay in the server log: they can name the
      // account (billing, spending cap), which is the admin's business.
      deps.log?.('[api] model skipped', { provider: ref.provider, model: ref.model, status: err.status, detail: String(err.detail ?? err.message).slice(0, 300) });
    }
  }
  return null;
}

function record(deps: Deps, sessionId: string, model: string, usage: { input: number; output: number }) {
  return deps.rpc('pp_record_usage', {
    p_session: sessionId, p_kind: 'llm', p_model: model, p_input: usage.input, p_output: usage.output,
    p_audio_seconds: null, p_cost: costUsd(model, usage.input, usage.output, deps.env.prices ?? {}),
  }).catch((e) => deps.log?.('[api] usage not recorded', { error: String(e?.message ?? e) }));
}

export async function chat(body: ChatBody, sessionId: string, signal: AbortSignal, deps: Deps): Promise<Response> {
  const tier = tierOf(body);
  const route = routeFor(tier, { gemini: Boolean(deps.env.geminiKey), claude: Boolean(deps.anthropic) }, deps.env.routes);
  if (route.length === 0) return json(503, { error: 'upstream_unavailable' });
  const started = await start(route, body, signal, deps, FIRST_TOKEN_TIMEOUT_MS[tier]);
  if (!started) return json(502, { error: 'upstream_unavailable' });
  const { ref } = started;

  if (body.stream !== true) {
    let text = started.first;
    let usage = started.firstUsage ?? { input: 0, output: 0 };
    while (true) {
      const { value, done } = await started.rest.next();
      if (done) break;
      if (value.text) text += value.text;
      if (value.usage) usage = value.usage;
    }
    await record(deps, sessionId, ref.model, usage);
    return json(200, { content: text, model: ref.model });
  }

  const enc = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(enc.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`));
      let usage = started.firstUsage ?? { input: 0, output: 0 };
      try {
        send({ delta: started.first, model: ref.model });
        while (true) {
          const { value, done } = await started.rest.next();
          if (done) break;
          if (value.text) send({ delta: value.text, model: ref.model });
          if (value.usage) usage = value.usage;
        }
        send('[DONE]');
      } catch (e) {
        if (!signal.aborted) {
          deps.log?.('[api] stream broke after the first words', { model: ref.model, error: String((e as Error)?.message ?? e).slice(0, 300) });
          send({ error: 'upstream_stream_failed' });
        }
      } finally {
        // Record before closing: an Edge isolate may retire once the response ends.
        await record(deps, sessionId, ref.model, usage);
        try { controller.close(); } catch { /* client gone */ }
      }
    },
    cancel() { started.controller.abort(); },
  });
  return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-preppilot-model': ref.model } });
}
