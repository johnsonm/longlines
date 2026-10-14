-- The archive writes Parquet (spec docs/superpowers/specs/2026-10-14-archive-parquet-design.md).
--
-- archive_columns replaces archive_ndjson: the same rows, columns and order,
-- returned as one JSON object of column arrays so the archive function hands
-- them straight to the Parquet writer without parsing rows. Timestamps are epoch
-- milliseconds, so TypeScript never parses dates; raw_payload is JSON text.
-- An empty slice returns row_count 0 and null columns.
--
-- Until the archive function is redeployed its calls to archive_ndjson fail and
-- slices stay pending; retention waits for archive_log, so nothing is lost.

create function public.archive_columns(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, columns json)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'snr', json_agg(r.snr order by r.o),
               'speed', json_agg(r.speed order by r.o),
               'speed_unit', json_agg(r.speed_unit order by r.o),
               'spot_type', json_agg(r.spot_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.spotter, x.callsign, x.frequency_khz) as o
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source = 'aprs' then
    -- Every column but line_md5, which only orders packets received in the same instant.
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'source_call', json_agg(r.source_call order by r.o),
               'destination', json_agg(r.destination order by r.o),
               'path', json_agg(r.path order by r.o),
               'q_construct', json_agg(r.q_construct order by r.o),
               'igate', json_agg(r.igate order by r.o),
               'packet_type', json_agg(r.packet_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*, row_number() over (order by x.received_at, x.line_md5) as o
        from aprs_packets x
        where x.received_at >= p_from and x.received_at < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch', 'dxcluster') then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'source', json_agg(r.source order by r.o),
               'source_spot_id', json_agg(r.source_spot_id order by r.o),
               'content_hash', json_agg(r.content_hash order by r.o),
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'ingested_at', json_agg((extract(epoch from r.ingested_at) * 1000)::bigint order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'comment', json_agg(r.comment order by r.o),
               'pota_reference', json_agg(r.pota_reference order by r.o),
               'pota_park_name', json_agg(r.pota_park_name order by r.o),
               'pota_location', json_agg(r.pota_location order by r.o),
               'sota_summit_ref', json_agg(r.sota_summit_ref order by r.o),
               'raw_payload', json_agg(r.raw_payload::text order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.source_spot_id, x.content_hash) as o
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

revoke all on function public.archive_columns(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.archive_columns(text, timestamptz, timestamptz) to service_role;

drop function public.archive_ndjson(text, timestamptz, timestamptz);
