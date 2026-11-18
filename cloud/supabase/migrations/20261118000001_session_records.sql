-- What happened in each session: the transcript, PrepPilot's answers and the
-- summary of a meeting, or a mock interview's questions, scores and report.
--
-- The app uploads one record when a meeting's notes are saved or a mock
-- interview finishes (candidates are told their sessions are shared with their
-- team). Staff who see the candidate read the list; opening a record goes
-- through pp_open_session_record, which writes the audit log. Records are kept
-- 90 days: expired rows are hidden at once and deleted on the next upload.

create table public.session_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  kind text not null check (kind in ('meeting', 'practice')),
  -- The app's own id for it (meeting id or practice session id): one record each.
  local_id text not null check (length(local_id) between 1 and 200),
  title text check (title is null or length(title) <= 300),
  started_at timestamptz not null,
  duration_seconds int check (duration_seconds is null or duration_seconds between 0 and 86400),
  line_count int not null default 0,
  answer_count int not null default 0,
  score numeric(5, 2),
  content jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  unique (candidate_id, kind, local_id)
);
create index on public.session_records (candidate_id, started_at desc);
create index on public.session_records (org_id, started_at desc);
create index on public.session_records (session_id);
create index on public.session_records (expires_at);

alter table public.session_records enable row level security;
revoke all on public.session_records from anon, authenticated;
-- The list only: the content is read through pp_open_session_record.
grant select (id, org_id, candidate_id, session_id, kind, title, started_at, duration_seconds,
  line_count, answer_count, score, created_at, updated_at, expires_at) on public.session_records to authenticated;
create policy session_records_read on public.session_records for select to authenticated
  using (app.sees_candidate(candidate_id) and expires_at > now());

-- The app's upload (service role only, after the device is authenticated).
-- Same record again (notes regenerated, upload retried): replaced, same id.
-- No session given: the candidate's session that started closest to it, within 15 minutes.
create function public.pp_save_session_record(p_device uuid, p_kind text, p_local_id text, p_title text,
  p_started_at timestamptz, p_duration_seconds int, p_line_count int, p_answer_count int, p_score numeric,
  p_content jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cand uuid; v_org uuid; v_session uuid; v_id uuid;
begin
  select c.id, c.org_id into v_cand, v_org
  from public.devices d join public.candidates c on c.id = d.candidate_id
  where d.id = p_device and d.revoked_at is null and c.status <> 'archived';
  if v_cand is null then return jsonb_build_object('error', 'device_revoked'); end if;
  if p_kind is null or p_kind not in ('meeting', 'practice') then return jsonb_build_object('error', 'bad_kind'); end if;
  if p_local_id is null or length(p_local_id) not between 1 and 200 then return jsonb_build_object('error', 'bad_local_id'); end if;
  if p_started_at is null or p_content is null or jsonb_typeof(p_content) <> 'object' then
    return jsonb_build_object('error', 'bad_request');
  end if;

  select s.id into v_session from public.sessions s
  where s.candidate_id = v_cand
    and s.started_at between p_started_at - interval '15 minutes' and p_started_at + interval '15 minutes'
  order by abs(extract(epoch from (s.started_at - p_started_at))) limit 1;

  insert into public.session_records as r (org_id, candidate_id, session_id, kind, local_id, title, started_at,
    duration_seconds, line_count, answer_count, score, content, created_at, updated_at, expires_at)
  values (v_org, v_cand, v_session, p_kind, p_local_id, left(nullif(trim(p_title), ''), 300), p_started_at,
    p_duration_seconds, greatest(coalesce(p_line_count, 0), 0), greatest(coalesce(p_answer_count, 0), 0), p_score,
    p_content, p_now, p_now, p_now + interval '90 days')
  on conflict (candidate_id, kind, local_id) do update set
    session_id = coalesce(excluded.session_id, r.session_id), title = excluded.title, started_at = excluded.started_at,
    duration_seconds = excluded.duration_seconds, line_count = excluded.line_count, answer_count = excluded.answer_count,
    score = excluded.score, content = excluded.content, updated_at = p_now
  returning id into v_id;

  -- Retention: everything past its 90 days goes (already hidden from the dashboard).
  delete from public.session_records where expires_at <= p_now;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke execute on function public.pp_save_session_record(uuid, text, text, text, timestamptz, int, int, int, numeric, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pp_save_session_record(uuid, text, text, text, timestamptz, int, int, int, numeric, jsonb, timestamptz)
  to service_role;

-- One record with its content, for staff who see the candidate. Every opening is audited.
create function public.pp_open_session_record(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.session_records; v_name text;
begin
  select * into v from public.session_records where id = p_id and expires_at > now();
  if v.id is null or not app.sees_candidate(v.candidate_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  select name into v_name from public.candidates where id = v.candidate_id;
  perform app.audit(v.org_id, 'session_record.view', 'session_record', v.id,
    jsonb_build_object('candidate_id', v.candidate_id, 'kind', v.kind));
  return jsonb_build_object(
    'id', v.id, 'candidate_id', v.candidate_id, 'candidate_name', v_name, 'session_id', v.session_id,
    'kind', v.kind, 'title', v.title, 'started_at', v.started_at, 'duration_seconds', v.duration_seconds,
    'line_count', v.line_count, 'answer_count', v.answer_count, 'score', v.score,
    'content', v.content, 'created_at', v.created_at, 'updated_at', v.updated_at, 'expires_at', v.expires_at,
    'can_delete', app.manages_candidate(v.candidate_id));
end $$;
revoke execute on function public.pp_open_session_record(uuid) from public, anon;
grant execute on function public.pp_open_session_record(uuid) to authenticated;

-- Delete before the 90 days: admins and the candidate's team managers (not coaches).
create function public.pp_delete_session_record(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.session_records;
begin
  select * into v from public.session_records where id = p_id;
  if v.id is null or not app.manages_candidate(v.candidate_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.session_records where id = p_id;
  perform app.audit(v.org_id, 'session_record.delete', 'session_record', v.id,
    jsonb_build_object('candidate_id', v.candidate_id, 'kind', v.kind, 'title', v.title));
end $$;
revoke execute on function public.pp_delete_session_record(uuid) from public, anon;
grant execute on function public.pp_delete_session_record(uuid) to authenticated;
