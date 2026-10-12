-- Callsign profiles, part 4 (docs/superpowers/specs/2026-10-12-callsign-lookup-design.md).
--
-- License records for callsign profiles. callsign_licenses is generic: one row
-- per callsign with the issuing authority, so other countries' registries can
-- load into it later. FCC is the only loader for now.
--
-- The FCC load runs on the Fly relay (relay/licenses.ts), weekly, from the
-- ULS amateur file l_amat.zip:
--   1. load-licenses -> fcc_license_load_begin: new license_loads row, staging emptied
--   2. load-licenses -> fcc_license_load_rows, in batches: HD, EN and AM records
--      into the fcc_uls_* staging tables
--   3. load-licenses -> fcc_license_load_finish: the staged counts must match
--      what the relay sent; the load becomes 'ready'
--   4. pg_cron -> apply_license_loads, hourly: joins the staging tables and
--      replaces the FCC rows of callsign_licenses in one transaction, so a
--      reader sees the old set or the new one, never half of each.
-- Step 4 runs from cron, not from the relay, because replacing ~1.5M rows takes
-- longer than the API's 8 s statement timeout.
--
-- Only name, class, status, dates and state are kept. The staging tables have
-- no columns for street address, city, ZIP, PO box, phone, email or FRN, and
-- jsonb_to_recordset drops any such key a caller sends.

create table callsign_licenses (
  callsign       text        primary key,
  authority      text        not null,             -- FCC
  name           text,
  operator_class text,                             -- Amateur Extra, General, ...; null for clubs
  status         text,                             -- Active, Expired, Canceled, ...
  granted_on     date,
  expires_on     date,
  country        text,                             -- ISO 3166-1 alpha-2 of the authority
  state          text,
  grid           text,                             -- FCC records have none
  loaded_at      timestamptz not null
);

-- Public FCC data, readable by anyone, like the profiles that show it.
alter table callsign_licenses enable row level security;
revoke all on callsign_licenses from anon, authenticated;
grant select on callsign_licenses to anon, authenticated;
create policy callsign_licenses_read on callsign_licenses
  for select to anon, authenticated using (true);

-- One row per load attempt. version is the file's Last-Modified header; the
-- relay skips a version that is already ready or applied.
create table license_loads (
  id          bigint      generated always as identity primary key,
  authority   text        not null,
  version     text        not null,
  status      text        not null default 'loading'
                          check (status in ('loading', 'ready', 'applied', 'failed')),
  started_at  timestamptz not null default now(),
  ready_at    timestamptz,
  applied_at  timestamptz,
  counts      jsonb,                               -- staged records per ULS file
  licenses    integer,                             -- rows in callsign_licenses after apply
  error       text
);

create index license_loads_authority_idx on license_loads (authority, id desc);

-- Staging for one FCC load, keyed by ULS unique system identifier. Unlogged:
-- the data is reloaded weekly, and a crash that empties them makes the counts
-- disagree with license_loads, which apply_license_loads refuses.
create unlogged table fcc_uls_hd (
  usi        bigint primary key,
  callsign   text   not null,
  status     text,
  granted_on date,
  expires_on date
);

create unlogged table fcc_uls_en (
  usi   bigint primary key,
  name  text,
  state text
);

create unlogged table fcc_uls_am (
  usi            bigint primary key,
  operator_class text
);

alter table license_loads enable row level security;
alter table fcc_uls_hd enable row level security;
alter table fcc_uls_en enable row level security;
alter table fcc_uls_am enable row level security;
revoke all on license_loads, fcc_uls_hd, fcc_uls_en, fcc_uls_am from anon, authenticated;

-- The newest FCC load, or null. The relay decides from it whether to load.
create function public.fcc_license_load_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', l.id, 'version', l.version, 'status', l.status,
                            'started_at', l.started_at)
  from license_loads l
  where l.authority = 'FCC'
  order by l.id desc
  limit 1;
$$;

-- Starts a load: earlier unfinished loads fail, staging is emptied.
create function public.fcc_license_load_begin(p_version text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if coalesce(trim(p_version), '') = '' then
    raise exception 'fcc_license_load_begin: version is required';
  end if;

  update license_loads
     set status = 'failed', error = 'superseded by load of ' || p_version
   where authority = 'FCC' and status in ('loading', 'ready');
  truncate fcc_uls_hd, fcc_uls_en, fcc_uls_am;

  insert into license_loads (authority, version) values ('FCC', trim(p_version))
  returning id into v_id;
  return v_id;
end;
$$;

-- Stages one batch of HD, EN or AM rows for a loading load. Returns the rows
-- inserted; a record already staged (a retried batch) is skipped.
create function public.fcc_license_load_rows(p_load bigint, p_kind text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  perform 1 from license_loads where id = p_load and authority = 'FCC' and status = 'loading';
  if not found then
    raise exception 'fcc_license_load_rows: load % is not loading', p_load;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'fcc_license_load_rows: rows must be an array';
  end if;

  case p_kind
    when 'HD' then
      insert into fcc_uls_hd (usi, callsign, status, granted_on, expires_on)
      select x.usi, upper(x.callsign), x.status, x.granted_on, x.expires_on
      from jsonb_to_recordset(p_rows) as x(
        usi bigint, callsign text, status text, granted_on date, expires_on date)
      on conflict (usi) do nothing;
    when 'EN' then
      insert into fcc_uls_en (usi, name, state)
      select x.usi, x.name, x.state
      from jsonb_to_recordset(p_rows) as x(usi bigint, name text, state text)
      on conflict (usi) do nothing;
    when 'AM' then
      insert into fcc_uls_am (usi, operator_class)
      select x.usi, x.operator_class
      from jsonb_to_recordset(p_rows) as x(usi bigint, operator_class text)
      on conflict (usi) do nothing;
    else
      raise exception 'fcc_license_load_rows: unknown record type %', p_kind;
  end case;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- Staged rows per file, as {"HD": n, "EN": n, "AM": n}.
create function public.fcc_license_staged_counts()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object('HD', (select count(*) from fcc_uls_hd),
                            'EN', (select count(*) from fcc_uls_en),
                            'AM', (select count(*) from fcc_uls_am));
$$;

-- Ends staging. p_counts is the rows the relay staged per file (the sum of
-- fcc_license_load_rows results); a mismatch means a lost batch.
create function public.fcc_license_load_finish(p_load bigint, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := fcc_license_staged_counts();
begin
  perform 1 from license_loads where id = p_load and authority = 'FCC' and status = 'loading'
  for update;
  if not found then
    raise exception 'fcc_license_load_finish: load % is not loading', p_load;
  end if;
  if v_counts is distinct from p_counts then
    raise exception 'fcc_license_load_finish: staged % but the relay sent %', v_counts, p_counts;
  end if;
  update license_loads set status = 'ready', ready_at = now(), counts = v_counts
   where id = p_load;
end;
$$;

-- Swaps a ready FCC load into callsign_licenses (pg_cron, hourly). When a call
-- has several records (a call reissued after it lapsed), the active one wins,
-- then the latest grant. A failure marks the load failed and leaves
-- callsign_licenses as it was; the relay tries again later.
create function public.apply_license_loads()
returns void
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
    return;
  end if;

  begin
    if fcc_license_staged_counts() is distinct from v_load.counts then
      raise exception 'staging no longer matches load % (%)', v_load.id, fcc_license_staged_counts();
    end if;

    delete from callsign_licenses where authority = 'FCC';
    insert into callsign_licenses (callsign, authority, name, operator_class, status,
                                   granted_on, expires_on, country, state, grid, loaded_at)
    select h.callsign, 'FCC', e.name, a.operator_class, h.status,
           h.granted_on, h.expires_on, 'US', e.state, null, now()
    from (select distinct on (callsign) *
          from fcc_uls_hd
          order by callsign, status = 'Active' desc, granted_on desc nulls last, usi desc) h
    left join fcc_uls_en e on e.usi = h.usi
    left join fcc_uls_am a on a.usi = h.usi;
    get diagnostics v_licenses = row_count;

    update license_loads set status = 'applied', applied_at = now(), licenses = v_licenses
     where id = v_load.id;
  exception when others then
    update license_loads set status = 'failed', error = sqlerrm where id = v_load.id;
  end;

  truncate fcc_uls_hd, fcc_uls_en, fcc_uls_am;
end;
$$;

revoke all on function public.fcc_license_load_status() from public, anon, authenticated;
revoke all on function public.fcc_license_load_begin(text) from public, anon, authenticated;
revoke all on function public.fcc_license_load_rows(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.fcc_license_staged_counts() from public, anon, authenticated;
revoke all on function public.fcc_license_load_finish(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.apply_license_loads() from public, anon, authenticated;
grant execute on function public.fcc_license_load_status() to service_role;
grant execute on function public.fcc_license_load_begin(text) to service_role;
grant execute on function public.fcc_license_load_rows(bigint, text, jsonb) to service_role;
grant execute on function public.fcc_license_load_finish(bigint, jsonb) to service_role;

-- Hourly at :50, clear of the stats refresh at :05. Usually a no-op; the week's
-- load is applied within an hour of the relay finishing it.
select cron.schedule('apply-license-loads', '50 * * * *', $$select public.apply_license_loads()$$);
