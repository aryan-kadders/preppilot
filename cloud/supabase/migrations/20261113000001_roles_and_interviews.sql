-- PrepPilot Cloud: the owner, recruiters, client interviews, and practice
-- without a booked slot (2026-11-13).
--
-- Who is who, after this migration:
--   owner      the people who build and run PrepPilot. They see and change
--              everything, in every organization, one organization at a
--              time: they pick it (pp_owner_use_org), and from then on every
--              rule treats them as that organization's admin. They are not
--              staff and no admin can make someone an owner: owners are added
--              only from the SQL editor (pp_bootstrap_owner).
--   admin      one organization, every team.
--   manager    their teams: candidates, minutes, slots, assignments, invites.
--   recruiter  their teams: adds the client interviews candidates prepare
--              for, and records how each one went. No minutes, slots or
--              invites.
--   coach      their teams: reads sessions, writes notes, says whether a
--              candidate is ready for an interview.
--   candidate  uses the desktop app (unchanged).
--
-- Practice time: a candidate with minutes may practise at any time unless the
-- organization turns on "require booked slots" (organizations.require_slots).

-- ───────────────────────────── owners ─────────────────────────────

create table public.platform_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_org_id uuid references public.organizations(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Never readable or writable through the API; the functions below answer.
alter table public.platform_owners enable row level security;
revoke all on public.platform_owners from anon, authenticated;

create function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_owners o where o.user_id = auth.uid())
$$;

-- The organization an owner is working in (null for everyone else).
create function app.owner_org() returns uuid
language sql stable security definer set search_path = '' as $$
  select o.current_org_id from public.platform_owners o where o.user_id = auth.uid()
$$;

-- The existing helpers learn about owners. Every policy and pp_* function
-- already goes through them, so an owner working in an organization is its
-- admin everywhere, and sees nothing of the others meanwhile.

create or replace function app.my_org() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.current_org_id from public.platform_owners o where o.user_id = auth.uid()),
    (select s.org_id from public.staff s where s.user_id = auth.uid()))
$$;

create or replace function app.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when app.is_owner() then 'owner'
              else (select s.role from public.staff s where s.user_id = auth.uid()) end
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.owner_org() is not null
      or exists (select 1 from public.staff s where s.user_id = auth.uid() and s.role = 'admin')
$$;

create or replace function app.sees_team(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teams t where t.id = p_team and t.org_id = app.owner_org())
      or exists (
        select 1 from public.staff s
        join public.teams t on t.org_id = s.org_id
        where s.user_id = auth.uid() and t.id = p_team
          and (s.role = 'admin' or exists (
            select 1 from public.staff_teams st where st.team_id = t.id and st.user_id = s.user_id)))
$$;

create or replace function app.manages_team(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teams t where t.id = p_team and t.org_id = app.owner_org())
      or exists (
        select 1 from public.staff s
        join public.teams t on t.org_id = s.org_id
        where s.user_id = auth.uid() and t.id = p_team
          and (s.role = 'admin' or (s.role = 'manager' and exists (
            select 1 from public.staff_teams st where st.team_id = t.id and st.user_id = s.user_id))))
$$;

-- May this person add and close the team's client interviews? Admins (and an
-- owner working in the organization), and the team's managers and recruiters.
create function app.recruits_team(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teams t where t.id = p_team and t.org_id = app.owner_org())
      or exists (
        select 1 from public.staff s
        join public.teams t on t.org_id = s.org_id
        where s.user_id = auth.uid() and t.id = p_team
          and (s.role = 'admin' or (s.role in ('manager', 'recruiter') and exists (
            select 1 from public.staff_teams st where st.team_id = t.id and st.user_id = s.user_id))))
$$;

create function app.recruits_candidate(p_candidate uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.candidates c where c.id = p_candidate and app.recruits_team(c.team_id))
$$;

grant execute on function app.is_owner(), app.owner_org(), app.recruits_team(uuid), app.recruits_candidate(uuid) to authenticated;

-- ───────────────────────────── recruiters ─────────────────────────────

alter table public.staff drop constraint staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('admin', 'manager', 'recruiter', 'coach'));

-- Adds a person to an organization as staff, for an admin of it or an owner
-- working in it. (Replaces the Phase 3 version: owners, and the recruiter role.)
create or replace function public.pp_admin_add_staff(p_admin uuid, p_user uuid, p_role text, p_team_ids uuid[], p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_team uuid;
begin
  select org_id into v_org from public.staff where user_id = p_admin and role = 'admin';
  if v_org is null then
    select current_org_id into v_org from public.platform_owners where user_id = p_admin;
  end if;
  if v_org is null then return jsonb_build_object('error', 'forbidden'); end if;
  if p_role not in ('admin', 'manager', 'recruiter', 'coach') then return jsonb_build_object('error', 'bad_role'); end if;
  if exists (select 1 from public.staff where user_id = p_user and org_id <> v_org) then
    return jsonb_build_object('error', 'in_another_organization');
  end if;
  insert into public.staff (user_id, org_id, role, display_name) values (p_user, v_org, p_role, nullif(trim(p_display_name), ''))
  on conflict (user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, public.staff.display_name);
  foreach v_team in array coalesce(p_team_ids, '{}') loop
    if not exists (select 1 from public.teams where id = v_team and org_id = v_org) then
      raise exception 'team % is not in this organization', v_team;
    end if;
    insert into public.staff_teams (team_id, user_id) values (v_team, p_user) on conflict do nothing;
  end loop;
  insert into public.audit_log (org_id, actor_id, action, target_type, target_id, details)
  values (v_org, p_admin, 'staff.add', 'user', p_user, jsonb_build_object('role', p_role, 'teams', coalesce(array_length(p_team_ids, 1), 0)));
  return jsonb_build_object('user_id', p_user, 'org_id', v_org, 'role', p_role);
end $$;

-- For the `api` function's staff routes: 'owner' for an owner working in an
-- organization, else the staff role (null when neither).
create or replace function public.pp_staff_role(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select 'owner' from public.platform_owners o where o.user_id = p_user and o.current_org_id is not null),
    (select role from public.staff where user_id = p_user))
$$;

-- ───────────────────────── practice without a slot ─────────────────────────

alter table public.organizations add column require_slots boolean not null default false;

create function public.pp_set_require_slots(p_require boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.my_org();
begin
  if v_org is null or not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.organizations set require_slots = p_require where id = v_org;
  perform app.audit(v_org, 'org.require_slots', 'organization', v_org, jsonb_build_object('require_slots', p_require));
end $$;
revoke execute on function public.pp_set_require_slots(boolean) from public, anon;
grant execute on function public.pp_set_require_slots(boolean) to authenticated;

-- A session with no slot is bounded by the minutes and the assignment only.
create or replace function app.charge_session(p_session uuid, p_seq int, p_now timestamptz)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare v public.sessions; v_elapsed int; v_slot_end timestamptz; v_limit int;
begin
  select * into v from public.sessions where id = p_session for update;
  if v.ended_at is not null or p_seq <= v.last_seq then return v; end if;
  if p_now - v.last_heartbeat_at > app.stale_after() then
    update public.sessions set ended_at = v.last_heartbeat_at, end_reason = 'stale' where id = v.id returning * into v;
    return v;
  end if;
  v_elapsed := greatest(0, floor(extract(epoch from (least(p_now, v.allowed_until) - v.last_heartbeat_at))))::int;
  if v_elapsed > 0 then
    insert into public.time_ledger (candidate_id, seconds, reason, session_id, idempotency_key)
    values (v.candidate_id, -v_elapsed, 'usage', v.id, v.id::text || ':' || p_seq)
    on conflict (idempotency_key) do nothing;
  end if;
  if v.slot_id is null then
    v_slot_end := 'infinity';
  else
    select s.ends_at into v_slot_end from public.slots s where s.id = v.slot_id;
  end if;
  select a.time_limit_minutes into v_limit from public.assignments a where a.id = v.assignment_id;
  update public.sessions set
    last_heartbeat_at = p_now, last_seq = p_seq, charged_seconds = charged_seconds + v_elapsed,
    -- Recomputed each time, so minutes given mid-session extend it (never past
    -- the slot or the assignment's limit). A deleted slot keeps the old end.
    allowed_until = app.allowed_until(v.candidate_id, coalesce(v_slot_end, v.allowed_until), v.started_at, v_limit, p_now)
  where id = v.id returning * into v;
  if p_now >= v.allowed_until then
    update public.sessions set ended_at = v.allowed_until, end_reason = 'time_up' where id = v.id returning * into v;
  end if;
  return v;
end $$;

create or replace function public.pp_session_start(p_device uuid, p_assignment uuid default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices; v_slot public.slots; v_assign public.assignments; v_open public.sessions;
  v_balance int; v_until timestamptz; v_used int; v_session public.sessions; v_require boolean;
begin
  select * into v_dev from public.devices where id = p_device;
  if v_dev.id is null or v_dev.revoked_at is not null then return jsonb_build_object('error', 'device_revoked'); end if;

  perform 1 from public.candidates where id = v_dev.candidate_id for update;
  select * into v_open from public.sessions where candidate_id = v_dev.candidate_id and ended_at is null;
  if v_open.id is not null then
    if p_now - v_open.last_heartbeat_at > app.stale_after() then
      update public.sessions set ended_at = last_heartbeat_at, end_reason = 'stale' where id = v_open.id;
    elsif v_open.device_id = p_device and v_open.assignment_id is not distinct from p_assignment then
      return app.session_view(v_open, p_now) || jsonb_build_object('resumed', true);
    else
      perform app.charge_session(v_open.id, v_open.last_seq + 1, p_now);
      update public.sessions set ended_at = p_now, end_reason = 'replaced' where id = v_open.id and ended_at is null;
    end if;
  end if;

  select * into v_slot from public.slots
  where candidate_id = v_dev.candidate_id and starts_at <= p_now and ends_at > p_now
  order by ends_at desc limit 1;
  select o.require_slots into v_require
  from public.candidates c join public.organizations o on o.id = c.org_id where c.id = v_dev.candidate_id;
  if v_slot.id is null and v_require then return jsonb_build_object('error', 'no_active_slot'); end if;

  v_balance := app.balance_seconds(v_dev.candidate_id);
  if v_balance <= 0 then return jsonb_build_object('error', 'no_minutes'); end if;

  if p_assignment is not null then
    select * into v_assign from public.assignments where id = p_assignment and candidate_id = v_dev.candidate_id;
    if v_assign.id is null then return jsonb_build_object('error', 'assignment_not_found'); end if;
    if v_assign.max_attempts is not null then
      select count(*) into v_used from public.sessions where assignment_id = v_assign.id;
      if v_used >= v_assign.max_attempts then return jsonb_build_object('error', 'attempts_exhausted'); end if;
    end if;
  end if;

  v_until := app.allowed_until(v_dev.candidate_id, coalesce(v_slot.ends_at, 'infinity'), p_now, v_assign.time_limit_minutes, p_now);
  insert into public.sessions (candidate_id, device_id, slot_id, assignment_id, started_at, last_heartbeat_at, allowed_until)
  values (v_dev.candidate_id, p_device, v_slot.id, p_assignment, p_now, p_now, v_until)
  returning * into v_session;
  return app.session_view(v_session, p_now);
end $$;

-- The app's idle status also says whether slots are required, so it does not
-- tell a candidate to wait for one when none is needed.
create or replace function public.pp_device_status(p_device uuid, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'candidate', jsonb_build_object('id', c.id, 'name', c.name),
    'balance_seconds', app.balance_seconds(c.id),
    'require_slots', o.require_slots,
    'current_slot', (select jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at) from public.slots s
                     where s.candidate_id = c.id and s.starts_at <= p_now and s.ends_at > p_now order by s.ends_at desc limit 1),
    'next_slot', (select jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at) from public.slots s
                  where s.candidate_id = c.id and s.starts_at > p_now order by s.starts_at limit 1),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'kind', a.kind, 'role_title', a.role_title, 'company', a.company,
        'topics', a.topics, 'due_at', a.due_at, 'max_attempts', a.max_attempts,
        'time_limit_minutes', a.time_limit_minutes,
        'attempts_used', (select count(*) from public.sessions x where x.assignment_id = a.id)) order by a.due_at nulls last)
      from public.assignments a where a.candidate_id = c.id), '[]'::jsonb))
  from public.devices d
  join public.candidates c on c.id = d.candidate_id
  join public.organizations o on o.id = c.org_id
  where d.id = p_device and d.revoked_at is null
$$;
-- create or replace keeps the grants: service role only.

-- ───────────────────────────── client interviews ─────────────────────────────

-- An interview a candidate is preparing for. Adding one creates its prep
-- assignment (a mock interview built from the job description, due on the
-- interview date); a coach says whether the candidate is ready; the recruiter
-- records how it went.
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  assignment_id uuid references public.assignments(id) on delete set null,
  company text not null check (length(trim(company)) between 1 and 200),
  role_title text not null check (length(trim(role_title)) between 1 and 200),
  round text check (round is null or length(round) <= 100),
  job_description text check (job_description is null or length(job_description) <= 20000),
  interview_at timestamptz not null,
  readiness text check (readiness in ('ready', 'needs_work')),
  readiness_note text check (readiness_note is null or length(readiness_note) <= 2000),
  readiness_by uuid references auth.users(id),
  readiness_at timestamptz,
  outcome text check (outcome in ('selected', 'rejected', 'on_hold', 'cancelled', 'no_show')),
  outcome_note text check (outcome_note is null or length(outcome_note) <= 2000),
  outcome_at timestamptz,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.interviews (candidate_id, interview_at);

alter table public.interviews enable row level security;
revoke all on public.interviews from anon, authenticated;
-- Read by everyone who sees the candidate; written only through the functions.
grant select on public.interviews to authenticated;
create policy interviews_read on public.interviews for select to authenticated using (app.sees_candidate(candidate_id));

create function public.pp_create_interview(p_candidate uuid, p_company text, p_role_title text, p_interview_at timestamptz,
  p_round text default null, p_job_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_assign uuid; v_id uuid;
begin
  if not app.recruits_candidate(p_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  select org_id into v_org from public.candidates where id = p_candidate and status <> 'archived';
  if v_org is null then raise exception 'candidate not found or archived'; end if;
  insert into public.assignments (candidate_id, title, kind, role_title, company, job_description, due_at, created_by)
  values (p_candidate, left('Prep: ' || trim(p_role_title) || ' at ' || trim(p_company), 300), 'mock_interview',
          trim(p_role_title), trim(p_company), nullif(trim(p_job_description), ''), p_interview_at, auth.uid())
  returning id into v_assign;
  insert into public.interviews (candidate_id, assignment_id, company, role_title, round, job_description, interview_at)
  values (p_candidate, v_assign, trim(p_company), trim(p_role_title), nullif(trim(p_round), ''),
          nullif(trim(p_job_description), ''), p_interview_at)
  returning id into v_id;
  perform app.audit(v_org, 'interview.create', 'interview', v_id,
    jsonb_build_object('company', trim(p_company), 'role', trim(p_role_title), 'at', p_interview_at));
  return v_id;
end $$;

-- Change the details (a reschedule, a new job description); the prep
-- assignment follows.
create function public.pp_update_interview(p_interview uuid, p_company text, p_role_title text, p_interview_at timestamptz,
  p_round text default null, p_job_description text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.interviews; v_org uuid;
begin
  select * into v from public.interviews where id = p_interview;
  if v.id is null or not app.recruits_candidate(v.candidate_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.interviews set company = trim(p_company), role_title = trim(p_role_title), interview_at = p_interview_at,
    round = nullif(trim(p_round), ''), job_description = nullif(trim(p_job_description), '')
  where id = p_interview;
  update public.assignments set title = left('Prep: ' || trim(p_role_title) || ' at ' || trim(p_company), 300),
    role_title = trim(p_role_title), company = trim(p_company), job_description = nullif(trim(p_job_description), ''),
    due_at = p_interview_at
  where id = v.assignment_id;
  select org_id into v_org from public.candidates where id = v.candidate_id;
  perform app.audit(v_org, 'interview.update', 'interview', p_interview, jsonb_build_object('at', p_interview_at));
end $$;

-- Removes the interview, and its prep assignment unless it was practised
-- (the practice history keeps its name then).
create function public.pp_delete_interview(p_interview uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.interviews; v_org uuid;
begin
  select * into v from public.interviews where id = p_interview;
  if v.id is null or not app.recruits_candidate(v.candidate_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.interviews where id = p_interview;
  if v.assignment_id is not null and not exists (select 1 from public.sessions s where s.assignment_id = v.assignment_id) then
    delete from public.assignments where id = v.assignment_id;
  end if;
  select org_id into v_org from public.candidates where id = v.candidate_id;
  perform app.audit(v_org, 'interview.delete', 'interview', p_interview, jsonb_build_object('company', v.company));
end $$;

-- Ready or not: coaches, managers, admins and owners (not recruiters, who
-- act on it). Null clears it.
create function public.pp_set_interview_readiness(p_interview uuid, p_readiness text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.interviews; v_org uuid;
begin
  select * into v from public.interviews where id = p_interview;
  if v.id is null or not app.sees_candidate(v.candidate_id) or app.my_role() not in ('owner', 'admin', 'manager', 'coach') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_readiness is not null and p_readiness not in ('ready', 'needs_work') then raise exception 'readiness must be ready or needs_work'; end if;
  update public.interviews set readiness = p_readiness, readiness_note = nullif(trim(p_note), ''),
    readiness_by = case when p_readiness is null then null else auth.uid() end,
    readiness_at = case when p_readiness is null then null else now() end
  where id = p_interview;
  select org_id into v_org from public.candidates where id = v.candidate_id;
  perform app.audit(v_org, 'interview.readiness', 'interview', p_interview, jsonb_build_object('readiness', p_readiness));
end $$;

-- How it went: the team's recruiters and managers, admins and owners. Null
-- reopens it.
create function public.pp_set_interview_outcome(p_interview uuid, p_outcome text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.interviews; v_org uuid;
begin
  select * into v from public.interviews where id = p_interview;
  if v.id is null or not app.recruits_candidate(v.candidate_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_outcome is not null and p_outcome not in ('selected', 'rejected', 'on_hold', 'cancelled', 'no_show') then
    raise exception 'unknown outcome';
  end if;
  update public.interviews set outcome = p_outcome, outcome_note = nullif(trim(p_note), ''),
    outcome_at = case when p_outcome is null then null else now() end
  where id = p_interview;
  select org_id into v_org from public.candidates where id = v.candidate_id;
  perform app.audit(v_org, 'interview.outcome', 'interview', p_interview, jsonb_build_object('outcome', p_outcome));
end $$;

revoke execute on function
  public.pp_create_interview(uuid, text, text, timestamptz, text, text),
  public.pp_update_interview(uuid, text, text, timestamptz, text, text),
  public.pp_delete_interview(uuid),
  public.pp_set_interview_readiness(uuid, text, text),
  public.pp_set_interview_outcome(uuid, text, text) from public, anon;
grant execute on function
  public.pp_create_interview(uuid, text, text, timestamptz, text, text),
  public.pp_update_interview(uuid, text, text, timestamptz, text, text),
  public.pp_delete_interview(uuid),
  public.pp_set_interview_readiness(uuid, text, text),
  public.pp_set_interview_outcome(uuid, text, text) to authenticated;

-- One row per interview the caller may see, with the practice done for it:
-- sessions the candidate ran between adding the interview and the interview.
create view public.interview_overview with (security_invoker = true) as
select
  i.id, i.candidate_id, i.assignment_id, i.company, i.role_title, i.round, i.job_description, i.interview_at,
  i.readiness, i.readiness_note, i.readiness_at, i.outcome, i.outcome_note, i.outcome_at, i.created_at,
  c.name as candidate_name, c.org_id, c.team_id, t.name as team_name, c.status as candidate_status,
  coalesce((select sum(l.seconds) from public.time_ledger l where l.candidate_id = c.id), 0)::int as balance_seconds,
  (select count(*) from public.sessions s
     where s.candidate_id = c.id and s.started_at >= i.created_at and s.started_at < i.interview_at)::int as practice_sessions,
  coalesce((select sum(s.charged_seconds) from public.sessions s
     where s.candidate_id = c.id and s.started_at >= i.created_at and s.started_at < i.interview_at), 0)::int as practice_seconds,
  (select max(s.started_at) from public.sessions s
     where s.candidate_id = c.id and s.started_at >= i.created_at and s.started_at < i.interview_at) as last_practice_at
from public.interviews i
join public.candidates c on c.id = i.candidate_id
join public.teams t on t.id = c.team_id;

grant select on public.interview_overview to authenticated;

-- ───────────────────────────── owner actions ─────────────────────────────

-- Who is signed in to the dashboard, in one call.
create function public.pp_whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_owner', app.is_owner(),
    'role', app.my_role(),
    'org_id', o.id,
    'org_name', o.name,
    'require_slots', o.require_slots,
    'display_name', (select s.display_name from public.staff s where s.user_id = auth.uid()))
  from (select 1) one
  left join public.organizations o on o.id = app.my_org()
$$;
revoke execute on function public.pp_whoami() from public, anon;
grant execute on function public.pp_whoami() to authenticated;

-- Every organization with its numbers, for owners.
create function public.pp_owner_orgs()
returns table (
  id uuid, name text, created_at timestamptz, require_slots boolean,
  teams int, staff int, candidates int, active_candidates int,
  used_seconds_30d int, cost_usd_30d numeric, upcoming_interviews int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select o.id, o.name, o.created_at, o.require_slots,
    (select count(*) from public.teams t where t.org_id = o.id)::int,
    (select count(*) from public.staff s where s.org_id = o.id)::int,
    (select count(*) from public.candidates c where c.org_id = o.id and c.status <> 'archived')::int,
    (select count(*) from public.candidates c where c.org_id = o.id and c.status = 'active')::int,
    coalesce((select -sum(l.seconds) from public.time_ledger l join public.candidates c on c.id = l.candidate_id
      where c.org_id = o.id and l.reason = 'usage' and l.created_at > now() - interval '30 days'), 0)::int,
    coalesce((select sum(u.cost_usd) from public.usage_events u join public.candidates c on c.id = u.candidate_id
      where c.org_id = o.id and u.created_at > now() - interval '30 days'), 0),
    (select count(*) from public.interviews i join public.candidates c on c.id = i.candidate_id
      where c.org_id = o.id and i.interview_at > now() and i.outcome is null)::int
  from public.organizations o
  order by o.name;
end $$;

-- Work in an organization (null: none).
create function public.pp_owner_use_org(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_org is not null and not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organization not found';
  end if;
  update public.platform_owners set current_org_id = p_org where user_id = auth.uid();
end $$;

-- A new organization; the owner starts working in it (and can then invite
-- its first admin from Teams & staff).
create function public.pp_owner_create_org(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if not app.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.organizations (name) values (trim(p_name)) returning id into v_org;
  update public.platform_owners set current_org_id = v_org where user_id = auth.uid();
  perform app.audit(v_org, 'org.create', 'organization', v_org, jsonb_build_object('name', trim(p_name)));
  return v_org;
end $$;

revoke execute on function public.pp_owner_orgs(), public.pp_owner_use_org(uuid), public.pp_owner_create_org(text) from public, anon;
grant execute on function public.pp_owner_orgs(), public.pp_owner_use_org(uuid), public.pp_owner_create_org(text) to authenticated;

-- Make someone an owner. SQL editor only, after they have signed up in
-- Supabase Auth (see cloud/README.md).
create function public.pp_bootstrap_owner(p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then raise exception 'no auth user with email %', p_email; end if;
  insert into public.platform_owners (user_id) values (v_user) on conflict do nothing;
  return v_user;
end $$;
revoke execute on function public.pp_bootstrap_owner(text) from public, anon, authenticated;
