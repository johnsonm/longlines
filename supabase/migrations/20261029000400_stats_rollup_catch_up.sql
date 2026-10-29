-- Stats day rollups catch up a few days an hour (review 4, database: ingest, finding 1).
--
-- refresh_stats_rollups_at rolled up every window day lacking a rollup in one statement. After a
-- gap of about four days (an outage, a bad deploy, a raise in one loop) a run had about 120 s of
-- APRS-IS days alone (30 s each on hosted), hit the cron session's 2-minute statement_timeout and
-- rolled back every day it had finished, every hour. maintain_aprs_packets keeps an APRS-IS day
-- until its rollup is final, so the stall also held up to 6 days of packets (about 2.5 GB each).
--
-- 1. refresh_stats_rollups_at(p_now, p_max_rbn_days, p_max_aprs_days, p_max_country_days): the
--    body of 20261022000100's refresh_stats_rollups_at, each loop taking at most its cap of days,
--    oldest first (null is no cap). Missing days and the re-roll of a day rolled up within an hour
--    of its end both count against the cap, in day order. A country day also waits for its RBN
--    day, which a capped run may not have reached. The top-station recount is unchanged: it runs
--    when an RBN day was rolled or the window moved.
-- 2. refresh_stats_rollups_at(p_now) calls it without caps, so refresh_stats_snapshot_at, seed.sql
--    and the tests still roll the whole window in one call.
-- 3. refresh_stats_rollups() (cron, rollup-stats-days at :01) passes 3 RBN, 2 APRS-IS and 3
--    country days: about 2 x 30 + 3 x 2 + 3 x 4 = 78 s at hosted's per-day costs plus the
--    top-station recount, inside the 2-minute timeout. A backlog of the whole window clears in
--    four runs.

create function public.refresh_stats_rollups_at(p_now timestamptz, p_max_rbn_days int,
                                                 p_max_aprs_days int, p_max_country_days int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_end   timestamptz := date_trunc('day', p_now at time zone 'utc') at time zone 'utc';
  v_window_start timestamptz := (date_trunc('day', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_first_day    date        := (p_now at time zone 'utc')::date - 7;
  v_end_day      date        := (p_now at time zone 'utc')::date;
  v_day          date;
  v_rolled       boolean     := false;
begin
  -- RBN rollups: every window day without one, and any day rolled up within
  -- an hour of its end (see 20261011000007), oldest first, at most p_max_rbn_days.
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join rbn_rollup_days l on l.day = v_first_day + i
    where l.day is null
       or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
    order by i
    limit p_max_rbn_days
  loop
    perform public.rollup_rbn_day(v_day);
    v_rolled := true;
  end loop;
  delete from rbn_hourly where hour < v_window_start;
  delete from rbn_daily_skimmers where day < v_first_day;
  delete from rbn_daily_stations where day < v_first_day;
  delete from rbn_rollup_days where day < v_first_day;

  -- APRS rollups (20261014000030): the same rule as the RBN days, at most
  -- p_max_aprs_days. Retention keeps a day until it has a final rollup, so a
  -- re-roll never finds it gone.
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join aprs_rollup_days l on l.day = v_first_day + i
    where l.day is null
       or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
    order by i
    limit p_max_aprs_days
  loop
    perform public.rollup_aprs_day(v_day);
  end loop;
  delete from aprs_daily_stations where day < v_first_day;
  delete from aprs_daily_igates where day < v_first_day;
  delete from aprs_daily_types where day < v_first_day;

  -- Country rollups (20261015000100): the same rule again, at most
  -- p_max_country_days, after the RBN days so rbn_daily_stations is final. A
  -- day whose RBN day a capped run has not rolled up yet waits for it. A day is
  -- skipped, not marked, while no cty.dat is loaded, so it rolls up once
  -- import-cty has run.
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join country_rollup_days l on l.day = v_first_day + i
    where (l.day is null
           or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour')
      and exists (select 1 from rbn_rollup_days r where r.day = v_first_day + i)
    order by i
    limit p_max_country_days
  loop
    perform public.rollup_country_day(v_day);
  end loop;
  delete from country_daily_spots where day < v_first_day;
  delete from country_rollup_days where day < v_first_day;

  -- Most heard stations by base call, recounted only when a day rollup changed
  -- or the window moved (see 20261012000090). Skimmers are the distinct
  -- spotters of any form of the call over the week, from the days' spotter
  -- lists (20261022000100), never from rbn_spots.
  if v_rolled or not exists (select 1 from rbn_top_stations where window_start = v_window_start) then
    delete from rbn_top_stations;
    insert into rbn_top_stations (window_start, callsign, spots, skimmers)
    with week as materialized (
      select callsign, sum(spots) as n
      from rbn_daily_stations
      where day >= v_first_day and day < v_end_day
      group by callsign
    ),
    bases as materialized (
      select callsign, public.base_callsign(callsign) as base, n from week
    ),
    top as (
      select base, sum(n)::int as n
      from bases
      group by base
      order by n desc, base asc
      limit 8
    )
    select v_window_start, t.base, t.n,
           (select count(distinct s.spotter)
            from bases b
            join rbn_daily_stations d
              on d.callsign = b.callsign and d.day >= v_first_day and d.day < v_end_day
            cross join unnest(d.spotters) as s(spotter)
            where b.base = t.base)
    from top t;
  end if;
end;
$$;

comment on function public.refresh_stats_rollups_at(timestamptz, int, int, int) is
  'Rolls up the RBN, APRS and country days of the Stats window as of p_now (each missing day, and once more any day rolled up within an hour of its end), oldest first and at most the given number of days per kind (null: no cap), and recounts the RBN top stations. Cron only, through refresh_stats_rollups().';

revoke all on function public.refresh_stats_rollups_at(timestamptz, int, int, int) from public, anon, authenticated;

create or replace function public.refresh_stats_rollups_at(p_now timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  select public.refresh_stats_rollups_at(p_now, null, null, null);
$$;
comment on function public.refresh_stats_rollups_at(timestamptz) is
  'Rolls up every RBN, APRS and country day of the Stats window that needs it as of p_now, without a cap, and recounts the RBN top stations. For refresh_stats_snapshot_at, seed and tests.';

create or replace function public.refresh_stats_rollups()
returns void
language sql
security definer
set search_path = public
as $$
  select public.refresh_stats_rollups_at(now(), 3, 2, 3);
$$;
comment on function public.refresh_stats_rollups() is
  'Runs refresh_stats_rollups_at(now()) with at most 3 RBN, 2 APRS-IS and 3 country days a run. Cron only (rollup-stats-days).';

