// PrepPilot Cloud client (electron/services/cloud/cloudClient.ts) against a
// fake server that follows cloud/supabase/functions/_shared/core.ts: invite
// redemption, rotating refresh tokens, sessions with heartbeats, the
// five-minute warning, time up and revocation. Platform-independent; both
// the macOS and Windows identities are exercised.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { CloudClient, CloudError, normalizeInviteCode, timeReasonMessage, HEARTBEAT_MS } =
  require(path.resolve(__dirname, '../../../dist-electron/electron/services/cloud/cloudClient.js'));

const BASE = 'https://proj.supabase.co/functions/v1/api';
const CODE = 'A1B2-C3D4-E5F6-7890';

function fakeServer() {
  let n = 0;
  const tok = (k) => `${k}-${++n}`;
  const s = {
    clock: 1_000_000,
    secondsLeft: 600,
    access: new Set(), refresh: new Map(), // refresh token -> used?
    revoked: false, redeemed: false, sessionOpen: false, seq: 0,
    calls: [],
    endNext: null,
  };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pair = () => {
    const a = tok('acc'), r = tok('ref');
    s.access.add(a); s.refresh.set(r, false);
    return { access_token: a, refresh_token: r, device_id: 'dev-1', access_expires_at: new Date(s.clock + 15 * 60_000).toISOString() };
  };
  const view = (status = 'open', reason = null) => ({ session_id: 'ses-1', status, end_reason: reason, allowed_until: new Date(s.clock + s.secondsLeft * 1000).toISOString(), seconds_left: s.secondsLeft, balance_seconds: s.secondsLeft, last_seq: s.seq });
  s.fetch = async (url, init = {}) => {
    const route = String(url).slice(BASE.length);
    const headers = init.headers ?? {};
    const body = init.body ? JSON.parse(init.body) : {};
    s.calls.push({ route, headers, body });
    assert.equal(headers['x-preppilot-version'], '3.1.0', 'every call names the app version');
    if (route === '/v1/auth/redeem') {
      if (s.redeemed) return reply(400, { error: 'code_used' });
      if (body.code !== CODE) return reply(400, { error: 'invalid_code' });
      s.redeemed = true;
      return reply(200, pair());
    }
    if (route === '/v1/auth/refresh') {
      if (s.revoked) return reply(403, { error: 'device_revoked' });
      if (!s.refresh.has(body.refresh_token)) return reply(401, { error: 'invalid_token' });
      if (s.refresh.get(body.refresh_token)) { s.revoked = true; return reply(403, { error: 'device_revoked' }); }
      s.refresh.set(body.refresh_token, true);
      s.access.clear();
      return reply(200, pair());
    }
    const token = headers.authorization?.replace(/^Bearer /, '');
    if (s.revoked) return reply(403, { error: 'device_revoked' });
    if (!s.access.has(token)) return reply(401, { error: 'invalid_token' });
    if (route === '/v1/me') return reply(200, { candidate: { id: 'c1', name: 'Asha' }, balance_seconds: s.secondsLeft, current_slot: null, next_slot: null, assignments: [] });
    if (route === '/v1/session/start') {
      if (s.secondsLeft <= 0) return reply(429, { error: 'time_quota_exceeded', reason: 'no_minutes' });
      s.sessionOpen = true; s.seq = 0;
      return reply(200, view());
    }
    if (route === '/v1/session/heartbeat' || route === '/v1/session/end') {
      if (body.seq <= s.seq) return reply(200, view());
      s.seq = body.seq;
      if (route === '/v1/session/end') { s.sessionOpen = false; return reply(200, view('ended', 'user')); }
      if (s.endNext) { s.sessionOpen = false; return reply(200, view('ended', s.endNext)); }
      return reply(200, view());
    }
    if (route === '/v1/stt/token') {
      if (headers['x-preppilot-session'] !== 'ses-1') return reply(400, { error: 'session_required' });
      return reply(200, { access_token: 'dg-temp', expires_in: 60 });
    }
    return reply(404, { error: 'not_found' });
  };
  return s;
}

function memoryStore(initial = null) {
  const st = { value: initial, saves: 0 };
  st.load = () => st.value;
  st.save = (v) => { st.value = { ...v }; st.saves += 1; };
  st.clear = () => { st.value = null; };
  return st;
}

function client(server, store = memoryStore(), platform = 'darwin') {
  const timers = [];
  const c = new CloudClient(BASE, {
    fetch: server.fetch, store, appVersion: '3.1.0', platform, deviceName: 'Asha MacBook',
    now: () => server.clock,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (h) => { timers[h - 1] = null; },
  });
  const events = [];
  c.on((e) => events.push(e));
  return { c, store, timers, events };
}

describe('signing in', () => {
  test('invite codes are read loosely', () => {
    assert.equal(normalizeInviteCode('a1b2 c3d4 e5f6 7890'), CODE);
    assert.equal(normalizeInviteCode('nope'), null);
  });

  for (const platform of ['darwin', 'win32']) {
    test(`an invite signs this computer in and saves only the refresh token (${platform})`, async () => {
      const server = fakeServer();
      const { c, store, events } = client(server, memoryStore(), platform);
      assert.equal(c.state, 'signed_out');
      await c.redeem('a1b2-c3d4-e5f6-7890');
      assert.equal(c.state, 'signed_in');
      assert.deepEqual(Object.keys(store.value).sort(), ['baseUrl', 'deviceId', 'refreshToken']);
      assert.equal(server.calls[0].body.platform, platform);
      assert.equal(server.calls[0].body.device_name, 'Asha MacBook');
      assert.deepEqual(events, [{ type: 'state', state: 'signed_in' }]);
    });
  }

  test('a wrong or used code is refused with the server\'s reason', async () => {
    const server = fakeServer();
    const { c } = client(server);
    await assert.rejects(c.redeem('FFFF-FFFF-FFFF-FFFF'), (e) => e instanceof CloudError && e.code === 'invalid_code');
    await assert.rejects(c.redeem('too short'), (e) => e.code === 'invalid_code');
    assert.equal(server.calls.length, 1, 'a code that cannot be valid is never sent');
  });

  test('after a restart the saved refresh token signs back in; the new one is saved before use', async () => {
    const server = fakeServer();
    const first = client(server);
    await first.c.redeem(CODE);
    const again = client(server, first.store);
    assert.equal(again.c.state, 'signed_in');
    const savesBefore = first.store.saves;
    const me = await again.c.status();
    assert.equal(me.candidate.name, 'Asha');
    assert.equal(first.store.saves, savesBefore + 1, 'the rotated refresh token was saved');
  });

  test('credentials saved for another server are ignored', () => {
    const { c } = client(fakeServer(), memoryStore({ refreshToken: 'x', deviceId: 'd', baseUrl: 'https://elsewhere' }));
    assert.equal(c.state, 'signed_out');
  });

  test('an expired access token is refreshed once for concurrent calls', async () => {
    const server = fakeServer();
    const { c } = client(server);
    await c.redeem(CODE);
    server.clock += 16 * 60_000;
    await Promise.all([c.status(), c.status(), c.status()]);
    assert.equal(server.calls.filter((x) => x.route === '/v1/auth/refresh').length, 1);
  });

  test('a revoked device signs out and says so', async () => {
    const server = fakeServer();
    const { c, store, events } = client(server);
    await c.redeem(CODE);
    server.revoked = true;
    await assert.rejects(c.status(), (e) => e.code === 'device_revoked');
    assert.equal(c.state, 'revoked');
    assert.equal(store.value, null);
    assert.deepEqual(events.at(-1), { type: 'state', state: 'revoked' });
    assert.match(timeReasonMessage('device_revoked'), /signed out by your manager/);
  });
});

describe('sessions', () => {
  test('start, check in every 30 seconds, warn once at five minutes, end', async () => {
    const server = fakeServer();
    const { c, timers, events } = client(server);
    await c.redeem(CODE);
    const v = await c.startSession();
    assert.equal(v.session_id, 'ses-1');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, HEARTBEAT_MS);
    server.secondsLeft = 290;
    await c.heartbeat();
    server.secondsLeft = 250;
    await c.heartbeat();
    assert.equal(events.filter((e) => e.type === 'warning').length, 1);
    assert.deepEqual(server.calls.filter((x) => x.route === '/v1/session/heartbeat').map((x) => x.body.seq), [1, 2]);
    await c.endSession();
    assert.equal(server.calls.at(-1).route, '/v1/session/end');
    assert.equal(server.calls.at(-1).body.seq, 3);
    assert.equal(timers[0], null, 'the check-in timer is stopped');
    assert.equal(c.sessionId, null);
  });

  test('the server ending the session (time up) is reported and stops the timer', async () => {
    const server = fakeServer();
    const { c, timers, events } = client(server);
    await c.redeem(CODE);
    await c.startSession();
    server.endNext = 'time_up';
    await c.heartbeat();
    assert.deepEqual(events.at(-1), { type: 'ended', reason: 'time_up' });
    assert.equal(timers[0], null);
    assert.equal(c.sessionId, null);
  });

  test('no minutes: the start is refused with a reason the user can read', async () => {
    const server = fakeServer();
    server.secondsLeft = 0;
    const { c } = client(server);
    await c.redeem(CODE);
    await assert.rejects(c.startSession(), (e) => e.status === 429 && e.reason === 'no_minutes');
    assert.match(timeReasonMessage('no_minutes'), /no practice minutes left/);
  });

  test('the Deepgram key and the chat headers need an open session', async () => {
    const server = fakeServer();
    const { c } = client(server);
    await c.redeem(CODE);
    await assert.rejects(c.sttToken(), (e) => e.code === 'session_required');
    await assert.rejects(c.chatHeaders(), (e) => e.status === 429);
    await c.startSession();
    assert.equal(await c.sttToken(), 'dg-temp');
    const h = await c.chatHeaders();
    assert.equal(h['x-preppilot-session'], 'ses-1');
    assert.ok(h['x-natively-key'].startsWith('acc-'));
    assert.equal(c.chatUrl, `${BASE}/v1/chat`);
  });

  test('signing out ends the session and forgets the credentials', async () => {
    const server = fakeServer();
    const { c, store } = client(server);
    await c.redeem(CODE);
    await c.startSession();
    await c.signOut();
    assert.equal(server.calls.at(-1).route, '/v1/session/end');
    assert.equal(store.value, null);
    assert.equal(c.state, 'signed_out');
  });
});
