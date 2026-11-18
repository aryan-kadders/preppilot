// The `api` function end to end: the real handler and the real database
// functions (a private Postgres, see helpers/db.mjs); only Google and
// Deepgram are faked. Node runs this TypeScript directly (type stripping).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startDb } from './helpers/db.mjs';
import { handle, normalizeInviteCode, compareVersions, routeOf, randomToken, type Deps } from '../supabase/functions/_shared/core.ts';
import { toGeminiRequest } from '../supabase/functions/_shared/gemini.ts';
import { costUsd } from '../supabase/functions/_shared/models.ts';

const FAST_MODEL = 'gemini-3.1-flash-lite';
const LONG_MODEL = 'gemini-3.8-flash';

const BASE = 'https://proj.supabase.co/functions/v1/api';
let db: any;
const ids: Record<string, string> = {};
const calls: Array<{ url: string; init: any }> = [];
let geminiReply: (url: string, body: any) => Response;
const jwts = new Map<string, string>();

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
  staff: {
    async userIdFromJwt(jwt: string) { return jwts.get(jwt) ?? null; },
    async signInLink(email: string) {
      const found = await db.admin.query('select id from auth.users where email = $1', [email]);
      const id = found.rows[0]?.id ?? randomUUID();
      if (!found.rows.length) await db.admin.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return { userId: id, link: `https://proj.supabase.co/auth/v1/verify?token=t-${id.slice(0, 8)}` };
    },
  },
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
  test('cost from the price table, a secret overriding the defaults', () => {
    assert.equal(costUsd(FAST_MODEL, 1_000_000, 1_000_000, { [FAST_MODEL]: [0.2, 0.8] }), 1);
    assert.equal(costUsd('claude-haiku-5-5', 1_000_000, 1_000_000, {}), 0.6);
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

    geminiReply = (_url, body) => body.contents.at(-1).parts[0].text === 'Say OK'
      ? sse([{ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }])
      : sse([{ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'React is ' }] } }] },
             { candidates: [{ content: { parts: [{ text: 'a UI library.' }] } }], usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 40, thoughtsTokenCount: 10 } }]);

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

  test('outside a session: notes and mock interview calls work, cost the candidate no minutes, and are capped at 60 an hour', async () => {
    const s = await signedIn(0);
    geminiReply = () => sse([{ candidates: [{ content: { parts: [{ text: 'Notes.' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } }]);
    const r = await call('/v1/chat', { token: s.access_token, body: { messages: [{ role: 'user', content: 'Summarise the meeting' }] } });
    assert.equal(r.status, 200, 'no minutes and no session, still answered');
    assert.equal((await r.json()).content, 'Notes.');
    const used = (await db.admin.query('select session_id, input_tokens from public.usage_events where candidate_id = $1', [s.candidate])).rows;
    assert.deepEqual(used.map((u: any) => [u.session_id, u.input_tokens]), [[null, 100]], 'cost recorded for the candidate');
    const ledger = (await db.admin.query(`select count(*)::int as n from public.time_ledger where candidate_id = $1 and reason = 'usage'`, [s.candidate])).rows[0].n;
    assert.equal(ledger, 0, 'no practice minutes used');

    await db.admin.query(`insert into public.usage_events (candidate_id, kind, model, input_tokens, output_tokens)
      select $1, 'llm', 'x', 1, 1 from generate_series(1, 59)`, [s.candidate]);
    const capped = await call('/v1/chat', { token: s.access_token, body: { messages: [{ role: 'user', content: 'again' }] } });
    assert.equal(capped.status, 429);
    assert.deepEqual(await capped.json(), { error: 'time_quota_exceeded', reason: 'offsession_limit' });
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

  test('a premium organization\'s live answers use the premium list (Gemini 3.8 Flash when Claude has no key)', async () => {
    await db.asUser(ids.admin, (q: any) => q(`select public.pp_set_ai_quality('premium')`));
    try {
      const s = await signedIn();
      const session = await (await call('/v1/session/start', { token: s.access_token, body: {} })).json();
      geminiReply = () => sse([{ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }]);
      await (await call('/v1/chat', { token: s.access_token, session: session.session_id,
        body: { messages: [{ content: 'tell me about a conflict' }], stream: true } })).text();
      assert.match(calls.at(-1)!.url, /gemini-3\.8-flash:streamGenerateContent/);
    } finally {
      await db.asUser(ids.admin, (q: any) => q(`select public.pp_set_ai_quality('standard')`));
    }
  });

  test('another device\'s session cannot be used', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const session = await (await call('/v1/session/start', { token: a.access_token, body: {} })).json();
    const r = await call('/v1/chat', { token: b.access_token, session: session.session_id, body: { messages: [{ content: 'hi' }] } });
    assert.equal(r.status, 409);
  });
});

describe('dashboard: inviting staff', () => {
  const invite = (jwt: string | null, body: unknown, method = 'POST') => handle(new Request(`${BASE}/v1/staff/invite`, {
    method,
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), deps());

  test('the browser preflight is answered, with CORS on every reply', async () => {
    const pre = await invite(null, null, 'OPTIONS');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
    const r = await invite(null, {});
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  test('an admin invites a manager into a team and gets a one-time sign-in link', async () => {
    jwts.set('admin-jwt', ids.admin);
    const r = await invite('admin-jwt', { email: 'New.Manager@Example.com', role: 'manager', team_ids: [ids.team], display_name: 'Priya' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.link, /^https:\/\/proj\.supabase\.co\/auth\/v1\/verify/);
    const staff = (await db.admin.query('select s.role, s.display_name, (select count(*) from public.staff_teams st where st.user_id = s.user_id)::int as teams from public.staff s join auth.users u on u.id = s.user_id where u.email = $1', ['new.manager@example.com'])).rows[0];
    assert.deepEqual(staff, { role: 'manager', display_name: 'Priya', teams: 1 });
  });

  test('a manager cannot invite, and nothing is created', async () => {
    const managerId = (await db.admin.query(`select u.id from auth.users u where u.email = 'new.manager@example.com'`)).rows[0].id;
    jwts.set('manager-jwt', managerId);
    const before = (await db.admin.query('select count(*)::int as n from auth.users')).rows[0].n;
    const r = await invite('manager-jwt', { email: 'sneaky@example.com', role: 'admin', team_ids: [] });
    assert.equal(r.status, 403);
    assert.equal((await db.admin.query('select count(*)::int as n from auth.users')).rows[0].n, before);
  });

  test('an owner working in an organization invites a recruiter into it', async () => {
    const ownerId = randomUUID();
    await db.admin.query(`insert into auth.users (id, email) values ($1, 'owner@preppilot.dev')`, [ownerId]);
    await db.admin.query(`select public.pp_bootstrap_owner('owner@preppilot.dev')`);
    jwts.set('owner-jwt', ownerId);
    assert.equal((await invite('owner-jwt', { email: 'r@example.com', role: 'recruiter', team_ids: [] })).status, 403, 'not until they pick an organization');
    await db.asUser(ownerId, (q: any) => q('select public.pp_owner_use_org($1)', [ids.org]));
    const r = await invite('owner-jwt', { email: 'Recruiter@Example.com', role: 'recruiter', team_ids: [ids.team], display_name: 'Neha' });
    assert.equal(r.status, 200);
    const staff = (await db.admin.query('select s.role, s.org_id from public.staff s join auth.users u on u.id = s.user_id where u.email = $1', ['recruiter@example.com'])).rows[0];
    assert.deepEqual(staff, { role: 'recruiter', org_id: ids.org });
  });

  test('bad input is refused before anything happens', async () => {
    jwts.set('admin-jwt', ids.admin);
    assert.equal((await (await invite('admin-jwt', { email: 'nope', role: 'manager' })).json()).error, 'bad_email');
    assert.equal((await (await invite('admin-jwt', { email: 'a@b.co', role: 'owner' })).json()).error, 'bad_role');
    assert.equal((await (await invite('admin-jwt', { email: 'a@b.co', role: 'coach', team_ids: ['x'] })).json()).error, 'bad_team');
  });
});

describe('session records (what admins see after a session)', () => {
  const meeting = (localId: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
    kind: 'meeting', local_id: localId, title: 'Backend round', started_at: startedAt, duration_seconds: 1800.4,
    content: {
      transcript: [
        { speaker: 'interviewer', text: 'Tell me about yourself.', t: 1000 },
        { speaker: 'user', text: 'I build backends.', t: 4000 },
        { speaker: 'user', text: '   ', t: 5000 },
      ],
      answers: [{ type: 'assist', t: 1500, question: 'Tell me about yourself.', answer: 'Start with your current role…', images: ['data:image/jpeg;base64,AAA'] }],
      summary: { overview: 'Went well.', keyPoints: ['Clear intro'], actionItems: [], secretInternal: { x: 1 } },
      ...extra,
    },
  });

  test('a meeting is uploaded, cleaned, linked to its session, and replaced when sent again', async () => {
    const s = await signedIn(30);
    const session = await (await call('/v1/session/start', { token: s.access_token, body: {} })).json();
    const startedAt = new Date().toISOString();

    const r = await call('/v1/session/record', { token: s.access_token, body: meeting('m-1', startedAt) });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const row = (await db.admin.query('select * from public.session_records where id = $1', [id])).rows[0];
    assert.equal(row.session_id, session.session_id, 'linked to the session that started at the same time');
    assert.equal(row.candidate_id, s.candidate);
    assert.equal(row.line_count, 2, 'blank lines are dropped');
    assert.equal(row.answer_count, 1);
    assert.equal(row.duration_seconds, 1800);
    assert.equal(row.content.answers[0].images, undefined, 'screenshots are never stored');
    assert.equal(row.content.summary.secretInternal, undefined, 'only the readable summary fields');
    assert.ok(new Date(row.expires_at).getTime() - Date.now() > 89 * 86400_000, 'kept 90 days');

    const again = await call('/v1/session/record', { token: s.access_token, body: { ...meeting('m-1', startedAt), title: 'Backend round (notes redone)' } });
    assert.equal((await again.json()).id, id, 'same record, not a second one');
    const n = (await db.admin.query('select count(*)::int as n, max(title) as t from public.session_records where candidate_id = $1', [s.candidate])).rows[0];
    assert.deepEqual([n.n, n.t], [1, 'Backend round (notes redone)']);
  });

  test('a mock interview keeps its questions, feedback and average score', async () => {
    const s = await signedIn(30);
    const r = await call('/v1/session/record', { token: s.access_token, body: {
      kind: 'practice', local_id: 'p-1', title: 'Mock: Backend engineer', started_at: new Date().toISOString(),
      content: {
        config: { role: 'Backend engineer', level: 'mid', kind: 'mixed' },
        questions: [{ id: 'q1', text: 'Why us?', kind: 'behavioral', focus: 'motivation' }],
        answers: [{ questionId: 'q1', answer: 'Because…', feedback: { score: 7, verdict: 'Good', strengths: ['clear'], improvements: ['numbers'], betterAnswer: 'I…' }, delivery: { wpm: 140, pace: 'good', fillerCount: 2, length: 'good' } }],
        report: { averageScore: 7, answered: 1, total: 1, focusAreas: ['numbers'], delivery: { averageWpm: 140, totalFillers: 2 } },
      },
    } });
    assert.equal(r.status, 200);
    const row = (await db.admin.query('select score, line_count, answer_count, session_id from public.session_records where id = $1', [(await r.json()).id])).rows[0];
    assert.deepEqual([Number(row.score), row.line_count, row.answer_count, row.session_id], [7, 1, 1, null]);
  });

  test('bad or huge uploads are refused, and a signed-out device cannot upload', async () => {
    const s = await signedIn(30);
    const now = new Date().toISOString();
    for (const [body, code] of [
      [{ ...meeting('x', now), kind: 'video' }, 'bad_kind'],
      [{ ...meeting('', now) }, 'bad_local_id'],
      [{ ...meeting('x', 'not a date') }, 'bad_started_at'],
      [{ ...meeting('x', now), content: [] }, 'bad_content'],
    ] as const) {
      const r = await call('/v1/session/record', { token: s.access_token, body });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, code);
    }
    const big = { ...meeting('big', now) };
    big.content = { transcript: Array.from({ length: 200 }, (_, i) => ({ speaker: 'user', text: 'x'.repeat(19_000), t: i })) } as any;
    const tooBig = await call('/v1/session/record', { token: s.access_token, body: big });
    assert.equal(tooBig.status, 413);
    assert.equal((await call('/v1/session/record', { body: meeting('y', now) })).status, 401);
  });

  test('staff see the list; opening is audited; coaches cannot delete; expired records vanish', async () => {
    const s = await signedIn(30);
    const { id } = await (await call('/v1/session/record', { token: s.access_token, body: meeting('m-audit', new Date().toISOString()) })).json();

    const list = await db.asUser(ids.admin, async (q: any) =>
      (await q('select id, title, line_count from public.session_records where candidate_id = $1', [s.candidate])).rows);
    assert.deepEqual(list.map((r: any) => r.id), [id]);
    await assert.rejects(db.asUser(ids.admin, (q: any) => q('select content from public.session_records where id = $1', [id])), /permission denied/,
      'the content is never read directly');

    const opened = await db.asUser(ids.admin, async (q: any) => (await q('select public.pp_open_session_record($1) as r', [id])).rows[0].r);
    assert.equal(opened.candidate_name, 'Asha');
    assert.equal(opened.content.transcript.length, 2);
    assert.equal(opened.can_delete, true);
    const audit = (await db.admin.query(`select count(*)::int as n from public.audit_log where action = 'session_record.view' and target_id = $1`, [id])).rows[0].n;
    assert.equal(audit, 1);

    const outsider = randomUUID();
    await db.admin.query(`insert into auth.users (id, email) values ($1, $2)`, [outsider, `out-${outsider.slice(0, 6)}@example.com`]);
    await assert.rejects(db.asUser(outsider, (q: any) => q('select public.pp_open_session_record($1)', [id])), /not found/);

    await db.admin.query(`update public.session_records set expires_at = now() - interval '1 second' where id = $1`, [id]);
    const hidden = await db.asUser(ids.admin, async (q: any) => (await q('select id from public.session_records where id = $1', [id])).rows);
    assert.deepEqual(hidden, [], 'past 90 days: hidden at once');
    await call('/v1/session/record', { token: s.access_token, body: meeting('m-next', new Date().toISOString()) });
    assert.equal((await db.admin.query('select count(*)::int as n from public.session_records where id = $1', [id])).rows[0].n, 0, 'and deleted on the next upload');

    const { id: id2 } = await (await call('/v1/session/record', { token: s.access_token, body: meeting('m-del', new Date().toISOString()) })).json();
    await db.asUser(ids.admin, (q: any) => q('select public.pp_delete_session_record($1)', [id2]));
    assert.equal((await db.admin.query('select count(*)::int as n from public.session_records where id = $1', [id2])).rows[0].n, 0);
  });
});
