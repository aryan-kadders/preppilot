-- PrepPilot Cloud, manager dashboard (Phase 3).
--
-- Read models for the dashboard and the one staff action that needs the
-- service role. Everything here reads through the caller's row-level
-- security (security_invoker views, SECURITY INVOKER functions), so a manager
-- sees only their teams and an admin their organization, exactly as with the
-- tables themselves.

-- One row per candidate the caller may see: minutes, slots, recent use.
create view public.candidate_overview with (security_invoker = true) as
select
  c.id, c.org_id, c.team_id, t.name as team_name, c.name, c.email, c.status, c.created_at,
  coalesce((select sum(l.seconds) from public.time_ledger l where l.candidate_id = c.id), 0)::int as balance_seconds,
  (select jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at) from public.slots s
     where s.candidate_id = c.id and s.starts_at <= now() and s.ends_at > now() order by s.ends_at desc limit 1) as current_slot,
  (select jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at) from public.slots s
     where s.candidate_id = c.id and s.starts_at > now() order by s.starts_at limit 1) as next_slot,
  (select max(x.started_at) from public.sessions x where x.candidate_id = c.id) as last_session_at,
  exists (select 1 from public.sessions x where x.candidate_id = c.id and x.ended_at is null
     and x.last_heartbeat_at > now() - interval '90 seconds') as in_session,
  coalesce((select -sum(l.seconds) from public.time_ledger l
     where l.candidate_id = c.id and l.reason = 'usage' and l.created_at > now() - interval '7 days'), 0)::int as used_seconds_7d,
  (select count(*) from public.devices d where d.candidate_id = c.id and d.revoked_at is null)::int as active_devices
from public.candidates c
join public.teams t on t.id = c.team_id;

grant select on public.candidate_overview to authenticated;

-- Minutes, sessions, AI calls and cost per candidate between two times.
create function public.pp_usage_report(p_from timestamptz, p_to timestamptz)
returns table (
  candidate_id uuid, candidate_name text, team_name text,
  sessions int, used_seconds int, ai_calls int, input_tokens bigint, output_tokens bigint, cost_usd numeric
)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.name, t.name,
    (select count(*) from public.sessions s where s.candidate_id = c.id and s.started_at >= p_from and s.started_at < p_to)::int,
    coalesce((select -sum(l.seconds) from public.time_ledger l
      where l.candidate_id = c.id and l.reason = 'usage' and l.created_at >= p_from and l.created_at < p_to), 0)::int,
    (select count(*) from public.usage_events u where u.candidate_id = c.id and u.kind = 'llm' and u.created_at >= p_from and u.created_at < p_to)::int,
    coalesce((select sum(u.input_tokens) from public.usage_events u where u.candidate_id = c.id and u.created_at >= p_from and u.created_at < p_to), 0)::bigint,
    coalesce((select sum(u.output_tokens) from public.usage_events u where u.candidate_id = c.id and u.created_at >= p_from and u.created_at < p_to), 0)::bigint,
    coalesce((select sum(u.cost_usd) from public.usage_events u where u.candidate_id = c.id and u.created_at >= p_from and u.created_at < p_to), 0)
  from public.candidates c
  join public.teams t on t.id = c.team_id
  order by t.name, c.name
$$;

revoke execute on function public.pp_usage_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.pp_usage_report(timestamptz, timestamptz) to authenticated;

-- Adds a person to the admin's organization as staff. Called by the `api`
-- function (service role) after it has created the person's sign-in link, with
-- the verified id of the admin who asked; the admin check happens here.
create function public.pp_admin_add_staff(p_admin uuid, p_user uuid, p_role text, p_team_ids uuid[], p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_team uuid;
begin
  select org_id into v_org from public.staff where user_id = p_admin and role = 'admin';
  if v_org is null then return jsonb_build_object('error', 'forbidden'); end if;
  if p_role not in ('admin', 'manager', 'coach') then return jsonb_build_object('error', 'bad_role'); end if;
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

revoke execute on function public.pp_admin_add_staff(uuid, uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function public.pp_admin_add_staff(uuid, uuid, text, uuid[], text) to service_role;

-- Archiving a candidate signs out all their devices and ends any session.
create function public.pp_archive_candidate(p_candidate uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if not app.manages_candidate(p_candidate) then raise exception 'forbidden' using errcode = '42501'; end if;
  select org_id into v_org from public.candidates where id = p_candidate;
  update public.candidates set status = 'archived' where id = p_candidate;
  update public.devices set revoked_at = coalesce(revoked_at, now()) where candidate_id = p_candidate;
  update public.device_tokens set revoked_at = coalesce(revoked_at, now())
    where device_id in (select id from public.devices where candidate_id = p_candidate);
  update public.sessions set ended_at = now(), end_reason = 'revoked' where candidate_id = p_candidate and ended_at is null;
  perform app.audit(v_org, 'candidate.archive', 'candidate', p_candidate, null);
end $$;

revoke execute on function public.pp_archive_candidate(uuid) from public, anon;
grant execute on function public.pp_archive_candidate(uuid) to authenticated;

-- The role of a signed-in person (null when not staff), for the `api`
-- function's staff routes; checked before any sign-in link is created.
create function public.pp_staff_role(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.staff where user_id = p_user
$$;
revoke execute on function public.pp_staff_role(uuid) from public, anon, authenticated;
grant execute on function public.pp_staff_role(uuid) to service_role;
