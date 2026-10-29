-- One base call per profile (review 4, database: logged contacts, finding 1).
--
-- profiles.callsign is unique only as typed, so with W1AW registered another account could take
-- W1AW/P, W1AW/QRP or W1AW/7. All reduce to base W1AW, which is what apply_logged_contacts checks
-- a logged contact's mycall against, so that account could post contacts as W1AW.
--
-- No index on base_callsign(callsign): a unique one could fail on hosted data that already holds
-- such a pair, and any expression index would be evaluated as the client on the web's own profile
-- update, and clients cannot execute base_callsign(). profiles is small; the checks scan it.
--
-- 1. profiles_unique_base_callsign: a before insert or update of callsign trigger that refuses a
--    callsign whose base another profile holds, serialised by an advisory lock on the base. It
--    raises unique_violation with "That callsign is already taken.", as the unique constraint's
--    duplicate reaches each path today: handle_new_user (sign-up) fails, complete_profile maps
--    unique_violation to that message, and the web's profile update maps 23505 to it. An update
--    that keeps the base (W1AW to W1AW/P, or a name change that resends the callsign) is never
--    refused, so a pair that already exists can still save.
-- 2. callsign_available: the sign-up precheck, as in 20261006000001, refusing a taken base too.
-- 3. apply_logged_contacts: as in 20261028000300, accepting an upsert only from the
--    earliest-created profile that holds its base call, for pairs made before this migration.

create function public.profiles_check_base_callsign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := public.base_callsign(new.callsign);
begin
  if tg_op = 'UPDATE' and public.base_callsign(old.callsign) = v_base then
    return new;
  end if;
  -- Two sign-ups of W1AW/P and W1AW/7 at once would each miss the other without it.
  perform pg_advisory_xact_lock(hashtextextended('profiles_base:' || v_base, 0));
  if exists (select 1 from profiles p
             where p.id <> new.id and public.base_callsign(p.callsign) = v_base) then
    raise exception 'That callsign is already taken.' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_check_base_callsign() from public, anon, authenticated;

-- Named to sort after profiles_normalize_callsign, so it sees the upper-cased, trimmed call.
create trigger profiles_unique_base_callsign
before insert or update of callsign on profiles
for each row execute function public.profiles_check_base_callsign();

create or replace function public.callsign_available(p_callsign text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select upper(trim(p_callsign)) ~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$'
     and not exists (select 1 from profiles p
                     where p.callsign = upper(trim(p_callsign))
                        or public.base_callsign(p.callsign) = public.base_callsign(p_callsign));
$$;

-- apply_logged_contacts: as in 20261028000300, with the earliest holder of a base call only.
create or replace function public.apply_logged_contacts(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_base    text;
  v_created timestamptz;
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

  select public.base_callsign(p.callsign), p.created_at into v_base, v_created
  from profiles p where p.id = p_user_id;
  -- Profiles that took a base call another profile held before 20261029000300 may still share it:
  -- only the earliest-created holder posts as that base, so every other gets mycall_mismatch.
  if v_base is not null and exists (
       select 1 from profiles o
       where o.id <> p_user_id
         and public.base_callsign(o.callsign) = v_base
         and (o.created_at, o.id) < (v_created, p_user_id)) then
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

