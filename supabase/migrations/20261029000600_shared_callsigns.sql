-- Accounts may share a callsign. A club account and its owner's own account, or two accounts made
-- with different emails or providers, can hold the same call, so nothing refuses a callsign another
-- profile holds any more. Signing in is by email only (the sign-in function refuses anything else),
-- since a callsign no longer names one account.
--
-- Logged contacts still need one account per call: apply_logged_contacts takes an upsert only from
-- the profile that has held its base call longest (callsign_since), as 20261029000300 did for the
-- pairs made before it, so a second account with W1AW (or W1AW/P) cannot post contacts as W1AW.
--
-- 1. profiles: drop the unique constraint on callsign and the base-call trigger with its function.
-- 2. profiles.callsign_since: when the profile took its base call, created_at for existing rows.
--    profiles_track_callsign_since resets it when an update changes the base call, so an older
--    account that switches to W1AW queues behind the account already holding it. Clients cannot
--    write it (the update grant names its columns).
-- 3. handle_new_user and complete_profile: as in 20261028000100, without the taken check. A
--    unique_violation in complete_profile can now only be a second profile for the caller.
-- 4. callsign_available: only the shape check, for web bundles loaded before this; the sign-up
--    form no longer calls it. email_for_identifier: emails only, for the sign-in function deployed
--    before this (a shared callsign would make its subquery raise). Both go in a later migration
--    once the web and the sign-in function are out.
-- 5. apply_logged_contacts: as in 20261029000300, ordering holders by (callsign_since, id).

-- ---------------------------------------------------------------------------
-- 1. No uniqueness
-- ---------------------------------------------------------------------------

alter table profiles drop constraint profiles_callsign_key;
drop trigger profiles_unique_base_callsign on profiles;
drop function public.profiles_check_base_callsign();

-- ---------------------------------------------------------------------------
-- 2. callsign_since
-- ---------------------------------------------------------------------------

alter table profiles add column callsign_since timestamptz;
update profiles set callsign_since = created_at;
alter table profiles alter column callsign_since set default now();
alter table profiles alter column callsign_since set not null;

-- Security definer because clients cannot execute base_callsign() and their own profile updates fire it.
create function public.profiles_track_callsign_since()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.base_callsign(new.callsign) is distinct from public.base_callsign(old.callsign) then
    new.callsign_since := now();
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_track_callsign_since() from public, anon, authenticated;

-- Named to sort after profiles_normalize_callsign, so it sees the upper-cased, trimmed call.
create trigger profiles_track_callsign_since
before update of callsign on profiles
for each row execute function public.profiles_track_callsign_since();

-- ---------------------------------------------------------------------------
-- 3. Sign-up
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_callsign text := upper(trim(new.raw_user_meta_data ->> 'callsign'));
  v_provider text := new.raw_app_meta_data ->> 'provider';
begin
  if v_callsign is null and v_provider is not null and v_provider <> 'email' then
    return new;
  end if;
  if v_callsign is null or v_callsign !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$' then
    raise exception 'Enter a valid amateur callsign.';
  end if;
  insert into profiles (id, callsign, name)
  values (new.id, v_callsign, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end;
$$;

create or replace function public.complete_profile(p_callsign text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_callsign text := upper(trim(p_callsign));
begin
  if v_user is null then
    raise exception 'Sign in again.';
  end if;
  if v_callsign is null or v_callsign !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$' then
    raise exception 'Enter a valid amateur callsign.';
  end if;
  if exists (select 1 from profiles p where p.id = v_user) then
    raise exception 'Your account is already set up.';
  end if;
  insert into profiles (id, callsign, name)
  values (v_user, v_callsign, coalesce(trim(p_name), ''));
exception
  when unique_violation then
    -- A second request for this user won the race.
    raise exception 'Your account is already set up.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Kept for deployed callers
-- ---------------------------------------------------------------------------

create or replace function public.callsign_available(p_callsign text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select upper(trim(p_callsign)) ~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$';
$$;

create or replace function public.email_for_identifier(p_identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when position('@' in p_identifier) > 0 then lower(trim(p_identifier)) end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Logged contacts: the longest holder of a base call
-- ---------------------------------------------------------------------------

create or replace function public.apply_logged_contacts(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_base    text;
  v_since   timestamptz;
  v_item    jsonb;
  v_op      text;
  v_ext     text;
  v_spot    jsonb;
  v_hash    text;
  v_row     logged_contacts%rowtype;
  v_found   boolean;
  v_spot_id bigint;
  v_status  text;
  v_stored  int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if p_user_id is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'apply_logged_contacts needs a user and a list of items.' using errcode = '22023';
  end if;

  -- One account's batches apply one at a time. The row lock below cannot cover a contact that has
  -- no row yet, so two requests storing different content for one new contact at once (a retry
  -- racing the request it retries) would each store a live spot and leave one never retracted.
  perform pg_advisory_xact_lock(hashtextextended('logged_contacts:' || p_user_id::text, 0));

  select public.base_callsign(p.callsign), p.callsign_since into v_base, v_since
  from profiles p where p.id = p_user_id;
  -- Profiles may share a base call: only the one that has held it longest posts as that base, so
  -- every other gets mycall_mismatch.
  if v_base is not null and exists (
       select 1 from profiles o
       where o.id <> p_user_id
         and public.base_callsign(o.callsign) = v_base
         and (o.callsign_since, o.id) < (v_since, p_user_id)) then
    v_base := null;
  end if;

  for v_item in
    select e.value from jsonb_array_elements(p_items) with ordinality as e(value, n) order by e.n
  loop
    v_op := v_item ->> 'op';
    v_ext := v_item ->> 'external_id';
    if v_op is null or v_op not in ('upsert', 'delete')
       or v_ext is null or char_length(v_ext) not between 1 and 256 then
      raise exception 'Not a logged contact item.' using errcode = '22023';
    end if;

    select * into v_row
    from logged_contacts c
    where c.user_id = p_user_id and c.external_id = v_ext
    for update;
    v_found := found;

    if v_op = 'delete' then
      if v_found and v_row.state = 'live' then
        update raw_spots set retracted_at = now() where id = v_row.spot_id;
        update logged_contacts
        set state = 'retracted', retracted_at = now(), updated_at = now()
        where user_id = p_user_id and external_id = v_ext;
        v_status := 'retracted';
      else
        v_status := 'unknown';
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
      continue;
    end if;

    v_spot := v_item -> 'spot';
    v_hash := v_spot ->> 'content_hash';
    if jsonb_typeof(v_spot) is distinct from 'object'
       or v_spot ->> 'source' is distinct from 'logged'
       or v_spot ->> 'source_spot_id' is distinct from p_user_id::text || '|' || v_ext
       or coalesce(v_hash, '') = '' then
      raise exception 'Not a logged contact spot.' using errcode = '22023';
    end if;

    if v_base is null or public.base_callsign(v_spot ->> 'spotter') is distinct from v_base then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'external_id', v_ext, 'status', 'rejected', 'reason', 'mycall_mismatch'));
      continue;
    end if;

    if v_found and v_row.state = 'live' and v_row.content_hash = v_hash then
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', 'unchanged'));
      continue;
    end if;

    if v_found and v_row.state = 'live' then
      update raw_spots set retracted_at = now() where id = v_row.spot_id;
      v_status := 'updated';
    else
      v_status := 'created';
    end if;

    v_spot_id := null;
    select i.id into v_spot_id from public.ingest_spots(jsonb_build_array(v_spot)) as i;
    if v_spot_id is null then
      update raw_spots r
      set retracted_at = null
      where r.source = 'logged' and r.source_spot_id = v_spot ->> 'source_spot_id' and r.content_hash = v_hash
      returning r.id into v_spot_id;
      if v_spot_id is null then
        raise exception 'Logged contact spot neither stored nor found.';
      end if;
      perform pgmq.send('spot_events', jsonb_build_object('spot_id', v_spot_id, 'source', 'logged'));
    end if;
    v_stored := v_stored + 1;

    insert into logged_contacts (user_id, external_id, spot_id, content_hash, state, logger_app, relay_version)
    values (p_user_id, v_ext, v_spot_id, v_hash, 'live', v_item ->> 'logger_app', v_item ->> 'relay_version')
    on conflict (user_id, external_id) do update
      set spot_id = excluded.spot_id, content_hash = excluded.content_hash, state = 'live',
          logger_app = excluded.logger_app, relay_version = excluded.relay_version,
          updated_at = now(), retracted_at = null;

    v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
  end loop;

  -- Every applied request counts as a run; the count is the spots stored. The catalog reads
  -- last_success_at as "last contact".
  perform public.record_ingest_success('logged', v_stored);
  return v_results;
end;
$$;

