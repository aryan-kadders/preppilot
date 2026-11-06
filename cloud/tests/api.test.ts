// The `api` function end to end: the real handler and the real database
// functions (a private Postgres, see helpers/db.mjs); only Google and
// Deepgram are faked. Node runs this TypeScript directly (type stripping).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startDb } from './helpers/db.mjs';
import { handle, normalizeInviteCode, compareVersions, routeOf, randomToken, type Deps } from '../supabase/functions/_shared/core.ts';
import { toGeminiRequest, pickModel, costUsd, FAST_MODEL, LONG_MODEL } from '../supabase/functions/_shared/gemini.ts';

const BASE = 'https://proj.supabase.co/functions/v1/api';
let db: any;
const ids: Record<string, string> = {};
const calls: Array<{ url: string; init: any }> = [];
let geminiReply: (url: string, body: any) => Response;

const sse = (events: unknown[]) => new Response(new ReadableStream({
  start(c) {
    const enc = new TextEncoder();
    for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\r\n\r\n`));
    c.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const deps = (): Deps => ({
  async rpc(fn, args) {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
    return db.asService(async (q: any) => (await q(sql, names.map((n) => args[n]))).rows[0]?.r ?? null);
  },
  async fetch(url: any, init: any) {
    calls.push({ url: String(url), init });
    if (String(url).includes('deepgram')) return new Response(JSON.stringify({ access_token: 'dg-temp', expires_in: 60 }), { status: 200 });
    return geminiReply(String(url), JSON.parse(init.body));
  },
  env: { geminiKey: 'g-key', deepgramKey: 'd-key', minAppVersion: '3.0.0' },
  randomToken,
  log: () => {},
});

const call = (route: string, opts: { method?: string; body?: unknown; token?: string; session?: string; version?: string; legacyKey?: boolean } = {}) =>
  handle(new Request(`${BASE}${route}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'x-preppilot-version': opts.version ?? '3.1.0',
      ...(opts.token ? (opts.legacyKey ? { 'x-natively-key': opts.token } : { authorization: `Bearer ${opts.token}` }) : {}),
      ...(opts.session ? { 'x-preppilot-session': opts.session } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }), deps());

before(async () => {
  db = await startDb();
  ids.admin = randomUUID();
  await db.admin.query(`insert into auth.users (id, email) values ($1, 'boss@example.com')`, [ids.admin]);
  ids.org = (await db.admin.query(`select public.pp_bootstrap_org('Kadders', 'boss@example.com') as id`)).rows[0].id;
  await db.asUser(ids.admin, async (q: any) => {
    ids.team = (await q(`insert into public.teams (org_id, name) values ($1, 'Backend') returning id`, [ids.org])).rows[0].id;
  });
});
after(async () => { await db?.stop(); });

// A candidate with minutes and a slot open now, signed in on a device.
async function signedIn(minutes = 30) {
  const { candidate, code } = await db.asUser(ids.admin, async (q: any) => {
    const c = (await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Asha') returning id`, [ids.org, ids.team])).rows[0].id;
    if (minutes) await q('select public.pp_grant_minutes($1, $2)', [c, minutes]);
    await q(`insert into public.slots (candidate_id, starts_at, ends_at) values ($1, now() - interval '5 minutes', now() + interval '1 hour')`, [c]);
    return { candidate: c, code: (await q('select public.pp_create_invite($1) as c', [c])).rows[0].c };
  });
  const r = await call('/v1/auth/redeem', { body: { code: code.toLowerCase().replace(/-/g, ' '), device_name: 'Asha Mac', platform: 'darwin', app_version: '3.1.0' } });
  assert.equal(r.status, 200);
  return { candidate, code, ...(await r.json()) };
}

describe('helpers', () => {
  test('invite codes are read loosely and written canonically', () => {
    assert.equal(normalizeInviteCode('a1b2 c3d4-e5f6 7890'), 'A1B2-C3D4-E5F6-7890');
    assert.equal(normalizeInviteCode('A1B2C3D4E5F67890'), 'A1B2-C3D4-E5F6-7890');
    assert.equal(normalizeInviteCode('too-short'), null);
  });
  test('versions compare by number', () => {
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('3.1', '3.1.0'), 0);
    assert.equal(compareVersions('2.9.9', '3.0.0'), -1);
  });
  test('routes are found after the function prefix', () => {
    assert.equal(routeOf(`${BASE}/v1/chat`), '/v1/chat');
    assert.equal(routeOf('http://localhost:54321/api/v1/session/start/'), '/v1/session/start');
  });
  test('Gemini request: system, roles, images on the last user turn, thinking per model', () => {
    const r: any = toGeminiRequest({
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'what is this?' }],
      images: [{ mime_type: 'image/png', data: 'AAAA' }, { mime_type: 'text/html', data: 'x' }],
    }, FAST_MODEL);
    assert.deepEqual(r.contents.map((c: any) => c.role), ['user', 'model', 'user']);
    assert.deepEqual(r.contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    assert.equal(r.contents[2].parts.length, 2, 'only image types are attached');
    assert.equal(r.systemInstruction.parts[0].text, 'be brief');
    assert.equal(r.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.equal((toGeminiRequest({ messages: [{ content: 'x' }] }, LONG_MODEL) as any).generationConfig.thinkingConfig.thinkingLevel, 'low');
  });
  test('long builds use Flash; everything else Flash-Lite; cost from the price table', () => {
    assert.equal(pickModel({ messages: [], model_tier: 'long' }), LONG_MODEL);
    assert.equal(pickModel({ messages: [], fast_mode: true } as any), FAST_MODEL);
    assert.equal(costUsd(FAST_MODEL, 1_000_000, 1_000_000, { [FAST_MODEL]: [0.1, 0.4] }), 0.5);
  });
});

describe('signing in', () => {
  test('an invite code becomes tokens once; the same code again is refused', async () => {
    const s = await signedIn();
    assert.ok(s.access_token.length >= 40 && s.refresh_token.length >= 40);
    const again = await call('/v1/auth/redeem', { body: { code: s.code, platform: 'win32' } });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, 'code_used');
  });

  test('no token, a wrong token, an old app: refused before anything else', async () => {
    assert.equal((await call('/v1/me', { method: 'GET' })).status, 401);
    assert.equal((await call('/v1/me', { method: 'GET', token: 'nope' })).status, 401);
    const old = await call('/v1/me', { method: 'GET', token: 'x', version: '2.9.0' });
    assert.equal(old.status, 426);
    assert.equal((await old.json()).error, 'app_update_required');
  });

  test('refresh rotates the tokens; the old access token stops working', async () => {
    const s = await signedIn();
    const r = await call('/v1/auth/refresh', { body: { refresh_token: s.refresh_token } });
    assert.equal(r.status, 200);
    const t = await r.json();
    assert.equal((await call('/v1/me', { method: 'GET', token: s.access_token })).status, 401);
    assert.equal((await call('/v1/me', { method: 'GET', token: t.access_token })).status, 200);
    const reuse = await call('/v1/auth/refresh', { body: { refresh_token: s.refresh_token } });
    assert.equal(reuse.status, 403, 'a copied refresh token shuts the device out');
    assert.equal((await call('/v1/me', { method: 'GET', token: t.access_token })).status, 403);
  });

  test('the app\'s existing x-natively-key header works as the access token', async () => {
    const s = await signedIn();
    const me = await call('/v1/me', { method: 'GET', token: s.access_token, legacyKey: true });
    assert.equal(me.status, 200);
    const status = await me.json();
    assert.equal(status.balance_seconds, 1800);
    assert.ok(status.current_slot);
  });
});

describe('a session', () => {
  test('start, answer (streamed), answer (whole), heartbeat, end', async () => {
    const s = await signedIn(30);
    const start = await call('/v1/session/start', { token: s.access_token, body: {} });
    assert.equal(start.status, 200);
    const session = await start.json();
    assert.equal(session.status, 'open');

    geminiReply = (url) => url.includes('stream')
      ? sse([{ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'React is ' }] } }] },
             { candidates: [{ content: { parts: [{ text: 'a UI library.' }] } }], usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 40, thoughtsTokenCount: 10 } }])
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }), { status: 200 });

    const streamed = await call('/v1/chat', { token: s.access_token, session: session.session_id,
      body: { messages: [{ role: 'user', content: 'What is React?' }], system: 'be brief', stream: true } });
    assert.equal(streamed.status, 200);
    const text = await streamed.text();
    const deltas = text.split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)).delta);
    assert.equal(deltas.join(''), 'React is a UI library.', 'thought parts are never sent');
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));
    const sent = calls.at(-1)!;
    assert.match(sent.url, /gemini-3\.1-flash-lite:streamGenerateContent\?alt=sse$/);
    assert.equal(sent.init.headers['x-goog-api-key'], 'g-key');

    const whole = await call('/v1/chat', { token: s.access_token, session: session.session_id,
      body: { messages: [{ role: 'user', content: 'Say OK' }] } });
    assert.deepEqual(await whole.json(), { content: 'OK', model: FAST_MODEL });

    const usage = (await db.admin.query('select model, input_tokens, output_tokens from public.usage_events where session_id = $1 order by created_at', [session.session_id])).rows;
    assert.deepEqual(usage.map((u: any) => [u.input_tokens, u.output_tokens]), [[6000, 50], [10, 1]]);

    const hb = await call('/v1/session/heartbeat', { token: s.access_token, body: { session_id: session.session_id, seq: 1 } });
    assert.equal((await hb.json()).status, 'open');
    const end = await call('/v1/session/end', { token: s.access_token, body: { session_id: session.session_id, seq: 2 } });
    assert.equal((await end.json()).end_reason, 'user');

    const after = await call('/v1/chat', { token: s.access_token, session: session.session_id,
      body: { messages: [{ role: 'user', content: 'again' }] } });
    assert.equal(after.status, 429);
    assert.deepEqual(await after.json(), { error: 'time_quota_exceeded', reason: 'session_ended', end_reason: 'user' });
  });

  test('no minutes: the session is refused as a time limit the app already understands', async () => {
    const s = await signedIn(0);
    const r = await call('/v1/session/start', { token: s.access_token, body: {} });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'time_quota_exceeded', reason: 'no_minutes' });
  });

  test('AI and transcription need a session; transcription gets a 60-second Deepgram key', async () => {
    const s = await signedIn();
    assert.equal((await call('/v1/stt/token', { token: s.access_token })).status, 400);
    const session = await (await call('/v1/session/start', { token: s.access_token, body: {} })).json();
    const r = await call('/v1/stt/token', { token: s.access_token, session: session.session_id });
    assert.deepEqual(await r.json(), { access_token: 'dg-temp', expires_in: 60 });
    const grant = calls.at(-1)!;
    assert.equal(grant.init.headers.authorization, 'Token d-key');
    assert.deepEqual(JSON.parse(grant.init.body), { ttl_seconds: 60 });
  });

  test('a provider refusal is reported without the provider\'s account details', async () => {
    const s = await signedIn();
    const session = await (await call('/v1/session/start', { token: s.access_token, body: {} })).json();
    geminiReply = () => new Response('{"error":{"message":"Your project has exceeded its monthly spending cap"}}', { status: 429 });
    const r = await call('/v1/chat', { token: s.access_token, session: session.session_id, body: { messages: [{ content: 'hi' }], stream: true } });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error, 'upstream_unavailable');
    assert.ok(!JSON.stringify(body).includes('spending'));
  });

  test('a long build goes to Gemini Flash', async () => {
    const s = await signedIn();
    const session = await (await call('/v1/session/start', { token: s.access_token, body: {} })).json();
    geminiReply = () => sse([{ candidates: [{ content: { parts: [{ text: 'files…' }] } }] }]);
    await (await call('/v1/chat', { token: s.access_token, session: session.session_id,
      body: { messages: [{ content: 'long code for an ecommerce site' }], stream: true, model_tier: 'long' } })).text();
    assert.match(calls.at(-1)!.url, /gemini-3\.8-flash:streamGenerateContent/);
  });

  test('another device\'s session cannot be used', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const session = await (await call('/v1/session/start', { token: a.access_token, body: {} })).json();
    const r = await call('/v1/chat', { token: b.access_token, session: session.session_id, body: { messages: [{ content: 'hi' }] } });
    assert.equal(r.status, 409);
  });
});
