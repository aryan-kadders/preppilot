-- Which AI answers each organization's candidates.
--
-- 'standard': Claude Haiku 5.5 first: fast and very cheap (about $0.02 per
--             interview hour).
-- 'premium':  Claude Sonnet 5.5 first: the best spoken answers in our blind
--             test, especially behavioural ones (about $0.20-0.40 per hour).
-- The model lists themselves live in the server (functions/_shared/models.ts);
-- the organization only picks the plan. An admin changes it on the dashboard.

alter table public.organizations add column ai_quality text not null default 'standard'
  check (ai_quality in ('standard', 'premium'));

create function public.pp_set_ai_quality(p_quality text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.my_org();
begin
  if v_org is null or not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_quality is null or p_quality not in ('standard', 'premium') then raise exception 'ai_quality must be standard or premium'; end if;
  update public.organizations set ai_quality = p_quality where id = v_org;
  perform app.audit(v_org, 'org.ai_quality', 'organization', v_org, jsonb_build_object('ai_quality', p_quality));
end $$;
revoke execute on function public.pp_set_ai_quality(text) from public, anon;
grant execute on function public.pp_set_ai_quality(text) to authenticated;

-- Same as before, plus the organization's AI plan.
create or replace function public.pp_whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_owner', app.is_owner(),
    'role', app.my_role(),
    'org_id', o.id,
    'org_name', o.name,
    'require_slots', o.require_slots,
    'ai_quality', o.ai_quality,
    'display_name', (select s.display_name from public.staff s where s.user_id = auth.uid()))
  from (select 1) one
  left join public.organizations o on o.id = app.my_org()
$$;

-- Same as before, plus the candidate's organization's AI plan, so the server
-- picks the model without another round trip.
create or replace function public.pp_authorize_call(p_device uuid, p_session uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.sessions; v_quality text;
begin
  select * into v from public.sessions where id = p_session and device_id = p_device;
  if v.id is null then return jsonb_build_object('error', 'session_not_found'); end if;
  if v.ended_at is not null then
    return jsonb_build_object('error', case when v.end_reason = 'revoked' then 'device_revoked' else 'session_ended' end,
      'end_reason', v.end_reason);
  end if;
  if p_now - v.last_heartbeat_at > app.stale_after() then return jsonb_build_object('error', 'session_stale'); end if;
  if p_now >= v.allowed_until then return jsonb_build_object('error', 'time_up'); end if;
  select o.ai_quality into v_quality
  from public.candidates c join public.organizations o on o.id = c.org_id where c.id = v.candidate_id;
  return jsonb_build_object('ok', true, 'candidate_id', v.candidate_id, 'seconds_left',
    floor(extract(epoch from (v.allowed_until - p_now)))::int, 'ai_quality', coalesce(v_quality, 'standard'));
end $$;
