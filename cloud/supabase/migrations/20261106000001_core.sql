-- PrepPilot Cloud, core schema (Phase 1).
--
-- Who is who:
--   staff       people who sign in to the dashboard (Supabase Auth users):
--               admin (whole organization), manager (their teams), coach
--               (reads and comments on their teams' sessions).
--   candidates  people who use the desktop app. They never sign in to
--               Supabase: an invite code becomes a device, and the device
--               holds a short-lived access token and a rotating refresh
--               token. Only SHA-256 hashes of codes and tokens are stored.
--
-- Where the rules live:
--   * Staff read and write through PostgREST under row-level security, on
--     every table. RLS is enabled, not forced: the table owner is the role the
--     SECURITY DEFINER functions below run as, and those functions do their
--     own checks (forcing RLS on it would hide every row from them).
--   * Everything a candidate's device does goes through the `api` Edge
--     Function with the service role, calling the pp_* functions below. Those
--     functions are not executable by anon or authenticated.
--   * Minutes are an append-only ledger: a grant adds seconds, each session
--     heartbeat subtracts the seconds since the last one, and a unique
--     idempotency key means a retried heartbeat is never charged twice.

create schema if not exists app;

-- ───────────────────────────── tables ─────────────────────────────

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('admin', 'manager', 'coach')),
  display_name text,
  created_at timestamptz not null default now()
);

create table public.staff_teams (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.staff(user_id) on delete cascade,
  primary key (team_id, user_id)
);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 200),
  email text,
  status text not null default 'invited' check (status in ('invited', 'active', 'archived')),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.candidates (team_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  name text,
  platform text check (platform in ('darwin', 'win32', 'linux')),
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index on public.devices (candidate_id);

-- Access tokens (15 min) and refresh tokens (30 days). A refresh token is
-- single-use: refreshing marks it used and issues a new pair in the same
-- family. Presenting a used refresh token again means it was copied, so the
-- whole device is revoked (refresh-token reuse detection).
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.device_tokens (device_id);

create table public.slots (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours')
);
create index on public.slots (candidate_id, starts_at);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 300),
  kind text not null default 'mock_interview' check (kind in ('mock_interview', 'practice')),
  role_title text,
  company text,
  job_description text,
  topics text[] not null default '{}',
  due_at timestamptz,
  max_attempts int check (max_attempts is null or max_attempts > 0),
  time_limit_minutes int check (time_limit_minutes is null or time_limit_minutes > 0),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.assignments (candidate_id);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  slot_id uuid references public.slots(id) on delete set null,
  assignment_id uuid references public.assignments(id) on delete set null,
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  last_seq int not null default 0,
  allowed_until timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('user', 'time_up', 'stale', 'revoked', 'replaced')),
  charged_seconds int not null default 0
);
create index on public.sessions (candidate_id, started_at desc);
create unique index sessions_one_open_per_candidate on public.sessions (candidate_id) where ended_at is null;

create table public.time_ledger (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  seconds int not null check (seconds <> 0),
  reason text not null check (reason in ('grant', 'usage', 'adjust')),
  session_id uuid references public.sessions(id) on delete set null,
  idempotency_key text unique,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on public.time_ledger (candidate_id);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions(id) on delete set null,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  kind text not null check (kind in ('llm', 'stt')),
  model text,
  input_tokens int,
  output_tokens int,
  audio_seconds int,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);
create index on public.usage_events (candidate_id, created_at desc);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  score numeric(5, 2),
  feedback jsonb,
  created_at timestamptz not null default now()
);
create index on public.attempts (assignment_id);

create table public.session_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_log (org_id, created_at desc);

-- ─────────────────────── helpers for the rules ───────────────────────
-- SECURITY DEFINER so a policy can read staff/staff_teams without recursing
-- into those tables' own policies. They only ever answer about auth.uid().

create function app.my_org() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.org_id from public.staff s where s.user_id = auth.uid()
$$;

create function app.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select s.role from public.staff s where s.user_id = auth.uid()
$$;

create function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid() and s.role = 'admin')
$$;

-- May this staff member see the team? Admins see every team in their org;
-- managers and coaches see the teams they belong to.
create function app.sees_team(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    join public.teams t on t.org_id = s.org_id
    where s.user_id = auth.uid() and t.id = p_team
      and (s.role = 'admin' or exists (
        select 1 from public.staff_teams st where st.team_id = t.id and st.user_id = s.user_id))
  )
$$;

-- May this staff member change the team's candidates (minutes, slots,
-- assignments, invites, devices)? Admins and the team's managers; not coaches.
create function app.manages_team(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    join public.teams t on t.org_id = s.org_id
    where s.user_id = auth.uid() and t.id = p_team
      and (s.role = 'admin' or (s.role = 'manager' and exists (
        select 1 from public.staff_teams st where st.team_id = t.id and st.user_id = s.user_id)))
  )
$$;

create function app.sees_candidate(p_candidate uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.candidates c where c.id = p_candidate and app.sees_team(c.team_id))
$$;

create function app.manages_candidate(p_candidate uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.candidates c where c.id = p_candidate and app.manages_team(c.team_id))
$$;

create function app.balance_seconds(p_candidate uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.seconds), 0)::int from public.time_ledger l where l.candidate_id = p_candidate
$$;

create function app.audit(p_org uuid, p_action text, p_target_type text, p_target uuid, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (org_id, actor_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), p_action, p_target_type, p_target, p_details)
$$;

-- ─────────────────────────── row-level security ───────────────────────────

do $$
declare t text;
begin
  foreach t in array array['organizations','teams','staff','staff_teams','candidates','invites','devices',
    'device_tokens','slots','assignments','sessions','time_ledger','usage_events','attempts','session_comments','audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- The policy helpers are the only app.* functions a dashboard user may run
-- (policies execute them as the caller). Internal ones stay private.
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;
revoke execute on all functions in schema app from public;
grant execute on function app.my_org(), app.my_role(), app.is_admin(), app.sees_team(uuid), app.manages_team(uuid),
  app.sees_candidate(uuid), app.manages_candidate(uuid) to authenticated;

-- organizations: read your own; nobody edits through the API.
grant select on public.organizations to authenticated;
create policy org_read on public.organizations for select to authenticated using (id = app.my_org());

-- teams: everyone in the org reads; admins write.
grant select, insert, update, delete on public.teams to authenticated;
create policy teams_read on public.teams for select to authenticated using (org_id = app.my_org());
create policy teams_write on public.teams for all to authenticated
  using (org_id = app.my_org() and app.is_admin()) with check (org_id = app.my_org() and app.is_admin());

-- staff: everyone in the org reads; admins add, change and remove (never themselves out of admin).
grant select, insert, update, delete on public.staff to authenticated;
create policy staff_read on public.staff for select to authenticated using (org_id = app.my_org());
create policy staff_write on public.staff for all to authenticated
  using (org_id = app.my_org() and app.is_admin() and user_id <> auth.uid())
  with check (org_id = app.my_org() and app.is_admin() and user_id <> auth.uid());

grant select, insert, delete on public.staff_teams to authenticated;
create policy staff_teams_read on public.staff_teams for select to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id and t.org_id = app.my_org()));
create policy staff_teams_write on public.staff_teams for all to authenticated
  using (app.is_admin() and exists (select 1 from public.teams t where t.id = team_id and t.org_id = app.my_org()))
  with check (app.is_admin() and exists (select 1 from public.teams t where t.id = team_id and t.org_id = app.my_org()));

-- candidates: seen by their team's staff; created and changed by its managers.
grant select, insert, update on public.candidates to authenticated;
create policy candidates_read on public.candidates for select to authenticated using (app.sees_team(team_id));
create policy candidates_insert on public.candidates for insert to authenticated
  with check (org_id = app.my_org() and app.manages_team(team_id) and created_by = auth.uid());
create policy candidates_update on public.candidates for update to authenticated
  using (app.manages_team(team_id)) with check (org_id = app.my_org() and app.manages_team(team_id));

-- invites: read by the team; created only through pp_create_invite (the code is generated there).
grant select on public.invites to authenticated;
create policy invites_read on public.invites for select to authenticated using (app.sees_candidate(candidate_id));

-- devices: read by the team; revoked through pp_revoke_device.
grant select on public.devices to authenticated;
create policy devices_read on public.devices for select to authenticated using (app.sees_candidate(candidate_id));

-- device_tokens: never readable through the API.

-- slots and assignments: read by the team, written by its managers.
grant select, insert, update, delete on public.slots to authenticated;
create policy slots_read on public.slots for select to authenticated using (app.sees_candidate(candidate_id));
create policy slots_write on public.slots for all to authenticated
  using (app.manages_candidate(candidate_id)) with check (app.manages_candidate(candidate_id) and created_by = auth.uid());

grant select, insert, update, delete on public.assignments to authenticated;
create policy assignments_read on public.assignments for select to authenticated using (app.sees_candidate(candidate_id));
create policy assignments_write on public.assignments for all to authenticated
  using (app.manages_candidate(candidate_id)) with check (app.manages_candidate(candidate_id) and created_by = auth.uid());

-- sessions, ledger, usage, attempts: read by the team; written only by the server.
grant select on public.sessions, public.time_ledger, public.usage_events to authenticated;
create policy sessions_read on public.sessions for select to authenticated using (app.sees_candidate(candidate_id));
create policy ledger_read on public.time_ledger for select to authenticated using (app.sees_candidate(candidate_id));
create policy usage_read on public.usage_events for select to authenticated using (app.sees_candidate(candidate_id));
grant select on public.attempts to authenticated;
create policy attempts_read on public.attempts for select to authenticated
  using (exists (select 1 from public.assignments a where a.id = assignment_id and app.sees_candidate(a.candidate_id)));

-- comments: anyone who sees the session (coaches included) reads and writes their own.
grant select, insert on public.session_comments to authenticated;
create policy comments_read on public.session_comments for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and app.sees_candidate(s.candidate_id)));
create policy comments_insert on public.session_comments for insert to authenticated
  with check (author_id = auth.uid()
    and exists (select 1 from public.sessions s where s.id = session_id and app.sees_candidate(s.candidate_id)));

-- audit log: admins read their org's.
grant select on public.audit_log to authenticated;
create policy audit_read on public.audit_log for select to authenticated using (org_id = app.my_org() and app.is_admin());

-- ───────────────── dashboard actions (staff, checked inside) ─────────────────

-- A one-time invite code for a candidate, shown once. Format XXXX-XXXX-XXXX-XXXX
-- (64 random bits); only its SHA-256 is stored.
create function public.pp_create_invite(p_candidate uuid, p_ttl_days int default 7)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_raw text;
  v_code text;
begin
  if not app.manages_candidate(p_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_ttl_days not between 1 and 30 then raise exception 'ttl_days must be 1-30'; end if;
  select org_id into v_org from public.candidates where id = p_candidate and status <> 'archived';
  if v_org is null then raise exception 'candidate not found or archived'; end if;
  v_raw := upper(replace(gen_random_uuid()::text, '-', ''));
  -- Skip the UUID version nibble (position 13) so all 16 characters are random.
  v_raw := substr(v_raw, 1, 12) || substr(v_raw, 14, 4);
  v_code := substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' || substr(v_raw, 9, 4) || '-' || substr(v_raw, 13, 4);
  insert into public.invites (candidate_id, code_hash, expires_at, created_by)
  values (p_candidate, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), now() + make_interval(days => p_ttl_days), auth.uid());
  perform app.audit(v_org, 'invite.create', 'candidate', p_candidate, jsonb_build_object('ttl_days', p_ttl_days));
  return v_code;
end $$;

-- Give (positive) or take back (negative) minutes.
create function public.pp_grant_minutes(p_candidate uuid, p_minutes int, p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if not app.manages_candidate(p_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_minutes = 0 or abs(p_minutes) > 100000 then raise exception 'minutes must be non-zero and at most 100000'; end if;
  select org_id into v_org from public.candidates where id = p_candidate;
  insert into public.time_ledger (candidate_id, seconds, reason, note, created_by)
  values (p_candidate, p_minutes * 60, case when p_minutes > 0 then 'grant' else 'adjust' end, p_note, auth.uid());
  perform app.audit(v_org, 'minutes.grant', 'candidate', p_candidate, jsonb_build_object('minutes', p_minutes, 'note', p_note));
  return app.balance_seconds(p_candidate);
end $$;

create function public.pp_revoke_device(p_device uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_candidate uuid; v_org uuid;
begin
  select d.candidate_id, c.org_id into v_candidate, v_org
  from public.devices d join public.candidates c on c.id = d.candidate_id where d.id = p_device;
  if v_candidate is null or not app.manages_candidate(v_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.devices set revoked_at = coalesce(revoked_at, now()) where id = p_device;
  update public.device_tokens set revoked_at = coalesce(revoked_at, now()) where device_id = p_device;
  update public.sessions set ended_at = now(), end_reason = 'revoked' where device_id = p_device and ended_at is null;
  perform app.audit(v_org, 'device.revoke', 'device', p_device, null);
end $$;

-- Minutes left, for the dashboard.
create function public.pp_candidate_balance(p_candidate uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.sees_candidate(p_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  return app.balance_seconds(p_candidate) / 60;
end $$;

revoke execute on function public.pp_create_invite(uuid, int), public.pp_grant_minutes(uuid, int, text),
  public.pp_revoke_device(uuid), public.pp_candidate_balance(uuid) from public, anon;
grant execute on function public.pp_create_invite(uuid, int), public.pp_grant_minutes(uuid, int, text),
  public.pp_revoke_device(uuid), public.pp_candidate_balance(uuid) to authenticated;

-- ───────────── device actions (service role only, via the api function) ─────────────
-- Tokens are generated in the Edge Function; only their hashes reach here.
-- p_now exists for tests; the Edge Function never passes it.

create function public.pp_redeem_invite(
  p_code_hash text, p_device_name text, p_platform text, p_app_version text,
  p_access_hash text, p_refresh_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_invite public.invites; v_device uuid; v_org uuid;
begin
  select * into v_invite from public.invites where code_hash = p_code_hash for update;
  if v_invite.id is null then return jsonb_build_object('error', 'invalid_code'); end if;
  if v_invite.redeemed_at is not null then return jsonb_build_object('error', 'code_used'); end if;
  if v_invite.expires_at <= p_now then return jsonb_build_object('error', 'code_expired'); end if;
  select org_id into v_org from public.candidates where id = v_invite.candidate_id and status <> 'archived';
  if v_org is null then return jsonb_build_object('error', 'invalid_code'); end if;

  update public.invites set redeemed_at = p_now where id = v_invite.id;
  update public.candidates set status = 'active' where id = v_invite.candidate_id and status = 'invited';
  insert into public.devices (candidate_id, name, platform, app_version, last_seen_at)
  values (v_invite.candidate_id, left(p_device_name, 200),
          case when p_platform in ('darwin', 'win32', 'linux') then p_platform end, left(p_app_version, 50), p_now)
  returning id into v_device;
  insert into public.device_tokens (device_id, kind, token_hash, expires_at) values
    (v_device, 'access', p_access_hash, p_now + interval '15 minutes'),
    (v_device, 'refresh', p_refresh_hash, p_now + interval '30 days');
  insert into public.audit_log (org_id, action, target_type, target_id, details)
  values (v_org, 'invite.redeem', 'device', v_device, jsonb_build_object('platform', p_platform));
  return jsonb_build_object('device_id', v_device, 'candidate_id', v_invite.candidate_id,
    'access_expires_at', p_now + interval '15 minutes', 'refresh_expires_at', p_now + interval '30 days');
end $$;

create function public.pp_refresh(
  p_refresh_hash text, p_new_access_hash text, p_new_refresh_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tok public.device_tokens; v_dev public.devices;
begin
  select * into v_tok from public.device_tokens where token_hash = p_refresh_hash and kind = 'refresh' for update;
  if v_tok.id is null then return jsonb_build_object('error', 'invalid_token'); end if;
  select * into v_dev from public.devices where id = v_tok.device_id;
  if v_dev.revoked_at is not null or v_tok.revoked_at is not null then return jsonb_build_object('error', 'device_revoked'); end if;
  if v_tok.used_at is not null then
    -- A refresh token presented twice was copied: shut the device out.
    update public.devices set revoked_at = p_now where id = v_dev.id;
    update public.device_tokens set revoked_at = coalesce(revoked_at, p_now) where device_id = v_dev.id;
    update public.sessions set ended_at = p_now, end_reason = 'revoked' where device_id = v_dev.id and ended_at is null;
    insert into public.audit_log (org_id, action, target_type, target_id)
    select c.org_id, 'device.refresh_reuse', 'device', v_dev.id from public.candidates c where c.id = v_dev.candidate_id;
    return jsonb_build_object('error', 'device_revoked');
  end if;
  if v_tok.expires_at <= p_now then return jsonb_build_object('error', 'invalid_token'); end if;

  update public.device_tokens set used_at = p_now where id = v_tok.id;
  -- The old access token stops working once a new one exists.
  update public.device_tokens set revoked_at = p_now
  where device_id = v_dev.id and kind = 'access' and revoked_at is null;
  insert into public.device_tokens (device_id, kind, token_hash, expires_at) values
    (v_dev.id, 'access', p_new_access_hash, p_now + interval '15 minutes'),
    (v_dev.id, 'refresh', p_new_refresh_hash, p_now + interval '30 days');
  update public.devices set last_seen_at = p_now where id = v_dev.id;
  return jsonb_build_object('device_id', v_dev.id, 'candidate_id', v_dev.candidate_id,
    'access_expires_at', p_now + interval '15 minutes', 'refresh_expires_at', p_now + interval '30 days');
end $$;

create function public.pp_authenticate(p_access_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tok public.device_tokens; v_dev public.devices; v_status text;
begin
  select * into v_tok from public.device_tokens where token_hash = p_access_hash and kind = 'access';
  if v_tok.id is null or v_tok.expires_at <= p_now then return jsonb_build_object('error', 'invalid_token'); end if;
  select * into v_dev from public.devices where id = v_tok.device_id;
  if v_dev.revoked_at is not null then return jsonb_build_object('error', 'device_revoked'); end if;
  -- Replaced by a refresh: the app should refresh, not be told it was revoked.
  if v_tok.revoked_at is not null then return jsonb_build_object('error', 'invalid_token'); end if;
  select status into v_status from public.candidates where id = v_dev.candidate_id;
  if v_status = 'archived' then return jsonb_build_object('error', 'device_revoked'); end if;
  update public.devices set last_seen_at = p_now where id = v_dev.id and (last_seen_at is null or last_seen_at < p_now - interval '1 minute');
  return jsonb_build_object('device_id', v_dev.id, 'candidate_id', v_dev.candidate_id);
end $$;

-- How long a session may run: to the end of the slot, the end of the
-- candidate's minutes, or the assignment's time limit, whichever is first.
create function app.allowed_until(p_candidate uuid, p_slot_end timestamptz, p_session_start timestamptz,
  p_limit_minutes int, p_now timestamptz)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select least(
    p_slot_end,
    p_now + make_interval(secs => greatest(app.balance_seconds(p_candidate), 0)),
    case when p_limit_minutes is null then 'infinity'::timestamptz
         else p_session_start + make_interval(mins => p_limit_minutes) end)
$$;

-- Seconds between heartbeats, at most. A longer silence ends the session as
-- stale, and the silence itself is not charged.
create function app.stale_after() returns interval language sql immutable as $$ select interval '90 seconds' $$;

-- Charges an open session up to p_now (or ends it as stale), once per seq.
create function app.charge_session(p_session uuid, p_seq int, p_now timestamptz)
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
  select s.ends_at into v_slot_end from public.slots s where s.id = v.slot_id;
  select a.time_limit_minutes into v_limit from public.assignments a where a.id = v.assignment_id;
  update public.sessions set
    last_heartbeat_at = p_now, last_seq = p_seq, charged_seconds = charged_seconds + v_elapsed,
    -- Recomputed each time, so minutes given mid-session extend it (never past
    -- the slot or the assignment's limit).
    allowed_until = app.allowed_until(v.candidate_id, coalesce(v_slot_end, v.allowed_until), v.started_at, v_limit, p_now)
  where id = v.id returning * into v;
  if p_now >= v.allowed_until then
    update public.sessions set ended_at = v.allowed_until, end_reason = 'time_up' where id = v.id returning * into v;
  end if;
  return v;
end $$;

create function app.session_view(v public.sessions, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session_id', v.id, 'status', case when v.ended_at is null then 'open' else 'ended' end,
    'end_reason', v.end_reason, 'allowed_until', v.allowed_until,
    'seconds_left', greatest(0, floor(extract(epoch from (v.allowed_until - p_now))))::int,
    'balance_seconds', app.balance_seconds(v.candidate_id), 'last_seq', v.last_seq)
$$;

create function public.pp_session_start(p_device uuid, p_assignment uuid default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices; v_slot public.slots; v_assign public.assignments; v_open public.sessions;
  v_balance int; v_until timestamptz; v_used int; v_session public.sessions;
begin
  select * into v_dev from public.devices where id = p_device;
  if v_dev.id is null or v_dev.revoked_at is not null then return jsonb_build_object('error', 'device_revoked'); end if;

  -- Serialize starts per candidate, then settle any open session first: a
  -- live one on this device is resumed, anything else is closed.
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
  if v_slot.id is null then return jsonb_build_object('error', 'no_active_slot'); end if;

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

  v_until := app.allowed_until(v_dev.candidate_id, v_slot.ends_at, p_now, v_assign.time_limit_minutes, p_now);
  insert into public.sessions (candidate_id, device_id, slot_id, assignment_id, started_at, last_heartbeat_at, allowed_until)
  values (v_dev.candidate_id, p_device, v_slot.id, p_assignment, p_now, p_now, v_until)
  returning * into v_session;
  return app.session_view(v_session, p_now);
end $$;

create function public.pp_session_heartbeat(p_device uuid, p_session uuid, p_seq int, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.sessions;
begin
  select * into v from public.sessions where id = p_session and device_id = p_device;
  if v.id is null then return jsonb_build_object('error', 'session_not_found'); end if;
  if p_seq < 1 then return jsonb_build_object('error', 'bad_seq'); end if;
  v := app.charge_session(p_session, p_seq, p_now);
  return app.session_view(v, p_now);
end $$;

create function public.pp_session_end(p_device uuid, p_session uuid, p_seq int, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.sessions;
begin
  select * into v from public.sessions where id = p_session and device_id = p_device;
  if v.id is null then return jsonb_build_object('error', 'session_not_found'); end if;
  v := app.charge_session(p_session, p_seq, p_now);
  if v.ended_at is null then
    update public.sessions set ended_at = p_now, end_reason = 'user' where id = v.id returning * into v;
  end if;
  return app.session_view(v, p_now);
end $$;

-- May this device make an AI or transcription call now? A call that starts in
-- time runs to completion, so the answer in progress at the end is finished.
create function public.pp_authorize_call(p_device uuid, p_session uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.sessions;
begin
  select * into v from public.sessions where id = p_session and device_id = p_device;
  if v.id is null then return jsonb_build_object('error', 'session_not_found'); end if;
  if v.ended_at is not null then
    return jsonb_build_object('error', case when v.end_reason = 'revoked' then 'device_revoked' else 'session_ended' end,
      'end_reason', v.end_reason);
  end if;
  if p_now - v.last_heartbeat_at > app.stale_after() then return jsonb_build_object('error', 'session_stale'); end if;
  if p_now >= v.allowed_until then return jsonb_build_object('error', 'time_up'); end if;
  return jsonb_build_object('ok', true, 'candidate_id', v.candidate_id, 'seconds_left',
    floor(extract(epoch from (v.allowed_until - p_now)))::int);
end $$;

create function public.pp_record_usage(p_session uuid, p_kind text, p_model text, p_input int, p_output int,
  p_audio_seconds int, p_cost numeric)
returns void language sql security definer set search_path = '' as $$
  insert into public.usage_events (session_id, candidate_id, kind, model, input_tokens, output_tokens, audio_seconds, cost_usd)
  select s.id, s.candidate_id, p_kind, p_model, p_input, p_output, p_audio_seconds, p_cost
  from public.sessions s where s.id = p_session
$$;

-- What the app shows when idle: next slot, minutes left, open assignments.
create function public.pp_device_status(p_device uuid, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'candidate', jsonb_build_object('id', c.id, 'name', c.name),
    'balance_seconds', app.balance_seconds(c.id),
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
  from public.devices d join public.candidates c on c.id = d.candidate_id
  where d.id = p_device and d.revoked_at is null
$$;

-- Only the server (service_role) may call the device functions.
do $$
declare f text;
begin
  foreach f in array array[
    'public.pp_redeem_invite(text, text, text, text, text, text, timestamptz)',
    'public.pp_refresh(text, text, text, timestamptz)',
    'public.pp_authenticate(text, timestamptz)',
    'public.pp_session_start(uuid, uuid, timestamptz)',
    'public.pp_session_heartbeat(uuid, uuid, int, timestamptz)',
    'public.pp_session_end(uuid, uuid, int, timestamptz)',
    'public.pp_authorize_call(uuid, uuid, timestamptz)',
    'public.pp_record_usage(uuid, text, text, int, int, int, numeric)',
    'public.pp_device_status(uuid, timestamptz)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- First organization and admin, run once from the SQL editor after the admin
-- has signed up in Supabase Auth (see cloud/README.md).
create function public.pp_bootstrap_org(p_org_name text, p_admin_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_org uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(p_admin_email);
  if v_user is null then raise exception 'no auth user with email %', p_admin_email; end if;
  if exists (select 1 from public.staff where user_id = v_user) then raise exception 'already staff'; end if;
  insert into public.organizations (name) values (p_org_name) returning id into v_org;
  insert into public.staff (user_id, org_id, role) values (v_user, v_org, 'admin');
  return v_org;
end $$;
revoke execute on function public.pp_bootstrap_org(text, text) from public, anon, authenticated;
