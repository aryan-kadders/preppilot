-- AI calls outside a running session: a meeting's notes after Stop, and mock
-- interview questions and feedback. They use no practice minutes, but their
-- cost is recorded for the candidate (usage_events with no session), and each
-- candidate gets at most 60 such calls an hour (a mock interview or a set of
-- notes takes about 10 to 15).

create function public.pp_authorize_offsession(p_device uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cand uuid; v_quality text; v_recent int;
begin
  select c.id, o.ai_quality into v_cand, v_quality
  from public.devices d
  join public.candidates c on c.id = d.candidate_id
  join public.organizations o on o.id = c.org_id
  where d.id = p_device and d.revoked_at is null and c.status <> 'archived';
  if v_cand is null then return jsonb_build_object('error', 'device_revoked'); end if;
  select count(*) into v_recent from public.usage_events
  where candidate_id = v_cand and session_id is null and kind = 'llm' and created_at > p_now - interval '1 hour';
  if v_recent >= 60 then return jsonb_build_object('error', 'offsession_limit'); end if;
  return jsonb_build_object('ok', true, 'candidate_id', v_cand, 'ai_quality', coalesce(v_quality, 'standard'));
end $$;

create function public.pp_record_offsession_usage(p_candidate uuid, p_kind text, p_model text, p_input int, p_output int,
  p_audio_seconds int, p_cost numeric)
returns void language sql security definer set search_path = '' as $$
  insert into public.usage_events (session_id, candidate_id, kind, model, input_tokens, output_tokens, audio_seconds, cost_usd)
  select null, c.id, p_kind, p_model, p_input, p_output, p_audio_seconds, p_cost
  from public.candidates c where c.id = p_candidate
$$;

revoke execute on function public.pp_authorize_offsession(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.pp_authorize_offsession(uuid, timestamptz) to service_role;
revoke execute on function public.pp_record_offsession_usage(uuid, text, text, int, int, int, numeric) from public, anon, authenticated;
grant execute on function public.pp_record_offsession_usage(uuid, text, text, int, int, int, numeric) to service_role;
