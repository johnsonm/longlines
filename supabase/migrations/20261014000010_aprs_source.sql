-- APRS-IS as a fifth source: every packet on the full feed.
--
-- The relay (relay/, on Fly.io) holds the APRS-IS full feed (port 10152, no
-- filter) and POSTs every packet line to ingest-aprs, which stores them all in
-- aprs_packets through ingest_aprs_packets. At roughly 50-150 packets a second
-- (4-13 million a day) this is the busiest table, so it follows rbn_spots:
-- partitioned by UTC day, archived to Storage, and dropped from the database
-- only once the archive holds every slice with the database's count. Unlike RBN
-- it keeps about two days, not seven, and nothing rolls it up.
--
-- Packets are not spots. Nothing here touches raw_spots, spot_events, the
-- matcher, spot_stream or the Stats snapshot; raw_spots' source check is left
-- without 'aprs' so a stray write fails loudly. Spec:
-- docs/superpowers/specs/2026-10-14-aprs-is-design.md.

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('aprs') on conflict do nothing;

alter table archive_log drop constraint archive_log_source_check;
alter table archive_log add constraint archive_log_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs'));

-- Every packet the relay forwards. received_at (when the relay read the line)
-- is the time of record: most packets carry no timestamp of their own. Header
-- fields are parsed by aprsPacketRow in _shared/aprs.ts; the line is kept
-- exactly as received for later decoding (positions, weather, telemetry).
-- line_md5 makes a retried batch insert nothing: the relay resends the same
-- line with the same received_at.
create table aprs_packets (
  received_at timestamptz not null,
  source_call text        not null,
  destination text        not null,
  path        text        not null,
  q_construct text,
  igate       text,
  packet_type text        not null check (packet_type in (
                'position', 'mic_e', 'object', 'item', 'message', 'status', 'weather',
                'telemetry', 'nmea', 'third_party', 'capabilities', 'query', 'user_defined',
                'other')),
  line        text        not null,
  line_md5    uuid        not null,
  unique (received_at, line_md5)
) partition by range (received_at);

create index aprs_packets_source_call_time_idx on aprs_packets (source_call, received_at);

-- Catches rows for a day whose partition does not exist yet, so an insert never
-- fails for lack of one. create_aprs_packets_partition moves them out.
create table partitions.aprs_packets_default partition of aprs_packets default;

alter table aprs_packets enable row level security;
alter table partitions.aprs_packets_default enable row level security;
revoke all on aprs_packets from anon, authenticated;
revoke all on partitions.aprs_packets_default from anon, authenticated;

-- Packets per UTC hour, added to by every ingest batch. The Sources page reads
-- its 24-hour count here instead of counting millions of rows, and the hours
-- outlive the two-day window. Service role only.
create table aprs_packet_hours (
  hour_start timestamptz primary key,
  packets    bigint      not null
);

alter table aprs_packet_hours enable row level security;
revoke all on aprs_packet_hours from anon, authenticated;

-- The partition for one UTC day, as create_rbn_spots_partition does it: built
-- standalone, the default partition's rows for the day moved in under a lock on
-- the default partition, then attached (which builds its indexes).
create function public.create_aprs_packets_partition(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text        := 'aprs_packets_' || to_char(p_day, 'YYYYMMDD');
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if to_regclass('partitions.' || v_name) is not null then
    return;
  end if;
  lock table partitions.aprs_packets_default in exclusive mode;
  if to_regclass('partitions.' || v_name) is not null then
    return;
  end if;
  execute format('create table partitions.%I (like aprs_packets including defaults including constraints)', v_name);
  execute format(
    'with moved as (delete from partitions.aprs_packets_default where received_at >= %L and received_at < %L returning *)
     insert into partitions.%I select * from moved',
    v_from, v_to, v_name);
  execute format('alter table aprs_packets attach partition partitions.%I for values from (%L) to (%L)', v_name, v_from, v_to);
  execute format('alter table partitions.%I enable row level security', v_name);
  execute format('revoke all on partitions.%I from anon, authenticated', v_name);
end;
$$;

-- One batch from ingest-aprs. Keys match the columns (AprsPacketRow in
-- _shared/types.ts). Returns the number of rows inserted; the hourly counts
-- grow by the same rows. Both inserts are data-modifying CTEs, which Postgres
-- runs to completion whether or not the outer query reads them.
create function public.ingest_aprs_packets(p_rows jsonb)
returns int
language sql
security definer
set search_path = public
as $$
  with ins as (
    insert into aprs_packets (
      received_at, source_call, destination, path, q_construct, igate, packet_type, line, line_md5
    )
    select x.received_at, x.source_call, x.destination, x.path, x.q_construct, x.igate,
           x.packet_type, x.line, md5(x.line)::uuid
    from jsonb_to_recordset(p_rows) as x(
      received_at timestamptz, source_call text, destination text, path text, q_construct text,
      igate text, packet_type text, line text
    )
    on conflict do nothing
    returning received_at
  ),
  hours as (
    insert into aprs_packet_hours (hour_start, packets)
    select date_bin(interval '1 hour', i.received_at, timestamptz '2000-01-01 00:00+00'), count(*)
    from ins i
    group by 1
    on conflict (hour_start) do update set packets = aprs_packet_hours.packets + excluded.packets
    returning 1
  )
  select (select count(*)::int from ins);
$$;

-- Archive: five-minute slices (about 30,000 packets at 100 a second), archived
-- by their own cron job below so APRS never shares the other sources' budget.
-- The other branches are unchanged from 20261012000020.
create or replace function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
           when 'rbn' then 10
           when 'pota' then 60
           when 'sotawatch' then 60
           when 'dxcluster' then 60
           when 'aprs' then 5
         end;
$$;

create or replace function public.archive_pending_slices(p_source text, p_before timestamptz, p_limit int)
returns table (slice_start timestamptz, slice_end timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select make_interval(mins => public.archive_slice_minutes(p_source)) as step
  ),
  first_spot as (
    select case
             when p_source = 'rbn' then (select min(r.spot_time) from rbn_spots r)
             when p_source = 'aprs' then (select min(a.received_at) from aprs_packets a)
             else (select min(s.spot_time) from raw_spots s where s.source = p_source)
           end as t
  )
  select g.s, g.s + cfg.step
  from cfg, first_spot,
       generate_series(date_trunc('day', first_spot.t at time zone 'utc') at time zone 'utc',
                       p_before - cfg.step, cfg.step) as g(s)
  where first_spot.t is not null
    and not exists (select 1 from archive_log l where l.source = p_source and l.slice_start = g.s)
  order by g.s
  limit p_limit;
$$;

-- APRS objects carry every column but line_md5, which only orders packets
-- received in the same instant.
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
  elsif p_source = 'aprs' then
    return query
      select count(*)::int,
             coalesce(string_agg(to_json(r)::text, E'\n' order by x.received_at, x.line_md5), '')
      from aprs_packets x
      cross join lateral (
        select x.received_at, x.source_call, x.destination, x.path, x.q_construct, x.igate,
               x.packet_type, x.line
      ) r
      where x.received_at >= p_from and x.received_at < p_to;
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
from (values ('pota'), ('sotawatch'), ('rbn'), ('dxcluster'), ('aprs')) as s(source);

revoke all on archive_status from anon, authenticated;

-- Sources page counts. APRS counts its last hour from aprs_packets (a few
-- hundred thousand rows of the received_at index) and its day from
-- aprs_packet_hours: the hours that started in the last 24, so the figure runs
-- up to an hour short. Counting a whole day of packets on every page load would
-- read millions of rows. The other branches are unchanged from 20261011000008.
create or replace view ingest_health
with (security_invoker = true)
as
select
  s.source,
  s.last_run_at,
  s.last_success_at,
  extract(epoch from (now() - s.last_success_at))::int as seconds_since_last_success,
  s.consecutive_failures,
  s.last_error,
  case
    when s.source = 'rbn'
      then (select count(*) from rbn_spots r where r.spot_time > now() - interval '1 hour')
    when s.source = 'aprs'
      then (select count(*) from aprs_packets a where a.received_at > now() - interval '1 hour')
    else (select count(*) from raw_spots r where r.source = s.source and r.ingested_at > now() - interval '1 hour')
  end as spots_last_hour,
  case
    when s.source = 'rbn'
      then (select count(*) from rbn_spots r where r.spot_time > now() - interval '24 hours')
    when s.source = 'aprs'
      then (select coalesce(sum(h.packets), 0)::bigint from aprs_packet_hours h
            where h.hour_start > now() - interval '24 hours')
    else (select count(*) from raw_spots r where r.source = s.source and r.ingested_at > now() - interval '24 hours')
  end as spots_last_24h,
  s.total_spots_ingested
from ingest_state s;

revoke all on ingest_health from anon, authenticated;

-- Retention, as for rbn_spots (20261011000005) with five-minute slices: a day is
-- dropped only when every one of its 288 slices is in archive_log with the
-- database's count. A mismatched slice loses its log row so the next archive run
-- writes it again, and the day is checked again the next night.
create function public.aprs_day_slices(p_day date)
returns table (slice_start timestamptz, db_rows int, archived_rows int)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_day::timestamp at time zone 'utc' as day_from,
           (p_day + 1)::timestamp at time zone 'utc' as day_to,
           make_interval(mins => public.archive_slice_minutes('aprs')) as step
  ),
  counts as (
    select date_bin(b.step, a.received_at, timestamptz '2000-01-01 00:00+00') as s,
           count(*)::int as n
    from aprs_packets a, bounds b
    where a.received_at >= b.day_from and a.received_at < b.day_to
    group by 1
  )
  select g.s, coalesce(c.n, 0), l.row_count
  from bounds b,
       generate_series(b.day_from, b.day_to - b.step, b.step) as g(s)
  left join counts c on c.s = g.s
  left join archive_log l on l.source = 'aprs' and l.slice_start = g.s
  order by g.s;
$$;

create function public.aprs_day_archived(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bad   int;
  v_reset int;
begin
  with s as (select * from public.aprs_day_slices(p_day)),
  reset as (
    delete from archive_log l
    using s
    where l.source = 'aprs' and l.slice_start = s.slice_start and l.row_count <> s.db_rows
    returning 1
  )
  select (select count(*) from s where s.archived_rows is distinct from s.db_rows),
         (select count(*) from reset)
    into v_bad, v_reset;
  return v_bad = 0;
end;
$$;

create function public.retire_aprs_day(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute format('drop table if exists partitions.%I', 'aprs_packets_' || to_char(p_day, 'YYYYMMDD'));
  delete from partitions.aprs_packets_default
  where received_at >= p_day::timestamp at time zone 'utc'
    and received_at < (p_day + 1)::timestamp at time zone 'utc';
end;
$$;

-- Daily: partitions for today and the next three UTC days, then retention. A
-- day is eligible once it is two days old (on the 16th, the 14th and earlier),
-- so the database holds yesterday and today: between one and about two days of
-- packets. Every eligible day is checked first and the drops come last, under a
-- short lock_timeout, as in maintain_rbn_spots.
create function public.maintain_aprs_packets()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
  v_drop  date[] := '{}'::date[];
begin
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    perform public.create_aprs_packets_partition(v_day);
  end loop;

  for v_day in
    select to_date(substr(c.relname, 14), 'YYYYMMDD')
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.aprs_packets'::regclass and c.relname ~ '^aprs_packets_[0-9]{8}$'
    union
    select distinct (d.received_at at time zone 'utc')::date from partitions.aprs_packets_default d
    order by 1
  loop
    continue when v_day > v_today - 2;
    if public.aprs_day_archived(v_day) then
      v_drop := v_drop || v_day;
    end if;
  end loop;

  perform set_config('lock_timeout', '5s', true);
  foreach v_day in array v_drop loop
    begin
      perform public.retire_aprs_day(v_day);
    exception when lock_not_available then
      raise warning 'aprs retention: % not dropped (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;
end;
$$;

revoke all on function public.create_aprs_packets_partition(date) from public, anon, authenticated;
revoke all on function public.ingest_aprs_packets(jsonb) from public, anon, authenticated;
revoke all on function public.aprs_day_slices(date) from public, anon, authenticated;
revoke all on function public.aprs_day_archived(date) from public, anon, authenticated;
revoke all on function public.retire_aprs_day(date) from public, anon, authenticated;
revoke all on function public.maintain_aprs_packets() from public, anon, authenticated;
grant execute on function public.ingest_aprs_packets(jsonb) to service_role;
grant execute on function public.maintain_aprs_packets() to service_role;

select public.maintain_aprs_packets();

-- Off the RBN job (03:35) so the two never hold partition locks together.
select cron.schedule('maintain-aprs-packets', '45 3 * * *', $$ select public.maintain_aprs_packets(); $$);

-- Every five minutes, two minutes off the */10 archive-spots grid: archive with
-- {"sources": ["aprs"]}. The function's 60,000-row budget is two APRS slices a
-- run, so a backlog clears at about twice real time.
select cron.schedule(
  'archive-aprs',
  '2-59/5 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
             || '/functions/v1/archive',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
      ),
      body := '{"sources": ["aprs"]}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);
