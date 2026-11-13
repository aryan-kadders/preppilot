// PrepPilot Cloud database: access rules per role, invites and device
// tokens, and the minutes/slot/session rules. Runs against a private
// Postgres (see helpers/db.mjs).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startDb } from './helpers/db.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const T0 = new Date('2026-11-10T10:00:00Z');
const at = (sec) => new Date(T0.getTime() + sec * 1000).toISOString();

let db;
const ids = {};
const user = (name) => ids[name];

before(async () => {
  db = await startDb();
  const a = db.admin;
  for (const name of ['admin', 'manager1', 'manager2', 'coach1', 'outsider']) {
    ids[name] = randomUUID();
    await a.query('insert into auth.users (id, email) values ($1, $2)', [ids[name], `${name}@example.com`]);
  }
  ids.org = (await a.query(`select public.pp_bootstrap_org('Kadders', 'admin@example.com') as id`)).rows[0].id;
  ids.otherOrg = (await a.query(`select public.pp_bootstrap_org('Elsewhere', 'outsider@example.com') as id`)).rows[0].id;

  await db.asUser(user('admin'), async (q) => {
    ids.team1 = (await q(`insert into public.teams (org_id, name) values ($1, 'Backend') returning id`, [ids.org])).rows[0].id;
    ids.team2 = (await q(`insert into public.teams (org_id, name) values ($1, 'Frontend') returning id`, [ids.org])).rows[0].id;
    await q(`insert into public.staff (user_id, org_id, role) values ($1, $4, 'manager'), ($2, $4, 'manager'), ($3, $4, 'coach')`,
      [user('manager1'), user('manager2'), user('coach1'), ids.org]);
    await q(`insert into public.staff_teams (team_id, user_id) values ($1, $2), ($3, $4), ($1, $5)`,
      [ids.team1, user('manager1'), ids.team2, user('manager2'), user('coach1')]);
  });
  ids.cand1 = await db.asUser(user('manager1'), async (q) =>
    (await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Asha') returning id`, [ids.org, ids.team1])).rows[0].id);
  ids.cand2 = await db.asUser(user('manager2'), async (q) =>
    (await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Ravi') returning id`, [ids.org, ids.team2])).rows[0].id);
});
after(async () => { await db?.stop(); });

const visibleCandidates = (who) => db.asUser(user(who), async (q) =>
  (await q('select name from public.candidates order by name')).rows.map((r) => r.name));
const rejects = (p, re) => assert.rejects(p, re);

describe('who sees what', () => {
  test('an admin sees the whole organization; a manager and coach only their team; others nothing', async () => {
    assert.deepEqual(await visibleCandidates('admin'), ['Asha', 'Ravi']);
    assert.deepEqual(await visibleCandidates('manager1'), ['Asha']);
    assert.deepEqual(await visibleCandidates('manager2'), ['Ravi']);
    assert.deepEqual(await visibleCandidates('coach1'), ['Asha']);
    assert.deepEqual(await visibleCandidates('outsider'), []);
  });

  test('a manager cannot add a candidate to another team', async () => {
    await rejects(db.asUser(user('manager1'), (q) =>
      q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'X')`, [ids.org, ids.team2])), /row-level security/);
  });

  test('a coach cannot give minutes, invite or revoke; a manager can, for their own team only', async () => {
    await rejects(db.asUser(user('coach1'), (q) => q('select public.pp_grant_minutes($1, 30)', [ids.cand1])), /forbidden/);
    await rejects(db.asUser(user('coach1'), (q) => q('select public.pp_create_invite($1)', [ids.cand1])), /forbidden/);
    await rejects(db.asUser(user('manager1'), (q) => q('select public.pp_grant_minutes($1, 30)', [ids.cand2])), /forbidden/);
    const minutes = await db.asUser(user('manager1'), async (q) => {
      await q('select public.pp_grant_minutes($1, 30)', [ids.cand1]);
      return (await q('select public.pp_candidate_balance($1) as m', [ids.cand1])).rows[0].m;
    });
    assert.equal(minutes, 30);
    await db.asUser(user('manager1'), (q) => q('select public.pp_grant_minutes($1, -30)', [ids.cand1]));
  });

  test('minutes can only change through pp_grant_minutes, never by writing the ledger', async () => {
    await rejects(db.asUser(user('admin'), (q) =>
      q(`insert into public.time_ledger (candidate_id, seconds, reason) values ($1, 999999, 'grant')`, [ids.cand1])), /permission denied/);
  });

  test('tokens are never readable through the API, even by an admin', async () => {
    await rejects(db.asUser(user('admin'), (q) => q('select * from public.device_tokens')), /permission denied/);
  });

  test('staff cannot change their own role; only admins manage staff', async () => {
    const changed = await db.asUser(user('manager1'), async (q) =>
      (await q(`update public.staff set role = 'admin' where user_id = $1`, [user('manager1')])).rowCount);
    assert.equal(changed, 0);
    const selfDemote = await db.asUser(user('admin'), async (q) =>
      (await q(`update public.staff set role = 'coach' where user_id = $1`, [user('admin')])).rowCount);
    assert.equal(selfDemote, 0);
  });

  test('the audit log is for admins', async () => {
    const asAdmin = await db.asUser(user('admin'), async (q) => (await q('select action from public.audit_log')).rows.length);
    const asManager = await db.asUser(user('manager1'), async (q) => (await q('select action from public.audit_log')).rows.length);
    assert.ok(asAdmin > 0);
    assert.equal(asManager, 0);
  });

  test('the device functions are closed to dashboard users and the public', async () => {
    await rejects(db.asUser(user('admin'), (q) => q(`select public.pp_session_start($1)`, [randomUUID()])), /permission denied/);
    await rejects(db.asRole('anon', { role: 'anon' }, (q) => q(`select public.pp_redeem_invite('a','b','darwin','1','c','d')`)), /permission denied/);
    await rejects(db.asRole('anon', { role: 'anon' }, (q) => q('select * from public.candidates')), /permission denied/);
    await rejects(db.asUser(user('admin'), (q) => q(`select public.pp_bootstrap_org('x', 'admin@example.com')`)), /permission denied/);
  });
});

// A redeemed device for a candidate, with its tokens.
async function newDevice(candidate) {
  const code = await db.asUser(user('admin'), async (q) => (await q('select public.pp_create_invite($1) as c', [candidate])).rows[0].c);
  const access = randomUUID(), refresh = randomUUID();
  const r = await db.asService(async (q) => (await q(
    `select public.pp_redeem_invite($1, 'Asha MacBook', 'darwin', '3.1.0', $2, $3, $4) as r`,
    [sha(code), sha(access), sha(refresh), at(0)])).rows[0].r);
  return { code, access, refresh, deviceId: r.device_id, r };
}
const svc = (sql, params) => db.asService(async (q) => (await q(sql, params)).rows[0].r);

describe('invites and device tokens', () => {
  test('an invite code is shown once, redeems once, and becomes a device', async () => {
    const d = await newDevice(ids.cand1);
    assert.match(d.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(d.r.candidate_id, ids.cand1);
    const again = await svc(`select public.pp_redeem_invite($1, 'x', 'win32', '1', $2, $3, $4) as r`,
      [sha(d.code), sha('a2'), sha('r2'), at(1)]);
    assert.equal(again.error, 'code_used');
    const stored = await db.admin.query('select code_hash from public.invites where code_hash = $1', [sha(d.code)]);
    assert.equal(stored.rows.length, 1, 'only the hash is stored');
  });

  test('wrong and expired codes are refused', async () => {
    assert.equal((await svc(`select public.pp_redeem_invite($1, 'x', 'darwin', '1', $2, $3) as r`, [sha('NOPE'), sha('a'), sha('b')])).error, 'invalid_code');
    const code = await db.asUser(user('manager1'), async (q) => (await q('select public.pp_create_invite($1, 1) as c', [ids.cand1])).rows[0].c);
    const later = new Date(Date.now() + 2 * 86400_000).toISOString();
    assert.equal((await svc(`select public.pp_redeem_invite($1, 'x', 'darwin', '1', $2, $3, $4) as r`, [sha(code), sha('a3'), sha('b3'), later])).error, 'code_expired');
  });

  test('access tokens last 15 minutes; a refresh replaces both tokens', async () => {
    const d = await newDevice(ids.cand1);
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(d.access), at(60)])).device_id, d.deviceId);
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(d.access), at(16 * 60)])).error, 'invalid_token');
    const a2 = randomUUID(), r2 = randomUUID();
    const ref = await svc('select public.pp_refresh($1, $2, $3, $4) as r', [sha(d.refresh), sha(a2), sha(r2), at(16 * 60)]);
    assert.equal(ref.device_id, d.deviceId);
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(a2), at(17 * 60)])).device_id, d.deviceId);
  });

  test('a refresh token used twice was copied: the device is shut out', async () => {
    const d = await newDevice(ids.cand1);
    const a2 = randomUUID(), r2 = randomUUID();
    await svc('select public.pp_refresh($1, $2, $3, $4) as r', [sha(d.refresh), sha(a2), sha(r2), at(60)]);
    const reuse = await svc('select public.pp_refresh($1, $2, $3, $4) as r', [sha(d.refresh), sha('x'), sha('y'), at(120)]);
    assert.equal(reuse.error, 'device_revoked');
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(a2), at(130)])).error, 'device_revoked');
  });

  test('a manager can revoke a device', async () => {
    const d = await newDevice(ids.cand1);
    await rejects(db.asUser(user('manager2'), (q) => q('select public.pp_revoke_device($1)', [d.deviceId])), /forbidden/);
    await db.asUser(user('manager1'), (q) => q('select public.pp_revoke_device($1)', [d.deviceId]));
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(d.access), at(10)])).error, 'device_revoked');
  });
});

describe('minutes, slots and sessions', () => {
  // A fresh candidate per test, so balances never leak between tests.
  async function candidate(minutes, slot = [0, 3600]) {
    const id = await db.asUser(user('manager1'), async (q) => {
      const c = (await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Test') returning id`, [ids.org, ids.team1])).rows[0].id;
      if (minutes) await q('select public.pp_grant_minutes($1, $2)', [c, minutes]);
      if (slot) await q('insert into public.slots (candidate_id, starts_at, ends_at) values ($1, $2, $3)', [c, at(slot[0]), at(slot[1])]);
      return c;
    });
    const d = await newDevice(id);
    return { id, device: d.deviceId };
  }
  const start = (c, sec, assignment = null) => svc('select public.pp_session_start($1, $2, $3) as r', [c.device, assignment, at(sec)]);
  const beat = (c, s, seq, sec) => svc('select public.pp_session_heartbeat($1, $2, $3, $4) as r', [c.device, s, seq, at(sec)]);
  const authz = (c, s, sec) => svc('select public.pp_authorize_call($1, $2, $3) as r', [c.device, s, at(sec)]);
  const balance = async (c) => (await db.admin.query('select coalesce(sum(seconds),0)::int as b from public.time_ledger where candidate_id = $1', [c.id])).rows[0].b;

  test('when the organization requires slots: no slot right now, or no minutes, no session', async () => {
    await db.asUser(user('admin'), (q) => q('select public.pp_set_require_slots(true)'));
    try {
      assert.equal((await start(await candidate(10, null), 10)).error, 'no_active_slot');
      assert.equal((await start(await candidate(10, [3600, 7200]), 10)).error, 'no_active_slot');
      assert.equal((await start(await candidate(0), 10)).error, 'no_minutes');
    } finally {
      await db.asUser(user('admin'), (q) => q('select public.pp_set_require_slots(false)'));
    }
  });

  test('a session runs to the end of the minutes, charged per heartbeat, once per seq', async () => {
    const c = await candidate(10);
    const s = await start(c, 0);
    assert.equal(s.status, 'open');
    assert.equal(s.seconds_left, 600);
    await beat(c, s.session_id, 1, 30);
    await beat(c, s.session_id, 1, 30); // retried: not charged again
    assert.equal(await balance(c), 570);
    const b2 = await beat(c, s.session_id, 2, 60);
    assert.equal(await balance(c), 540);
    assert.equal(b2.seconds_left, 540);
    assert.equal((await authz(c, s.session_id, 61)).ok, true);
  });

  test('the slot end bounds the session', async () => {
    const c = await candidate(120, [0, 300]);
    const s = await start(c, 100);
    assert.equal(s.seconds_left, 200);
  });

  test('time up ends the session; only the minutes actually left are charged', async () => {
    const c = await candidate(1);
    const s = await start(c, 0);
    const b = await beat(c, s.session_id, 1, 75);
    assert.equal(b.status, 'ended');
    assert.equal(b.end_reason, 'time_up');
    assert.equal(await balance(c), 0);
    assert.equal((await authz(c, s.session_id, 76)).error, 'session_ended');
    assert.equal((await start(c, 80)).error, 'no_minutes');
  });

  test('silence over 90 seconds ends the session as stale, and the silence is not charged', async () => {
    const c = await candidate(10);
    const s = await start(c, 0);
    await beat(c, s.session_id, 1, 30);
    assert.equal((await authz(c, s.session_id, 200)).error, 'session_stale');
    const b = await beat(c, s.session_id, 2, 200);
    assert.equal(b.end_reason, 'stale');
    assert.equal(await balance(c), 570);
  });

  test('minutes given mid-session extend it', async () => {
    const c = await candidate(1);
    const s = await start(c, 0);
    await db.asUser(user('manager1'), (q) => q('select public.pp_grant_minutes($1, 5)', [c.id]));
    const b = await beat(c, s.session_id, 1, 30);
    assert.equal(b.status, 'open');
    assert.equal(b.seconds_left, 330);
  });

  test('starting again on the same device resumes; another device replaces it', async () => {
    const c = await candidate(10);
    const s1 = await start(c, 0);
    const again = await start(c, 10);
    assert.equal(again.session_id, s1.session_id);
    assert.equal(again.resumed, true);
    const other = await newDevice(c.id);
    const s2 = await svc('select public.pp_session_start($1, null, $2) as r', [other.deviceId, at(20)]);
    assert.notEqual(s2.session_id, s1.session_id);
    assert.equal((await authz(c, s1.session_id, 21)).error, 'session_ended');
  });

  test('an assignment caps time and attempts', async () => {
    const c = await candidate(60);
    const a = await db.asUser(user('manager1'), async (q) => (await q(
      `insert into public.assignments (candidate_id, title, time_limit_minutes, max_attempts) values ($1, 'Mock: backend', 2, 1) returning id`,
      [c.id])).rows[0].id);
    const s = await start(c, 0, a);
    assert.equal(s.seconds_left, 120);
    await svc('select public.pp_session_end($1, $2, 1, $3) as r', [c.device, s.session_id, at(30)]);
    assert.equal((await start(c, 40, a)).error, 'attempts_exhausted');
    assert.equal((await start(c, 40)).status, 'open', 'free practice still works');
  });

  test('another candidate\'s assignment is refused', async () => {
    const c = await candidate(10);
    const other = await candidate(10);
    const a = await db.asUser(user('manager1'), async (q) => (await q(
      `insert into public.assignments (candidate_id, title) values ($1, 'Not yours') returning id`, [other.id])).rows[0].id);
    assert.equal((await start(c, 0, a)).error, 'assignment_not_found');
  });

  test('usage is recorded per session and visible to the team, and coaches can comment', async () => {
    const c = await candidate(10);
    const s = await start(c, 0);
    await db.asService((q) => q(`select public.pp_record_usage($1, 'llm', 'gemini-3.1-flash-lite', 6000, 400, null, 0.0012)`, [s.session_id]));
    const seen = await db.asUser(user('manager1'), async (q) => (await q('select model from public.usage_events where session_id = $1', [s.session_id])).rows);
    assert.deepEqual(seen.map((r) => r.model), ['gemini-3.1-flash-lite']);
    const hidden = await db.asUser(user('manager2'), async (q) => (await q('select 1 from public.usage_events where session_id = $1', [s.session_id])).rows);
    assert.equal(hidden.length, 0);
    await db.asUser(user('coach1'), (q) => q(`insert into public.session_comments (session_id, author_id, body) values ($1, $2, 'Good STAR structure')`, [s.session_id, user('coach1')]));
  });

  test('the app\'s idle status: minutes, current and next slot, assignments', async () => {
    const c = await candidate(45, [0, 600]);
    const st = await svc('select public.pp_device_status($1, $2) as r', [c.device, at(10)]);
    assert.equal(st.balance_seconds, 2700);
    assert.ok(st.current_slot);
    assert.equal(st.next_slot, null);
    assert.deepEqual(st.assignments, []);
  });
});

describe('dashboard read models and staff actions', () => {
  test('the candidate overview follows the same access rules as the tables', async () => {
    const names = async (who) => db.asUser(user(who), async (q) => (await q('select name from public.candidate_overview')).rows.map((r) => r.name));
    assert.ok((await names('manager1')).includes('Asha'));
    assert.ok(!(await names('manager1')).includes('Ravi'));
    assert.deepEqual(await names('outsider'), []);
    const row = await db.asUser(user('manager1'), async (q) => (await q(`select team_name, balance_seconds, in_session from public.candidate_overview where id = $1`, [ids.cand1])).rows[0]);
    assert.equal(row.team_name, 'Backend');
    assert.equal(typeof row.balance_seconds, 'number');
  });

  test('the usage report covers only what the caller may see', async () => {
    const report = async (who) => db.asUser(user(who), async (q) =>
      (await q(`select candidate_name, cost_usd from public.pp_usage_report(now() - interval '1 year', now() + interval '1 year')`)).rows);
    const m1 = await report('manager1');
    assert.ok(m1.every((r) => r.candidate_name !== 'Ravi'));
    assert.ok((await report('admin')).some((r) => r.candidate_name === 'Ravi'));
    assert.deepEqual(await report('outsider'), []);
  });

  test('only an admin adds staff, into their own organization and teams', async () => {
    const newcomer = randomUUID();
    await db.admin.query(`insert into auth.users (id, email) values ($1, 'coach2@example.com')`, [newcomer]);
    const add = (by, teams) => db.asService(async (q) => (await q(`select public.pp_admin_add_staff($1, $2, 'coach', $3::uuid[], 'Coach Two') as r`, [by, newcomer, teams])).rows[0].r);
    assert.equal((await add(user('manager1'), [ids.team1])).error, 'forbidden');
    const ok = await add(user('admin'), [ids.team1]);
    assert.equal(ok.role, 'coach');
    const seen = await visibleCandidatesAs(newcomer);
    assert.ok(seen.includes('Asha') && !seen.includes('Ravi'), 'the new coach sees their team only');
    await assert.rejects(db.asUser(user('admin'), (q) => q(`select public.pp_admin_add_staff($1, $2, 'coach', '{}', null)`, [user('admin'), newcomer])), /permission denied/);
    const elsewhere = await db.asService(async (q) => (await q(`select public.pp_admin_add_staff($1, $2, 'manager', '{}', null) as r`, [user('outsider'), newcomer])).rows[0].r);
    assert.equal(elsewhere.error, 'in_another_organization');
  });

  test('archiving a candidate signs out their devices and ends their session', async () => {
    const c = await db.asUser(user('manager1'), async (q) => {
      const id = (await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Leaving') returning id`, [ids.org, ids.team1])).rows[0].id;
      await q('select public.pp_grant_minutes($1, 10)', [id]);
      await q(`insert into public.slots (candidate_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [id]);
      return id;
    });
    const d = await newDevice(c);
    const s = await svc('select public.pp_session_start($1, null) as r', [d.deviceId]);
    assert.equal(s.status, 'open');
    await assert.rejects(db.asUser(user('coach1'), (q) => q('select public.pp_archive_candidate($1)', [c])), /forbidden/);
    await db.asUser(user('manager1'), (q) => q('select public.pp_archive_candidate($1)', [c]));
    assert.equal((await svc('select public.pp_authenticate($1, $2) as r', [sha(d.access), at(10)])).error, 'device_revoked');
    const ended = (await db.admin.query('select end_reason from public.sessions where id = $1', [s.session_id])).rows[0].end_reason;
    assert.equal(ended, 'revoked');
  });
});

const visibleCandidatesAs = (userId) => db.asUser(userId, async (q) => (await q('select name from public.candidates order by name')).rows.map((r) => r.name));
