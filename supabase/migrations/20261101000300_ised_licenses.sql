-- ISED amateur certificate and special callsign load.

-- 1. Expand callsign_licenses with variant and event description
alter table callsign_licenses add column if not exists license_variant text;
alter table callsign_licenses add column if not exists event_description text;

-- 2. Staging tables
create unlogged table ised_amateur_stage (
  callsign       text primary key,
  first_name     text,
  last_name      text,
  club_name      text,
  province       text,
  qualifications text not null
);

alter table ised_amateur_stage enable row level security;
revoke all on ised_amateur_stage from anon, authenticated;

create unlogged table ised_special_stage (
  callsign          text primary key,
  beg_date          date not null,
  end_date          date not null,
  event_en          text,
  event_fr          text,
  call_sign_request text
);

alter table ised_special_stage enable row level security;
revoke all on ised_special_stage from anon, authenticated;

-- 3. Qualification mapping function
create function public.ised_operator_class(p_letters text)
returns text
immutable
strict
language sql
set search_path = public
as $$
  select nullif(string_agg(label, ', ' order by ord), '')
  from unnest(string_to_array(upper(trim(p_letters)), '')) with ordinality as u(letter, ord)
  left join (
    values ('A', 'Basic'), ('B', '5 WPM'), ('C', '12 WPM'), ('D', 'Advanced'), ('E', 'Basic with Honours')
  ) as v(code, label) on v.code = u.letter;
$$;

-- 4. Floor functions
create function public.ised_license_floor()
returns integer
stable
language sql
set search_path = public
as $$
  select coalesce(
    (select greatest(80000, floor(count(*) * 0.9)::integer)
     from callsign_licenses
     where authority = 'ISED' and license_variant is null),
    80000
  );
$$;

create function public.ised_special_floor()
returns integer
stable
language sql
set search_path = public
as $$
  select coalesce(
    (select greatest(10, floor(count(*) * 0.9)::integer)
     from callsign_licenses
     where authority = 'ISED' and license_variant = 'special'),
    10
  );
$$;

-- 5. Amateur Load Lifecycle RPCs
create function public.ised_license_load_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'load', (
      select jsonb_build_object('id', l.id, 'version', l.version, 'status', l.status,
                                'started_at', l.started_at, 'ready_at', l.ready_at,
                                'applied_at', l.applied_at, 'counts', l.counts,
                                'licenses', l.licenses, 'error', l.error)
      from license_loads l
      where l.authority = 'ISED'
      order by l.id desc
      limit 1
    ),
    'newestAppliedStartedAt', (
      select l.started_at
      from license_loads l
      where l.authority = 'ISED' and l.status = 'applied'
      order by l.id desc
      limit 1
    )
  );
$$;

create function public.ised_license_load_begin(p_version text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version text := trim(p_version);
  v_load bigint;
begin
  if v_version = '' then
    raise exception 'ised_license_load_begin: version is required';
  end if;

  update license_loads
     set status = 'failed', error = coalesce(error, 'superseded')
   where authority = 'ISED' and status in ('loading', 'ready');

  truncate ised_amateur_stage;

  insert into license_loads (authority, version, counts)
  values ('ISED', v_version, '{"rows": 0}'::jsonb)
  returning id into v_load;

  return v_load;
end;
$$;

create function public.ised_license_load_rows(p_load bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staged integer;
begin
  perform 1 from license_loads where id = p_load and authority = 'ISED' and status = 'loading'
  for update;
  if not found then
    raise exception 'ised_license_load_rows: load % is not loading', p_load;
  end if;

  insert into ised_amateur_stage (callsign, first_name, last_name, club_name, province, qualifications)
  select x.callsign, x.first_name, x.last_name, x.club_name, x.province, x.qualifications
  from jsonb_to_recordset(p_rows) as x(
    callsign text,
    first_name text,
    last_name text,
    club_name text,
    province text,
    qualifications text
  )
  on conflict (callsign) do update
    set first_name = excluded.first_name,
        last_name = excluded.last_name,
        club_name = excluded.club_name,
        province = excluded.province,
        qualifications = excluded.qualifications;

  select count(*)::integer into v_staged from ised_amateur_stage;
  return v_staged;
end;
$$;

create function public.ised_license_staged_counts()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('rows', count(*)) from ised_amateur_stage;
$$;

create function public.ised_license_load_finish(p_load bigint, p_rows integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_floor integer := ised_license_floor();
begin
  select count(*)::integer into v_count from ised_amateur_stage;
  perform 1 from license_loads where id = p_load and authority = 'ISED' and status = 'loading'
  for update;
  if not found then
    raise exception 'ised_license_load_finish: load % is not loading', p_load;
  end if;
  if v_count < v_floor then
    raise exception 'ised_license_load_finish: staged only % rows (floor %)', v_count, v_floor;
  end if;
  if v_count <> p_rows then
    raise exception 'ised_license_load_finish: staged % but the worker sent %', v_count, p_rows;
  end if;

  update license_loads set status = 'ready', ready_at = now(), counts = jsonb_build_object('rows', v_count)
   where id = p_load;
end;
$$;

create function public.ised_license_load_abandon(p_load bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update license_loads
     set status = 'failed', error = left(coalesce(nullif(trim(p_error), ''), 'abandoned'), 1000)
   where id = p_load and authority = 'ISED' and status = 'loading';
  if found then
    truncate ised_amateur_stage;
  end if;
end;
$$;

-- 6. Special Callsign Load Lifecycle RPCs
create function public.ised_special_load_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'load', (
      select jsonb_build_object('id', l.id, 'version', l.version, 'status', l.status,
                                'started_at', l.started_at, 'ready_at', l.ready_at,
                                'applied_at', l.applied_at, 'counts', l.counts,
                                'licenses', l.licenses, 'error', l.error)
      from license_loads l
      where l.authority = 'ISED-SPECIAL'
      order by l.id desc
      limit 1
    )
  );
$$;

create function public.ised_special_load_begin(p_version text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version text := trim(p_version);
  v_load bigint;
begin
  if v_version = '' then
    raise exception 'ised_special_load_begin: version is required';
  end if;

  update license_loads
     set status = 'failed', error = coalesce(error, 'superseded')
   where authority = 'ISED-SPECIAL' and status in ('loading', 'ready');

  truncate ised_special_stage;

  insert into license_loads (authority, version, counts)
  values ('ISED-SPECIAL', v_version, '{"rows": 0}'::jsonb)
  returning id into v_load;

  return v_load;
end;
$$;

create function public.ised_special_load_rows(p_load bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staged integer;
begin
  perform 1 from license_loads where id = p_load and authority = 'ISED-SPECIAL' and status = 'loading'
  for update;
  if not found then
    raise exception 'ised_special_load_rows: load % is not loading', p_load;
  end if;

  insert into ised_special_stage (callsign, beg_date, end_date, event_en, event_fr, call_sign_request)
  select x.callsign, x.beg_date::date, x.end_date::date, x.event_en, x.event_fr, x.call_sign_request
  from jsonb_to_recordset(p_rows) as x(
    callsign text,
    beg_date text,
    end_date text,
    event_en text,
    event_fr text,
    call_sign_request text
  )
  on conflict (callsign) do update
    set beg_date = excluded.beg_date,
        end_date = excluded.end_date,
        event_en = excluded.event_en,
        event_fr = excluded.event_fr,
        call_sign_request = excluded.call_sign_request;

  select count(*)::integer into v_staged from ised_special_stage;
  return v_staged;
end;
$$;

create function public.ised_special_load_finish(p_load bigint, p_rows integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_floor integer := ised_special_floor();
begin
  select count(*)::integer into v_count from ised_special_stage;
  perform 1 from license_loads where id = p_load and authority = 'ISED-SPECIAL' and status = 'loading'
  for update;
  if not found then
    raise exception 'ised_special_load_finish: load % is not loading', p_load;
  end if;
  if v_count < v_floor then
    raise exception 'ised_special_load_finish: staged only % rows (floor %)', v_count, v_floor;
  end if;
  if v_count <> p_rows then
    raise exception 'ised_special_load_finish: staged % but the worker sent %', v_count, p_rows;
  end if;

  update license_loads set status = 'ready', ready_at = now(), counts = jsonb_build_object('rows', v_count)
   where id = p_load;
end;
$$;

create function public.ised_special_load_abandon(p_load bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update license_loads
     set status = 'failed', error = left(coalesce(nullif(trim(p_error), ''), 'abandoned'), 1000)
   where id = p_load and authority = 'ISED-SPECIAL' and status = 'loading';
  if found then
    truncate ised_special_stage;
  end if;
end;
$$;

-- 7. Apply functions and wrapper
create function public.apply_fcc_license_load()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_load license_loads;
  v_licenses integer;
begin
  select * into v_load from license_loads
  where authority = 'FCC' and status = 'ready'
  order by id desc
  limit 1
  for update;
  if not found then
    return 0;
  end if;

  begin
    delete from callsign_licenses where authority = 'FCC';
    insert into callsign_licenses (callsign, authority, name, first_name, last_name, operator_class, status,
                                   granted_on, expires_on, country, state, grid, loaded_at)
    select h.callsign, 'FCC', e.name, e.first_name, e.last_name, a.operator_class, h.status,
           h.granted_on, h.expires_on, 'US', e.state, null, now()
    from fcc_uls_hd h
    join fcc_uls_en e on e.usi = h.usi
    left join lateral (
      select operator_class from fcc_uls_am am where am.usi = h.usi
      order by (operator_class is not null) desc limit 1
    ) a on true;
    get diagnostics v_licenses = row_count;

    update license_loads set status = 'applied', applied_at = now(), licenses = v_licenses
     where id = v_load.id;
  exception when others then
    update license_loads set status = 'failed', error = sqlerrm where id = v_load.id;
    v_licenses := 0;
  end;

  truncate fcc_uls_hd, fcc_uls_en, fcc_uls_am;
  return v_licenses;
end;
$$;

create function public.apply_ised_license_load()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_load license_loads;
  v_special_load license_loads;
  v_licenses integer := 0;
begin
  -- Apply regular amateur certificates
  select * into v_load from license_loads
  where authority = 'ISED' and status = 'ready'
  order by id desc
  limit 1
  for update;

  if found then
    begin
      delete from callsign_licenses where authority = 'ISED' and (license_variant is null);
      insert into callsign_licenses (callsign, authority, license_variant, name, first_name, last_name, operator_class, status,
                                     granted_on, expires_on, country, state, grid, loaded_at)
      select s.callsign, 'ISED', null,
             coalesce(s.club_name, nullif(trim(concat_ws(' ', s.first_name, s.last_name)), '')),
             case when s.club_name is not null then null else s.first_name end,
             case when s.club_name is not null then null else s.last_name end,
             case when s.club_name is not null then null else ised_operator_class(s.qualifications) end,
             null, null, null, 'CA', s.province, null, now()
      from ised_amateur_stage s;
      get diagnostics v_licenses = row_count;

      update license_loads set status = 'applied', applied_at = now(), licenses = v_licenses
       where id = v_load.id;
    exception when others then
      update license_loads set status = 'failed', error = sqlerrm where id = v_load.id;
      v_licenses := 0;
    end;
    truncate ised_amateur_stage;
  end if;

  -- Apply special callsigns
  select * into v_special_load from license_loads
  where authority = 'ISED-SPECIAL' and status = 'ready'
  order by id desc
  limit 1
  for update;

  if found then
    begin
      delete from callsign_licenses where authority = 'ISED' and license_variant = 'special';
      insert into callsign_licenses (callsign, authority, license_variant, name, granted_on, expires_on, event_description, country, loaded_at)
      select s.callsign, 'ISED', 'special', s.event_en, s.beg_date, s.end_date, s.event_en, 'CA', now()
      from ised_special_stage s;

      update license_loads set status = 'applied', applied_at = now(), licenses = (select count(*)::integer from ised_special_stage)
       where id = v_special_load.id;
    exception when others then
      update license_loads set status = 'failed', error = sqlerrm where id = v_special_load.id;
    end;
    truncate ised_special_stage;
  end if;

  return v_licenses;
end;
$$;

create or replace function public.apply_license_loads()
returns void
language plpgsql
set search_path = public
as $$
begin
  perform public.apply_fcc_license_load();
  perform public.apply_ised_license_load();
end;
$$;

-- 8. Grants and Revocations
revoke all on function public.ised_license_load_status() from public, anon, authenticated;
revoke all on function public.ised_license_load_begin(text) from public, anon, authenticated;
revoke all on function public.ised_license_load_rows(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.ised_license_staged_counts() from public, anon, authenticated;
revoke all on function public.ised_license_load_finish(bigint, integer) from public, anon, authenticated;
revoke all on function public.ised_license_load_abandon(bigint, text) from public, anon, authenticated;

revoke all on function public.ised_special_load_status() from public, anon, authenticated;
revoke all on function public.ised_special_load_begin(text) from public, anon, authenticated;
revoke all on function public.ised_special_load_rows(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.ised_special_load_finish(bigint, integer) from public, anon, authenticated;
revoke all on function public.ised_special_load_abandon(bigint, text) from public, anon, authenticated;

grant execute on function public.ised_license_load_status() to service_role;
grant execute on function public.ised_license_load_begin(text) to service_role;
grant execute on function public.ised_license_load_rows(bigint, jsonb) to service_role;
grant execute on function public.ised_license_load_finish(bigint, integer) to service_role;
grant execute on function public.ised_license_load_abandon(bigint, text) to service_role;

grant execute on function public.ised_special_load_status() to service_role;
grant execute on function public.ised_special_load_begin(text) to service_role;
grant execute on function public.ised_special_load_rows(bigint, jsonb) to service_role;
grant execute on function public.ised_special_load_finish(bigint, integer) to service_role;
grant execute on function public.ised_special_load_abandon(bigint, text) to service_role;
