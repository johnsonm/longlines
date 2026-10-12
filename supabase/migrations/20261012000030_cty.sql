-- Callsign profiles, part 2 (docs/superpowers/specs/2026-10-12-callsign-lookup-design.md).
--
-- Spotter geography from AD1C's cty.dat. The import-cty Edge Function
-- downloads the file weekly, parses it (_shared/cty.ts) and replaces
-- cty_entities and cty_prefixes through load_cty in one transaction, so a
-- reader sees the old set or the new one, never half of each. cty_load records
-- the version loaded. WAE-only entities (Sicily, European Turkey, ...) are not
-- loaded: their calls fall through to the DXCC country.
--
-- cty_lookup(call) is the one place a callsign becomes a country and
-- continent; TypeScript never repeats it. The rollups in part 3 call it per
-- distinct spotter.
--
-- Also drops watched_callsigns(), which 20261012000010 kept until the deployed
-- ingest-rbn moved to watched_among.

create table cty_entities (
  prefix    text         primary key,  -- cty.dat primary prefix: K, 3D2/c
  name      text         not null,
  continent text         not null check (continent in ('AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA')),
  cq_zone   smallint     not null,
  itu_zone  smallint     not null,
  lat       numeric(5,2) not null,
  lon       numeric(5,2) not null     -- east positive
);

-- A prefix, or a whole callsign when exact (cty.dat "=" aliases). Continent and
-- zones are the entity's unless cty.dat overrides them for this pattern.
create table cty_prefixes (
  pattern   text     not null,
  exact     boolean  not null,
  entity    text     not null references cty_entities (prefix),
  continent text     not null check (continent in ('AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA')),
  cq_zone   smallint not null,
  itu_zone  smallint not null,
  primary key (pattern, exact)
);

create index cty_prefixes_entity_idx on cty_prefixes (entity);

create table cty_load (
  id        boolean     primary key default true check (id),
  version   text,                     -- yyyymmdd from cty.dat's =VER entry
  loaded_at timestamptz not null,
  entities  integer     not null,
  prefixes  integer     not null
);

alter table cty_entities enable row level security;
alter table cty_prefixes enable row level security;
alter table cty_load enable row level security;
revoke all on cty_entities, cty_prefixes, cty_load from anon, authenticated;

-- Replaces the loaded set. Called by import-cty with the parsed file.
create function public.load_cty(p_version text, p_entities jsonb, p_prefixes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entities integer;
  v_prefixes integer;
begin
  if jsonb_typeof(p_entities) is distinct from 'array' or jsonb_array_length(p_entities) = 0
     or jsonb_typeof(p_prefixes) is distinct from 'array' or jsonb_array_length(p_prefixes) = 0 then
    raise exception 'load_cty: entities and prefixes must be non-empty arrays';
  end if;

  delete from cty_prefixes where true;
  delete from cty_entities where true;

  insert into cty_entities (prefix, name, continent, cq_zone, itu_zone, lat, lon)
  select x.prefix, x.name, x.continent, x.cq_zone, x.itu_zone, x.lat, x.lon
  from jsonb_to_recordset(p_entities) as x(
    prefix text, name text, continent text, cq_zone smallint, itu_zone smallint,
    lat numeric, lon numeric);
  get diagnostics v_entities = row_count;

  insert into cty_prefixes (pattern, exact, entity, continent, cq_zone, itu_zone)
  select x.pattern, x.exact, x.entity, x.continent, x.cq_zone, x.itu_zone
  from jsonb_to_recordset(p_prefixes) as x(
    pattern text, exact boolean, entity text, continent text, cq_zone smallint, itu_zone smallint);
  get diagnostics v_prefixes = row_count;

  insert into cty_load (id, version, loaded_at, entities, prefixes)
  values (true, p_version, now(), v_entities, v_prefixes)
  on conflict (id) do update
    set version = excluded.version, loaded_at = excluded.loaded_at,
        entities = excluded.entities, prefixes = excluded.prefixes;
end;
$$;

revoke all on function public.load_cty(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.load_cty(text, jsonb, jsonb) to service_role;

-- The cty.dat entity a callsign was sent from, or no row (unknown prefix,
-- /MM, /AM, or nothing loaded yet).
--
-- 1. Uppercase and drop an SSID or skimmer marker (K3PA-1, DK9IP-#).
-- 2. The location is a prefix written with the call (W4/G4OBK, VP2E/KA1A,
--    G4ABC/F): the shortest part that is not base_callsign(), ignoring /P, /M,
--    /QRP, /QRPP, /R, /A, /B, /LH and call-area digits. Otherwise the base
--    call. A call-area digit does not move a station (EA6SA/7 stays Balearic).
-- 3. An exact cty.dat entry for the whole call or the location wins, then the
--    longest prefix of the location.
create function public.cty_lookup(p_call text)
returns table (entity text, name text, continent text, cq_zone smallint, itu_zone smallint)
language sql
stable
set search_path = public
as $$
  with c as (
    select split_part(upper(trim(p_call)), '-', 1) as call
  ),
  k as (
    select c.call,
           coalesce(
             (select t.part
              from unnest(string_to_array(c.call, '/')) with ordinality as t(part, i)
              where t.part <> ''
                and t.part not in ('P', 'M', 'QRP', 'QRPP', 'R', 'A', 'B', 'LH')
                and t.part !~ '^[0-9]$'
                and t.part <> public.base_callsign(c.call)
              order by length(t.part), t.i
              limit 1),
             public.base_callsign(c.call)) as loc
    from c
    where c.call !~ '/(MM|AM)(/|$)'
  )
  select p.entity, e.name, p.continent, p.cq_zone, p.itu_zone
  from k
  join cty_prefixes p
    on p.pattern = any (k.call || array(select left(k.loc, n) from generate_series(1, length(k.loc)) as n))
   and (case when p.exact then p.pattern in (k.call, k.loc)
             else left(k.loc, length(p.pattern)) = p.pattern end)
  join cty_entities e on e.prefix = p.entity
  order by p.exact desc, length(p.pattern) desc
  limit 1;
$$;

revoke all on function public.cty_lookup(text) from public, anon, authenticated;
grant execute on function public.cty_lookup(text) to service_role;

-- Weekly, Monday 04:20 UTC: after the nightly RBN maintenance, well clear of
-- the hourly stats refresh. country-files.com updates every few weeks.
select cron.schedule(
  'import-cty',
  '20 4 * * 1',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
             || '/functions/v1/import-cty',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

drop function public.watched_callsigns(text);
