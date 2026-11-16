-- Invite codes a manager can see again and delete.
--
-- Until now only the code's SHA-256 was stored, so a code was shown once and
-- lost if the manager closed the dialog. The code is now also kept in
-- `invites.code` while it is waiting; it is wiped the moment the code is used.
-- Nobody reads the column directly: managers of the candidate read it through
-- pp_reveal_invite, and the table's select grant excludes it.

alter table public.invites add column code text;

-- The dashboard reads invites with a plain select; leave `code` (and the hash)
-- out of what it may read.
revoke select on public.invites from authenticated;
grant select (id, candidate_id, expires_at, redeemed_at, created_by, created_at) on public.invites to authenticated;

-- Wipe the readable code once the invite is used.
create function app.invites_wipe_used_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.redeemed_at is not null then new.code := null; end if;
  return new;
end $$;
create trigger invites_wipe_used_code before insert or update on public.invites
  for each row execute function app.invites_wipe_used_code();

-- Same as before, and the code is kept for pp_reveal_invite.
create or replace function public.pp_create_invite(p_candidate uuid, p_ttl_days int default 7)
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
  insert into public.invites (candidate_id, code_hash, code, expires_at, created_by)
  values (p_candidate, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_code, now() + make_interval(days => p_ttl_days), auth.uid());
  perform app.audit(v_org, 'invite.create', 'candidate', p_candidate, jsonb_build_object('ttl_days', p_ttl_days));
  return v_code;
end $$;

-- The code of a waiting invite, for the candidate's managers. Null once it is
-- used, or for codes made before codes were kept.
create function public.pp_reveal_invite(p_invite uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_inv public.invites;
begin
  select * into v_inv from public.invites where id = p_invite;
  if v_inv.id is null or not app.manages_candidate(v_inv.candidate_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_inv.code;
end $$;

-- Delete an invite code. A waiting code stops working at once; deleting a used
-- one only removes it from the list (the computer it signed in stays signed in;
-- sign that out under Computers).
create function public.pp_delete_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inv public.invites; v_org uuid;
begin
  select * into v_inv from public.invites where id = p_invite;
  if v_inv.id is null or not app.manages_candidate(v_inv.candidate_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select org_id into v_org from public.candidates where id = v_inv.candidate_id;
  delete from public.invites where id = p_invite;
  perform app.audit(v_org, 'invite.delete', 'candidate', v_inv.candidate_id,
    jsonb_build_object('was', case when v_inv.redeemed_at is not null then 'used' when v_inv.expires_at <= now() then 'expired' else 'waiting' end));
end $$;

revoke execute on function public.pp_reveal_invite(uuid), public.pp_delete_invite(uuid) from public, anon;
grant execute on function public.pp_reveal_invite(uuid), public.pp_delete_invite(uuid) to authenticated;
