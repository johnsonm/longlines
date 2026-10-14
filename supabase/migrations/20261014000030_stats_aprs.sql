-- APRS-IS on the Stats page. Spec: docs/superpowers/specs/2026-10-14-aprs-stats-design.md.
--
-- 20261014000010 kept APRS out of Stats; this supersedes that. Packets still
-- never reach raw_spots, matching, spot_stream or the callsign rollups.
--
-- aprs_packets keeps about two days and the Stats window is seven, so the
-- figures that cannot be summed from aprs_packet_hours (distinct stations,
-- distinct igates, packets per type) are rolled up per UTC day by the hourly
-- stats refresh, as rbn_spots is. maintain_aprs_packets keeps a day until it
-- has been rolled up at least an hour after it ended, and never rolls it up
-- itself.

create table aprs_daily_stations (
  day  date not null,
  base text not null,
  primary key (day, base)
);

create table aprs_daily_igates (
  day   date not null,
  igate text not null,
  primary key (day, igate)
);

create table aprs_daily_types (
  day         date   not null,
  packet_type text   not null,
  packets     bigint not null,
  primary key (day, packet_type)
);

-- When each day was last rolled up. Never pruned (one row a day), so the
-- retention guard below never loses a marker.
create table aprs_rollup_days (
  day       date        primary key,
  rolled_at timestamptz not null
);

alter table aprs_daily_stations enable row level security;
alter table aprs_daily_igates enable row level security;
alter table aprs_daily_types enable row level security;
alter table aprs_rollup_days enable row level security;
revoke all on aprs_daily_stations, aprs_daily_igates, aprs_daily_types, aprs_rollup_days
  from anon, authenticated;

-- Rolls up one UTC day in one statement, so the whole-day check and the
-- inserts read the same snapshot. The day is refused (false, nothing written)
-- unless its rows in aprs_packets add up to its aprs_packet_hours: ingest
-- writes both in one statement, so they differ only once packets are gone.
-- A day's packets only ever grow until it is retired, so upserts replace an
-- earlier rollup without a delete. Stations are base calls, worked out once
-- per distinct source_call; igates are kept as sent.
create function public.rollup_aprs_day(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  with bounds as (
    select p_day::timestamp at time zone 'utc' as t_from,
           (p_day + 1)::timestamp at time zone 'utc' as t_to
  ),
  grouped as materialized (
    select a.source_call, a.igate, a.packet_type, count(*) as n
    from aprs_packets a, bounds b
    where a.received_at >= b.t_from and a.received_at < b.t_to
    group by 1, 2, 3
  ),
  whole as (
    select coalesce((select sum(g.n) from grouped g), 0)
             = coalesce((select sum(h.packets) from aprs_packet_hours h, bounds b
                         where h.hour_start >= b.t_from and h.hour_start < b.t_to), 0) as ok
  ),
  calls as materialized (
    select g.source_call from grouped g, whole w where w.ok group by g.source_call
  ),
  stations as (
    insert into aprs_daily_stations (day, base)
    select distinct p_day, public.base_callsign(c.source_call) from calls c
    on conflict do nothing
  ),
  igates as (
    insert into aprs_daily_igates (day, igate)
    select distinct p_day, g.igate from grouped g, whole w where w.ok and g.igate is not null
    on conflict do nothing
  ),
  types as (
    insert into aprs_daily_types (day, packet_type, packets)
    select p_day, g.packet_type, sum(g.n) from grouped g, whole w where w.ok group by g.packet_type
    on conflict (day, packet_type) do update set packets = excluded.packets
  ),
  marker as (
    insert into aprs_rollup_days (day, rolled_at)
    select p_day, now() from whole w where w.ok
    on conflict (day) do update set rolled_at = excluded.rolled_at
  )
  select w.ok into v_ok from whole w;

  if not v_ok then
    raise warning 'aprs stats rollup: % refused, its packets no longer match aprs_packet_hours', p_day;
  end if;
  return v_ok;
end;
$$;

revoke all on function public.rollup_aprs_day(date) from public, anon, authenticated;

-- As in 20261014000010, plus the Stats guard: an archived day is dropped only
-- once aprs_rollup_days shows it rolled up at least an hour after it ended
-- (the refresh re-rolls anything earlier, for late relay batches). Without
-- that it stays until the next night.
create or replace function public.maintain_aprs_packets()
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
      if exists (select 1 from aprs_rollup_days r
                 where r.day = v_day
                   and r.rolled_at >= (v_day + 1)::timestamp at time zone 'utc' + interval '1 hour') then
        v_drop := v_drop || v_day;
      else
        raise warning 'aprs retention: % kept until the Stats rollup has it', v_day;
      end if;
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
