-- DX Cluster as a fourth source.
--
-- The relay (relay/, on Fly.io) holds a telnet session to a DXSpider node and
-- POSTs human spot lines to the ingest-dxcluster Edge Function, which stores
-- every one in raw_spots through the usual ingest_spots RPC. There is no
-- firehose table: human spots run to a few thousand an hour at most.

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster'));

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('dxcluster') on conflict do nothing;

alter table archive_log drop constraint archive_log_source_check;
alter table archive_log add constraint archive_log_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster'));

-- Matching: a DX Cluster spot matches only a subscription that lists dxcluster
-- in its sources. An empty sources list has always meant "POTA, SOTAwatch and
-- watched RBN stations"; it must not start receiving every DX spot on its bands.
-- The rule goes in source_matches (20261012000010), which spot_matches and
-- watched_among share, so spot_matches itself is unchanged.
create or replace function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select case when cardinality(p_sources) = 0 then p_source <> 'dxcluster'
              else p_source = any (p_sources) end;
$$;

-- Archive: DX Cluster lives in raw_spots, so it takes the raw_spots branch and
-- hourly slices like POTA and SOTAwatch.
create or replace function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
as $$
  select case p_source
           when 'rbn' then 10
           when 'pota' then 60
           when 'sotawatch' then 60
           when 'dxcluster' then 60
         end;
$$;

create or replace function public.archive_ndjson(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, ndjson text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             coalesce(string_agg(to_json(r)::text, E'\n'
                                 order by r.spot_time, r.spotter, r.callsign, r.frequency_khz), '')
      from (
        select x.spot_time, x.received_at, x.spotter, x.callsign, x.frequency_khz, x.band, x.mode,
               x.mode_family, x.snr, x.speed, x.speed_unit, x.spot_type, x.line
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch', 'dxcluster') then
    return query
      select count(*)::int,
             coalesce(string_agg(to_json(r)::text, E'\n'
                                 order by r.spot_time, r.source_spot_id, r.content_hash), '')
      from (
        select x.source, x.source_spot_id, x.content_hash, x.spot_time, x.ingested_at, x.callsign,
               x.spotter, x.frequency_khz, x.band, x.mode, x.mode_family, x.comment,
               x.pota_reference, x.pota_park_name, x.pota_location, x.sota_summit_ref, x.raw_payload
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

create or replace view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn'), ('dxcluster')) as s(source);

revoke all on archive_status from anon, authenticated;
