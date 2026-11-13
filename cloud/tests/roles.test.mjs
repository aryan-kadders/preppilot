// PrepPilot Cloud: the owner, recruiters, client interviews, and practice
// without a booked slot (migration 20261113000001). Runs against a private
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
const as = (who, sql, params) => db.asUser(user(who), async (q) => (await q(sql, params)).rows);
const one = async (who, sql, params) => (await as(who, sql, params))[0];
const rejects = (p, re) => assert.rejects(p, re);

before(async () => {
  db = await startDb();
  const a = db.admin;
  for (const name of ['owner', 'admin', 'manager', 'recruiter', 'otherRecruiter', 'coach', 'otherAdmin']) {
    ids[name] = randomUUID();
    await a.query('insert into auth.users (id, email) values ($1, $2)', [ids[name], `${name}@example.com`]);
  }
  ids.org = (await a.query(`select public.pp_bootstrap_org('Kadders', 'admin@example.com') as id`)).rows[0].id;
  ids.otherOrg = (await a.query(`select public.pp_bootstrap_org('Elsewhere', 'otherAdmin@example.com') as id`)).rows[0].id;
  await a.query(`select public.pp_bootstrap_owner('owner@example.com')`);

  await db.asUser(user('admin'), async (q) => {
    ids.team1 = (await q(`insert into public.teams (org_id, name) values ($1, 'Java') returning id`, [ids.org])).rows[0].id;
    ids.team2 = (await q(`insert into public.teams (org_id, name) values ($1, '.NET') returning id`, [ids.org])).rows[0].id;
    await q(`insert into public.staff (user_id, org_id, role) values
      ($1, $5, 'manager'), ($2, $5, 'recruiter'), ($3, $5, 'recruiter'), ($4, $5, 'coach')`,
      [user('manager'), user('recruiter'), user('otherRecruiter'), user('coach'), ids.org]);
    await q(`insert into public.staff_teams (team_id, user_id) values ($1, $2), ($1, $3), ($4, $5), ($1, $6)`,
      [ids.team1, user('manager'), user('recruiter'), ids.team2, user('otherRecruiter'), user('coach')]);
  });
  ids.cand = (await one('manager', `insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Asha') returning id`, [ids.org, ids.team1])).id;
  await db.asUser(user('otherAdmin'), async (q) => {
    const t = (await q(`insert into public.teams (org_id, name) values ($1, 'Data') returning id`, [ids.otherOrg])).rows[0].id;
    await q(`insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Meera')`, [ids.otherOrg, t]);
  });
});
after(async () => { await db?.stop(); });

const names = async (who) => (await as(who, 'select name from public.candidates order by name')).map((r) => r.name);

describe('the owner', () => {
  test('sees nothing until they pick an organization, but lists them all', async () => {
    assert.deepEqual(await names('owner'), []);
    const orgs = await as('owner', 'select name, candidates from public.pp_owner_orgs()');
    assert.deepEqual(orgs.map((o) => [o.name, o.candidates]), [['Elsewhere', 1], ['Kadders', 1]]);
    const me = (await one('owner', 'select public.pp_whoami() as r')).r;
    assert.equal(me.is_owner, true);
    assert.equal(me.role, 'owner');
    assert.equal(me.org_id, null);
  });

  test('works in one organization at a time, as its admin', async () => {
    await as('owner', 'select public.pp_owner_use_org($1)', [ids.org]);
    assert.deepEqual(await names('owner'), ['Asha']);
    assert.equal((await one('owner', 'select public.pp_grant_minutes($1, 15) as b', [ids.cand])).b, 900);
    assert.ok((await as('owner', 'select action from public.audit_log')).length > 0, 'reads that organization\'s audit log');
    await as('owner', 'select public.pp_owner_use_org($1)', [ids.otherOrg]);
    assert.deepEqual(await names('owner'), ['Meera']);
    await rejects(as('owner', 'select public.pp_grant_minutes($1, 15)', [ids.cand]), /forbidden/);
  });

  test('creates an organization and adds its first admin', async () => {
    const org = (await one('owner', `select public.pp_owner_create_org('New Client') as id`)).id;
    assert.equal((await one('owner', 'select public.pp_whoami() as r')).r.org_name, 'New Client');
    const newcomer = randomUUID();
    await db.admin.query(`insert into auth.users (id, email) values ($1, 'boss@newclient.com')`, [newcomer]);
    const r = await db.asService(async (q) => (await q(`select public.pp_admin_add_staff($1, $2, 'admin', '{}', 'Boss') as r`, [user('owner'), newcomer])).rows[0].r);
    assert.equal(r.org_id, org);
    assert.equal(await db.asService(async (q) => (await q('select public.pp_staff_role($1) as r', [user('owner')])).rows[0].r), 'owner');
  });

  test('nobody else can list organizations, become an owner, or read the owner list', async () => {
    await rejects(as('admin', 'select * from public.pp_owner_orgs()'), /forbidden/);
    await rejects(as('admin', 'select public.pp_owner_use_org($1)', [ids.otherOrg]), /forbidden/);
    await rejects(as('admin', `select public.pp_bootstrap_owner('admin@example.com')`), /permission denied/);
    await rejects(as('admin', 'select * from public.platform_owners'), /permission denied/);
    await rejects(as('admin', `insert into public.platform_owners (user_id) values ($1)`, [user('admin')]), /permission denied/);
    assert.equal((await one('admin', 'select public.pp_whoami() as r')).r.is_owner, false);
  });
});

describe('recruiters and client interviews', () => {
  const create = (who, cand = ids.cand) => one(who,
    `select public.pp_create_interview($1, 'Infosys', 'Java Developer', $2, 'Technical round 1', 'Spring Boot, Kafka, SQL') as id`,
    [cand, '2026-12-01T09:00:00Z']);

  test('a recruiter sees their team but cannot give minutes, book slots or create invites', async () => {
    assert.deepEqual(await names('recruiter'), ['Asha']);
    assert.deepEqual(await names('otherRecruiter'), []);
    await rejects(as('recruiter', 'select public.pp_grant_minutes($1, 30)', [ids.cand]), /forbidden/);
    await rejects(as('recruiter', 'select public.pp_create_invite($1)', [ids.cand]), /forbidden/);
    await rejects(as('recruiter', `insert into public.slots (candidate_id, starts_at, ends_at) values ($1, now(), now() + interval '1 hour')`, [ids.cand]), /row-level security/);
  });

  test('adding an interview creates its prep assignment, due on the interview date', async () => {
    const { id } = await create('recruiter');
    const row = await one('recruiter', 'select company, role_title, round, assignment_id from public.interviews where id = $1', [id]);
    assert.deepEqual([row.company, row.role_title, row.round], ['Infosys', 'Java Developer', 'Technical round 1']);
    const a = await one('manager', 'select title, kind, job_description, due_at from public.assignments where id = $1', [row.assignment_id]);
    assert.equal(a.title, 'Prep: Java Developer at Infosys');
    assert.equal(a.kind, 'mock_interview');
    assert.equal(a.job_description, 'Spring Boot, Kafka, SQL');
    assert.equal(new Date(a.due_at).toISOString(), '2026-12-01T09:00:00.000Z');
  });

  test('only the team\'s recruiters and managers add interviews; coaches do not', async () => {
    await rejects(create('otherRecruiter'), /forbidden/);
    await rejects(create('coach'), /forbidden/);
    assert.ok((await create('manager')).id);
  });

  test('a reschedule moves the prep assignment too', async () => {
    const { id } = await create('recruiter');
    await as('recruiter', `select public.pp_update_interview($1, 'Infosys', 'Senior Java Developer', $2)`, [id, '2026-12-05T09:00:00Z']);
    const r = await one('recruiter', `select i.role_title, a.title, a.due_at from public.interviews i join public.assignments a on a.id = i.assignment_id where i.id = $1`, [id]);
    assert.equal(r.title, 'Prep: Senior Java Developer at Infosys');
    assert.equal(new Date(r.due_at).toISOString(), '2026-12-05T09:00:00.000Z');
  });

  test('coaches say whether the candidate is ready; recruiters record the outcome', async () => {
    const { id } = await create('recruiter');
    await rejects(as('recruiter', `select public.pp_set_interview_readiness($1, 'ready')`, [id]), /forbidden/);
    await as('coach', `select public.pp_set_interview_readiness($1, 'needs_work', 'Revise Kafka consumer groups')`, [id]);
    await rejects(as('coach', `select public.pp_set_interview_outcome($1, 'selected')`, [id]), /forbidden/);
    await as('recruiter', `select public.pp_set_interview_outcome($1, 'selected', 'Offer at 18 LPA')`, [id]);
    const r = await one('manager', 'select readiness, readiness_note, outcome from public.interview_overview where id = $1', [id]);
    assert.deepEqual([r.readiness, r.readiness_note, r.outcome], ['needs_work', 'Revise Kafka consumer groups', 'selected']);
    await rejects(as('recruiter', `select public.pp_set_interview_outcome($1, 'hired')`, [id]), /unknown outcome/);
  });

  test('interviews are written only through the functions', async () => {
    await rejects(as('admin', `insert into public.interviews (candidate_id, company, role_title, interview_at) values ($1, 'X', 'Y', now())`, [ids.cand]), /permission denied/);
  });

  test('deleting an unpractised interview removes its prep assignment', async () => {
    const { id } = await create('recruiter');
    const { assignment_id } = await one('recruiter', 'select assignment_id from public.interviews where id = $1', [id]);
    await as('recruiter', 'select public.pp_delete_interview($1)', [id]);
    assert.equal((await db.admin.query('select 1 from public.assignments where id = $1', [assignment_id])).rows.length, 0);
  });
});

describe('practice without a booked slot', () => {
  async function device(minutes) {
    const c = (await one('manager', `insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Slotless') returning id`, [ids.org, ids.team1])).id;
    if (minutes) await as('manager', 'select public.pp_grant_minutes($1, $2)', [c, minutes]);
    const code = (await one('manager', 'select public.pp_create_invite($1) as c', [c])).c;
    const r = await db.asService(async (q) => (await q(
      `select public.pp_redeem_invite($1, 'Laptop', 'win32', '3.1.0', $2, $3, $4) as r`,
      [sha(code), sha(randomUUID()), sha(randomUUID()), at(0)])).rows[0].r);
    return { id: c, device: r.device_id };
  }
  const svc = async (sql, params) => db.asService(async (q) => (await q(sql, params)).rows[0].r);
  const start = (c, sec) => svc('select public.pp_session_start($1, null, $2) as r', [c.device, at(sec)]);

  test('by default a candidate with minutes practises any time, bounded by the minutes', async () => {
    const c = await device(10);
    const s = await start(c, 0);
    assert.equal(s.status, 'open');
    assert.equal(s.seconds_left, 600);
    const st = await svc('select public.pp_device_status($1, $2) as r', [c.device, at(1)]);
    assert.equal(st.require_slots, false);
  });

  test('minutes given mid-session extend a session without a slot', async () => {
    const c = await device(1);
    const s = await start(c, 0);
    await as('manager', 'select public.pp_grant_minutes($1, 5)', [c.id]);
    const b = await svc('select public.pp_session_heartbeat($1, $2, 1, $3) as r', [c.device, s.session_id, at(30)]);
    assert.equal(b.status, 'open');
    assert.equal(b.seconds_left, 330);
  });

  test('an admin can require booked slots again; nobody else can', async () => {
    await rejects(as('manager', 'select public.pp_set_require_slots(true)'), /forbidden/);
    await as('admin', 'select public.pp_set_require_slots(true)');
    try {
      const c = await device(10);
      assert.equal((await start(c, 0)).error, 'no_active_slot');
      assert.equal((await svc('select public.pp_device_status($1, $2) as r', [c.device, at(1)])).require_slots, true);
    } finally {
      await as('admin', 'select public.pp_set_require_slots(false)');
    }
  });
});

describe('interview readiness view', () => {
  test('counts the practice done between adding the interview and the interview', async () => {
    const c = (await one('manager', `insert into public.candidates (org_id, team_id, name) values ($1, $2, 'Kiran') returning id`, [ids.org, ids.team1])).id;
    await as('manager', 'select public.pp_grant_minutes($1, 60)', [c]);
    const { id } = await one('recruiter', `select public.pp_create_interview($1, 'TCS', 'Backend Developer', now() + interval '3 days') as id`, [c]);
    const code = (await one('manager', 'select public.pp_create_invite($1) as c', [c])).c;
    const dev = await db.asService(async (q) => (await q(
      `select public.pp_redeem_invite($1, 'Laptop', 'darwin', '3.1.0', $2, $3) as r`, [sha(code), sha(randomUUID()), sha(randomUUID())])).rows[0].r);
    const s = await db.asService(async (q) => (await q('select public.pp_session_start($1, null) as r', [dev.device_id])).rows[0].r);
    assert.equal(s.status, 'open', JSON.stringify(s));
    await db.asService((q) => q(`select public.pp_session_end($1, $2, 1, now() + interval '60 seconds')`, [dev.device_id, s.session_id]));
    const row = await one('recruiter', 'select practice_sessions, practice_seconds, candidate_name from public.interview_overview where id = $1', [id]);
    assert.equal(row.candidate_name, 'Kiran');
    assert.equal(row.practice_sessions, 1);
    assert.ok(row.practice_seconds >= 55 && row.practice_seconds <= 65, String(row.practice_seconds));
    assert.deepEqual(await as('otherRecruiter', 'select id from public.interview_overview where id = $1', [id]), [], 'another team does not see it');
  });
});
