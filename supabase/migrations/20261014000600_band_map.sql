-- The band map (/band-map): stations spotted in the last 5 minutes, by
-- frequency. The page is public and every visitor polls it, so every visitor
-- shares one cached result: the public band-map Edge Function calls
-- cached_band_map(), which serves band_map_cache while it is under 30 seconds
-- old and otherwise rebuilds it with band_map_snapshot().
--
-- Only POTA, SOTAwatch and DX Cluster spots show: RBN is a skimmer firehose
-- that would bury the human spots, and APRS-IS never reaches raw_spots. A
-- station shows once per band, at its latest spot there, keyed by base call so
-- KK4PWJ/P and KK4PWJ are one station. Hidden calls never show, as on profiles
-- and Stats. raw_payload never leaves the table.
--
-- The window reads raw_spots_spot_time_idx: five minutes is a few hundred rows
-- at most, so the source filter runs on those rows and needs no index of its own.
--
-- The payload's shape is BandMapPayload in web/src/bandmap/types.ts, pinned by
-- supabase/tests/band_map.test.sql; change the SQL, the type and the test together.

create function public.band_map_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select distinct on (r.base_callsign, r.band)
           r.id, r.callsign, r.base_callsign, r.band, r.frequency_khz, r.mode, r.source, r.spot_time,
           r.spotter,
           coalesce(r.pota_reference, r.sota_summit_ref) as reference,
           r.pota_park_name as reference_name
    from raw_spots r
    where r.source in ('pota', 'sotawatch', 'dxcluster')
      and r.spot_time > now() - interval '5 minutes'
      and r.band is not null
      and not exists (select 1 from hidden_callsigns h where h.callsign = r.base_callsign)
    order by r.base_callsign, r.band, r.spot_time desc, r.id desc
  ),
  bands as (
    select l.band,
           jsonb_agg(jsonb_build_object(
             'id', l.id,
             'callsign', l.callsign,
             'base_callsign', l.base_callsign,
             'frequency_khz', l.frequency_khz,
             'mode', l.mode,
             'source', l.source,
             'spot_time', l.spot_time,
             'spotter', l.spotter,
             'reference', l.reference,
             'reference_name', l.reference_name
           ) order by l.frequency_khz, l.id) as spots,
           min(l.frequency_khz) as low
    from latest l
    group by l.band
  )
  select jsonb_build_object(
    'bands', coalesce(jsonb_agg(jsonb_build_object('band', b.band, 'spots', b.spots) order by b.low), '[]'::jsonb)
  )
  from bands b;
$$;

-- One row. Service role only: clients read it through the Edge Function.
create table band_map_cache (
  id           boolean     primary key default true check (id),
  payload      jsonb       not null,
  generated_at timestamptz not null
);

comment on table band_map_cache is
  'The band map payload shared by every visitor; cached_band_map() rebuilds it when it is over 30 seconds old.';

alter table band_map_cache enable row level security;
revoke all on band_map_cache from anon, authenticated;

-- The cached payload with its generated_at. A stale or missing cache is
-- rebuilt under a transaction-scoped advisory lock, and checked again once the
-- lock is held, so requests that arrive together wait for the first one's
-- commit and serve its row: at most one band_map_snapshot() per 30 seconds.
create function public.cached_band_map()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload      jsonb;
  v_generated_at timestamptz;
begin
  select c.payload, c.generated_at into v_payload, v_generated_at
  from band_map_cache c
  where c.generated_at > clock_timestamp() - interval '30 seconds';
  if found then
    return v_payload || jsonb_build_object('generated_at', v_generated_at);
  end if;

  -- Held until this request commits, after the upsert below. Each statement
  -- takes a new snapshot, so the second read sees a row a waiter committed.
  perform pg_advisory_xact_lock(hashtext('band_map_cache'));
  select c.payload, c.generated_at into v_payload, v_generated_at
  from band_map_cache c
  where c.generated_at > clock_timestamp() - interval '30 seconds';
  if found then
    return v_payload || jsonb_build_object('generated_at', v_generated_at);
  end if;

  v_payload := public.band_map_snapshot();
  v_generated_at := now();
  insert into band_map_cache (id, payload, generated_at)
  values (true, v_payload, v_generated_at)
  on conflict (id) do update set payload = excluded.payload, generated_at = excluded.generated_at;
  return v_payload || jsonb_build_object('generated_at', v_generated_at);
end;
$$;

revoke all on function public.band_map_snapshot() from public, anon, authenticated;
revoke all on function public.cached_band_map() from public, anon, authenticated;
