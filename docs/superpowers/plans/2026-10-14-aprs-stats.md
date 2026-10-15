# APRS-IS on the Stats page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count APRS-IS packets in the Stats page's volume figures and add an APRS-IS section
(packets, stations heard, igates, packet types), without touching matching or subscription sources.

**Architecture:** One migration adds four service-role-only rollup tables and `rollup_aprs_day`,
which the hourly `refresh_stats_snapshot_at` calls per window day (the RBN pattern).
`maintain_aprs_packets` refuses to drop a day until it has been rolled up at least an hour after it
ended. Packet volume comes from the existing `aprs_packet_hours`. The payload gains `daily[].aprs`,
`hourly[].aprs` and an `aprs` object, and the web page renders them.

**Tech Stack:** Postgres (plpgsql, pg_cron), pgTAP, React + MUI 9 + MUI X Charts (community),
Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-aprs-stats-design.md`

## Global Constraints

- Work in the worktree `/Users/bradbazemore/Dev/longlines-aprs-stats` (branch `aprs-stats`). Never
  `git checkout` in `/Users/bradbazemore/Dev/longlines`.
- Migration file name: `supabase/migrations/20261014000030_stats_aprs.sql`. Never edit an applied
  migration.
- APRS never reaches `raw_spots`, matching, `spot_stream`, the subscription sources, profiles or the
  callsign rollups.
- New tables: RLS on, no policies, `revoke all ... from anon, authenticated`. New functions:
  `security definer`, `set search_path = public`, `revoke all ... from public, anon, authenticated`.
- Group a day by `source_call` before calling `base_callsign()`.
- Never run `supabase db push`, `supabase functions deploy`, `fly deploy` or `fly secrets set`.
- Web: `sx` for layout only; MUI 9 `Grid size`; colours from the theme (APRS is
  `theme.palette.success.main`).
- Copy is word for word from the spec's Page section:
  - Section heading `APRS-IS`, body "Every packet on the APRS-IS full feed. Packets aren't spots and
    never trigger alerts."
  - KPIs "APRS packets" / "Every packet on the full feed", "Stations heard" / "Unique callsigns that
    sent a packet, SSIDs combined", "Igates" / "Unique gateways that passed a packet to APRS-IS".
  - Chart "Packet types" / "What APRS stations sent".
  - Per-day chart `APRS` / `{n} packets`.
  - Spots processed detail `{rbn} RBN, {aprs} APRS, {pota} POTA, {sota} SOTA`.
  - Spots per day text "One chart per source. RBN and APRS run 100 times the volume of POTA or more,
    so they don't share a scale."
  - Type labels: Position, Mic-E, Object, Item, Message, Status, Weather, Telemetry, NMEA, Third
    party, Capabilities, Query, User defined, Other.
- pgTAP needs a freshly reset local DB: `supabase db reset` before `supabase test db` (another
  session may share the stack; re-run the reset if a suite fails on foreign rows).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A late relay batch for yesterday lands after the 00:05 rollup: the 01:05 refresh must re-roll the
   day, and stations, igates and types must grow with no duplicate rows (Task 1 re-roll test, Task 2
   late-packet test).
2. The same operator under several SSIDs or in lower case (`K4ABC-9`, `K4ABC-7`, `k4abc-5`) must
   count as one station (Task 1 stations test).
3. A packet with no igate (no q-construct) must not add a null igate (Task 1 igates test, Task 2
   igates count).
4. The SQL list of packet types drifting from `aprs_packets`' check constraint would silently drop a
   type from the chart (Task 2 `set_eq` against the constraint).
5. The newest snapshot written before the migration (no `aprs`, no `daily[].aprs`/`hourly[].aprs`)
   must render zeros, not crash, for up to an hour after deploy (Task 3 old-snapshot test).

---

### Task 1: APRS day rollup and the retention guard

**Files:**

- Create: `supabase/migrations/20261014000030_stats_aprs.sql` (first half: tables,
  `rollup_aprs_day`, `maintain_aprs_packets`)
- Modify: `supabase/tests/aprs.test.sql`

**Interfaces:**

- Produces:
  - tables `aprs_daily_stations(day date, base text, pk (day, base))`,
    `aprs_daily_igates(day date, igate text, pk (day, igate))`,
    `aprs_daily_types(day date, packet_type text, packets bigint, pk (day, packet_type))`,
    `aprs_rollup_days(day date pk, rolled_at timestamptz)`
  - `public.rollup_aprs_day(p_day date) returns boolean`: true when rolled (marker written), false
    when refused.

- [ ] **Step 1: Write the failing tests in `supabase/tests/aprs.test.sql`**

Change the header comment's first line list to include "the Stats rollup and its retention guard",
and `select plan(39);` to `select plan(54);`.

Add to the cleanup at the top, after `delete from archive_log where source = 'aprs';`:

```sql
delete from aprs_daily_stations;
delete from aprs_daily_igates;
delete from aprs_daily_types;
delete from aprs_rollup_days;
```

Add a helper after `pg_temp.pkt`:

```sql
-- A packet of a given type through a given igate (null: no q-construct, no igate).
create or replace function pg_temp.typed(p_time timestamptz, p_call text, p_type text, p_igate text)
returns jsonb language sql as $$
  select pg_temp.pkt(p_time, p_call) || jsonb_build_object('packet_type', p_type, 'igate', p_igate);
$$;
```

Insert a new section between `select ok((select source = 'aprs' from archive_status ...` and
`-- Retention.`:

```sql
-- Stats rollup (20261014000030).
delete from aprs_packets;
delete from aprs_packet_hours;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.typed(pg_temp.at(-1, '10:00'), 'K4ABC-9', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-1, '10:01'), 'K4ABC-7', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-1, '10:02'), 'k4abc-5', 'mic_e', 'W2DEF'),
  pg_temp.typed(pg_temp.at(-1, '10:03'), 'N0XYZ', 'message', 'W2DEF'),
  pg_temp.typed(pg_temp.at(-1, '10:04'), 'MYANET', 'status', null),
  pg_temp.typed(pg_temp.at(-1, '11:04'), 'MYANET', 'status', null)));
select is(rollup_aprs_day(pg_temp.d(-1)), true, 'rollup_aprs_day rolls up a whole day');
select results_eq(
  format('select base from aprs_daily_stations where day = %L order by 1', pg_temp.d(-1)),
  $$values ('K4ABC'), ('MYANET'), ('N0XYZ')$$,
  'stations are base calls: SSIDs and lower case fold into one');
select results_eq(
  format('select igate from aprs_daily_igates where day = %L order by 1', pg_temp.d(-1)),
  $$values ('W1ABC-10'), ('W2DEF')$$,
  'igates are counted as sent; a packet without one adds none');
select results_eq(
  format('select packet_type, packets from aprs_daily_types where day = %L order by 1', pg_temp.d(-1)),
  $$values ('message', 1::bigint), ('mic_e', 1::bigint), ('position', 2::bigint), ('status', 2::bigint)$$,
  'packets are counted per type');
select ok((select rolled_at = now() from aprs_rollup_days where day = pg_temp.d(-1)), 'the rolled day gets a marker');

-- A late packet: rolling up again adds it without duplicating anything.
select ingest_aprs_packets(jsonb_build_array(pg_temp.typed(pg_temp.at(-1, '23:59'), 'W9NEW', 'position', 'W1ABC-10')));
select is(rollup_aprs_day(pg_temp.d(-1)), true, 'a day can be rolled up again');
select is((select count(*) from aprs_daily_stations where day = pg_temp.d(-1))::int, 4, 'the late station joins');
select results_eq(
  format('select count(*)::int, sum(packets) filter (where packet_type = ''position'')::int from aprs_daily_types where day = %L', pg_temp.d(-1)),
  'values (4, 3)', 'a re-roll replaces the type counts');

-- A day missing packets that its hourly counts have (retired, say) is refused and left alone.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.typed(pg_temp.at(-2, '10:00'), 'A9', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-2, '11:00'), 'B9', 'position', 'W1ABC-10')));
delete from aprs_packets where source_call = 'B9';
select is(rollup_aprs_day(pg_temp.d(-2)), false, 'rollup_aprs_day refuses a day missing packets');
select ok(not exists (select 1 from aprs_rollup_days where day = pg_temp.d(-2))
          and not exists (select 1 from aprs_daily_stations where day = pg_temp.d(-2)),
  'a refused day gets no marker and no rows');
select ok(rollup_aprs_day(pg_temp.d(-9)) and exists (select 1 from aprs_rollup_days where day = pg_temp.d(-9)),
  'a day without packets rolls up as empty');
```

Replace the Retention setup (from `-- Retention.` through the
`select log_archive('aprs', pg_temp.at(-3, '11:00') ...` line) with:

```sql
-- Retention.
delete from aprs_packets;
delete from aprs_packet_hours;
delete from aprs_rollup_days;
delete from archive_log where source = 'aprs';
-- Day -2: archived with matching counts, rolled up.              -> dropped
-- Day -3: one slice logged with the wrong count.                 -> kept, that log row deleted
-- Day -4: never archived.                                        -> kept
-- Day -5: archived, rolled up within an hour of its end.         -> kept
-- Day -6: rows only in the default partition, archived, rolled up -> rows deleted
-- Day -7: archived, never rolled up for Stats.                   -> kept
-- Day -1: archived but recent.                                   -> kept
select create_aprs_packets_partition(pg_temp.d(o)) from unnest(array[-7, -5, -4, -3, -2, -1]) as o;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(-2, '10:01'), 'A1'), pg_temp.pkt(pg_temp.at(-2, '10:02'), 'A2'),
  pg_temp.pkt(pg_temp.at(-3, '11:01'), 'B1'), pg_temp.pkt(pg_temp.at(-3, '11:02'), 'B2'),
  pg_temp.pkt(pg_temp.at(-4, '12:00'), 'C1'),
  pg_temp.pkt(pg_temp.at(-5, '09:00'), 'F1'),
  pg_temp.pkt(pg_temp.at(-6, '13:00'), 'D1'),
  pg_temp.pkt(pg_temp.at(-7, '08:00'), 'G1'),
  pg_temp.pkt(pg_temp.at(-1, '14:00'), 'E1')));
select pg_temp.archive_day(o) from unnest(array[-1, -2, -3, -5, -6, -7]) as o;
select log_archive('aprs', pg_temp.at(-3, '11:00'), pg_temp.at(-3, '11:05'), 1, 100, 'aprs/test');
select rollup_aprs_day(pg_temp.d(o)) from unnest(array[-2, -3, -5, -6]) as o;
update aprs_rollup_days set rolled_at = pg_temp.at(-4, '00:30') where day = pg_temp.d(-5);
```

Add after `select ok(pg_temp.partition(-1) is not null, 'yesterday is kept even when archived');`:

```sql
select ok(pg_temp.partition(-5) is not null, 'a day rolled up within an hour of its end is kept');
select ok(pg_temp.partition(-7) is not null, 'a day the Stats rollup never saw is kept');
```

Add to `-- Grants and jobs.`, after the existing function-privilege `ok`:

```sql
select ok(not has_table_privilege('authenticated', 'aprs_daily_stations', 'select')
          and not has_table_privilege('authenticated', 'aprs_daily_igates', 'select')
          and not has_table_privilege('authenticated', 'aprs_daily_types', 'select')
          and not has_table_privilege('authenticated', 'aprs_rollup_days', 'select')
          and not has_table_privilege('anon', 'aprs_daily_stations', 'select'),
  'clients cannot read the APRS Stats rollups');
select ok(not has_function_privilege('authenticated', 'public.rollup_aprs_day(date)', 'execute')
          and not has_function_privilege('anon', 'public.rollup_aprs_day(date)', 'execute'),
  'clients cannot run the APRS Stats rollup');
```

- [ ] **Step 2: Run the suite and see it fail**

Run:
`cd /Users/bradbazemore/Dev/longlines-aprs-stats && supabase db reset && supabase test db supabase/tests/aprs.test.sql`
Expected: FAIL, `relation "aprs_daily_stations" does not exist`.

- [ ] **Step 3: Write the first half of the migration**

Create `supabase/migrations/20261014000030_stats_aprs.sql`:

```sql
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
```

`create or replace` keeps `maintain_aprs_packets`' existing grants (service_role only).

- [ ] **Step 4: Run the suite and see it pass**

Run:
`cd /Users/bradbazemore/Dev/longlines-aprs-stats && supabase db reset && supabase test db supabase/tests/aprs.test.sql`
Expected: `ok` for all 54, `Result: PASS`.

Also run: `supabase test db supabase/tests/advisor.test.sql`. Expected: PASS unchanged (the function
pins `search_path` and is not client-callable).

- [ ] **Step 5: Commit**

```bash
cd /Users/bradbazemore/Dev/longlines-aprs-stats
git add supabase/migrations/20261014000030_stats_aprs.sql supabase/tests/aprs.test.sql
git commit -m "APRS Stats rollup: per-day stations, igates and packet types; retention waits for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: APRS in the Stats snapshot

**Files:**

- Modify: `supabase/migrations/20261014000030_stats_aprs.sql` (append the refresh)
- Modify: `supabase/tests/stats_snapshot.test.sql`
- Modify: `CLAUDE.md`, `docs/ARCHITECTURE.md`

**Interfaces:**

- Consumes: `rollup_aprs_day(date) returns boolean`, `aprs_daily_*`, `aprs_rollup_days` (Task 1);
  `aprs_packet_hours(hour_start, packets)` (20261014000010).
- Produces payload additions (Task 3 types them):
  - `daily[i].aprs: number`, `hourly[i].aprs: number`
  - `aprs: { packets: number, stations: number, igates: number, types: [{ type: string, packets: number }] }`,
    where `types` holds all 14 packet types ordered by packets desc then type asc.

- [ ] **Step 1: Write the failing tests in `supabase/tests/stats_snapshot.test.sql`**

Header comment: add "the APRS rollups" to the list. `select plan(126);` becomes `select plan(146);`.

Add to the cleanup block after `delete from rbn_rollup_hours;`:

```sql
delete from aprs_packets;
delete from aprs_packet_hours;
delete from aprs_daily_stations;
delete from aprs_daily_igates;
delete from aprs_daily_types;
delete from aprs_rollup_days;
```

Add a helper after `pg_temp.snap()`:

```sql
-- One APRS packet for ingest_aprs_packets (null igate: no q-construct).
create or replace function pg_temp.aprs(p_time timestamptz, p_call text, p_type text, p_igate text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'received_at', p_time, 'source_call', p_call, 'destination', 'APRS', 'path', 'WIDE1-1',
    'q_construct', case when p_igate is not null then 'qAR' end, 'igate', p_igate,
    'packet_type', p_type, 'line', p_call || '>APRS,WIDE1-1:' || p_type);
$$;
```

After the `insert into rbn_daily_stations ... 'OLD1'` line, add:

```sql
-- APRS-IS, through ingest so aprs_packet_hours counts them. Four in-window packets: K4ABC under two
-- SSIDs on day 2 at 20 UTC, and N0XYZ and MYANET (no igate) on day 6 at 23 UTC. Today and eight days
-- ago are out.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.aprs(pg_temp.at_utc(2, 20), 'K4ABC-9', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(2, 20) + interval '1 minute', 'K4ABC-7', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(6, 23), 'N0XYZ', 'message', 'W2DEF'),
  pg_temp.aprs(pg_temp.at_utc(6, 23) + interval '1 minute', 'MYANET', 'status', null),
  pg_temp.aprs(pg_temp.at_utc(7, 1), 'XX1OUT', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(-1, 12), 'XX1OUT', 'position', 'W1ABC-10')));
-- An APRS rollup left from a day before the window; the refresh deletes it.
insert into aprs_daily_stations (day, base) values ((pg_temp.at_utc(-2, 0) at time zone 'utc')::date, 'OLD1');
```

Edit these existing assertions to carry `aprs` (each `jsonb_build_object` gains one pair;
descriptions unchanged unless shown):

```sql
select is(pg_temp.snap() -> 'daily' -> 0, jsonb_build_object('day', pg_temp.day_str(0), 'pota', 0, 'sota', 0, 'rbn', 0, 'aprs', 0), 'daily starts at the oldest day and a day without spots is zero-filled');
select is(pg_temp.snap() -> 'daily' -> 1, jsonb_build_object('day', pg_temp.day_str(1), 'pota', 3, 'sota', 0, 'rbn', 0, 'aprs', 0), 'daily POTA count for day 1');
select is(pg_temp.snap() -> 'daily' -> 6, jsonb_build_object('day', pg_temp.day_str(6), 'pota', 0, 'sota', 4, 'rbn', 1, 'aprs', 2), 'daily ends yesterday with the SOTA, RBN and APRS counts');
```

In the hourly section, `hourly -> 0` gains `'aprs', 0`, and `hourly -> 68` gains `'aprs', 2` with
the description `'day 2 at 20 UTC: one POTA spot, four RBN spots and two APRS packets'`. In the
02:10 section, `hourly -> 166` gains `'aprs', 0` and `hourly -> 167` gains `'aprs', 1` with the
description `'hourly ends at 01:00 UTC today, with its RBN spot and APRS packet'`.

After
`select is((select count(*) from rbn_daily_stations where callsign = 'OLD1'), 0::bigint, ...);` add:

```sql
-- aprs: packets from aprs_packet_hours, the rest from the day rollups.
select is((pg_temp.snap() #>> '{daily,2,aprs}')::int, 2, 'daily APRS counts come from aprs_packet_hours');
select is((select sum((e ->> 'aprs')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 4::bigint,
          'hourly APRS adds up to aprs.packets');
select is((pg_temp.snap() #>> '{aprs,packets}')::int, 4, 'aprs.packets counts in-window packets only');
select is((pg_temp.snap() #>> '{aprs,stations}')::int, 3, 'aprs.stations counts base calls: K4ABC-9 and K4ABC-7 are one');
select is((pg_temp.snap() #>> '{aprs,igates}')::int, 2, 'aprs.igates counts igates as sent, never a missing one');
select is(jsonb_array_length(pg_temp.snap() #> '{aprs,types}'), 14, 'aprs.types has every packet type');
select is(pg_temp.snap() #> '{aprs,types,0}', '{"type":"position","packets":2}'::jsonb, 'the busiest type comes first');
select is((select string_agg(e ->> 'type', ',' order by o) from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') with ordinality as t(e, o)),
          'position,message,status,capabilities,item,mic_e,nmea,object,other,query,telemetry,third_party,user_defined,weather',
          'types run busiest first, then by name, zero-filled');
select set_eq(
  $$select e ->> 'type' from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') e$$,
  $$select m[1] from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m
    where c.conrelid = 'aprs_packets'::regclass and c.conname = 'aprs_packets_packet_type_check'$$,
  'aprs.types lists exactly the packet types aprs_packets allows');
select is((select count(*) from aprs_rollup_days), 7::bigint, 'each window day is rolled up for APRS');
select is((select count(*) from aprs_daily_stations where base = 'OLD1'), 0::bigint, 'APRS rollups older than the window are deleted');
select is((select count(*) from aprs_daily_stations where base = 'XX1OUT'), 0::bigint, 'packets outside the window are not rolled up');
```

In the signed-in RLS block, before `reset role;`, add:

```sql
select throws_ok('select count(*) from aprs_daily_stations', '42501', null, 'clients cannot read the APRS rollup');
select throws_ok('select rollup_aprs_day(current_date)', '42501', null, 'clients cannot run the APRS rollup');
```

In the anon block, before `reset role;`, add:

```sql
select throws_ok('select count(*) from aprs_daily_types', '42501', null, 'anon cannot read the APRS rollup');
```

After `select is(jsonb_array_length(pg_temp.snap() #> '{rbn,topStations}'), 4, ...);` (end of the
RBN late-rows block), add:

```sql
-- Late APRS packets. Day 5 was rolled up long after it ended, day 6 five minutes after: only day 6 is
-- rolled up again. Packets count straight away either way, through aprs_packet_hours.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.aprs(pg_temp.at_utc(5, 12), 'LATE1', 'weather', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(6, 23), 'LATE2', 'weather', 'W3GHI')));
update aprs_rollup_days set rolled_at = pg_temp.at_utc(6, 3) where day = (pg_temp.at_utc(5, 0) at time zone 'utc')::date;
update aprs_rollup_days set rolled_at = pg_temp.at_utc(7, 0) + interval '5 minutes' where day = (pg_temp.at_utc(6, 0) at time zone 'utc')::date;
select lives_ok('select pg_temp.refresh()', 'refresh runs after late APRS packets');
select is((pg_temp.snap() #>> '{aprs,packets}')::int, 6, 'late packets count at once through aprs_packet_hours');
select is((pg_temp.snap() #>> '{aprs,stations}')::int, 4, 'a day rolled up within an hour of its end is rolled up again (LATE2); a final day is not (LATE1)');
select is((pg_temp.snap() #>> '{aprs,igates}')::int, 3, 'the re-rolled day adds its igate');
select is((select (e ->> 'packets')::int from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') e where e ->> 'type' = 'weather'), 1,
          'the re-rolled day updates its type counts');
```

- [ ] **Step 2: Run the suite and see it fail**

Run:
`cd /Users/bradbazemore/Dev/longlines-aprs-stats && supabase db reset && supabase test db supabase/tests/stats_snapshot.test.sql`
Expected: FAIL on the `daily`/`hourly` shape assertions and every `aprs` assertion (`aprs` is null).

If the `set_eq` fails because the constraint has a different name, find it with
`select conname from pg_constraint where conrelid = 'aprs_packets'::regclass and contype = 'c'` and
fix the test, not the migration.

- [ ] **Step 3: Append the refresh to the migration**

Append to `supabase/migrations/20261014000030_stats_aprs.sql`:

1. A comment block:

```sql
-- refresh_stats_snapshot_at, as in 20261013000010, plus APRS:
-- - every window day without an aprs_rollup_days marker, or rolled within an
--   hour of its end, goes through rollup_aprs_day (a refused day is retried
--   next hour), and rollup rows older than the window are deleted;
-- - daily[].aprs and hourly[].aprs come from aprs_packet_hours;
-- - payload.aprs holds packets, distinct base calls, distinct igates and all
--   14 packet types (busiest first, then by name). The type list repeats
--   aprs_packets' check constraint; stats_snapshot.test.sql compares them.
```

2. Copy lines 80-534 of `supabase/migrations/20261013000010_stats_hourly_window.sql` (from
   `create function public.refresh_stats_snapshot_at(p_now timestamptz)` through its closing `$$;`)
   verbatim, changing `create function` to `create or replace function`, then make these edits in
   the copy.

Edit A: after `delete from rbn_rollup_hours where hour < v_window_end;` insert:

```sql
-- APRS rollups (20261014000030): the same rule as the RBN days. Retention
-- keeps a day until it has a final rollup, so a re-roll never finds it gone.
for v_day in
  select v_first_day + i
  from generate_series(0, 6) as i
  left join aprs_rollup_days l on l.day = v_first_day + i
  where l.day is null
     or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
  order by i
loop
  perform public.rollup_aprs_day(v_day);
end loop;
delete from aprs_daily_stations where day < v_first_day;
delete from aprs_daily_igates where day < v_first_day;
delete from aprs_daily_types where day < v_first_day;
```

Edit B: after the `daily_rbn as (...)` CTE insert:

```sql
daily_aprs as (
  select to_char(hour_start at time zone 'utc', 'YYYY-MM-DD') as day, sum(packets) as aprs
  from aprs_packet_hours
  where hour_start >= v_window_start and hour_start < v_window_end
  group by 1
),
```

and change the `daily` CTE to:

```sql
daily as (
  select jsonb_agg(
           jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                              'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0))
           order by d.day
         ) as v
  from days d
  left join daily_counts c using (day)
  left join daily_rbn r using (day)
  left join daily_aprs a using (day)
),
```

Edit C: change the `hourly` CTE to:

```sql
hourly as (
  select jsonb_agg(
           jsonb_build_object(
             'hour', to_char(s.slot at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
             'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'rbn', coalesce(h.spots, 0),
             'aprs', coalesce(ah.packets, 0)
           )
           order by s.slot
         ) as v
  from slots s
  left join slot_counts c using (slot)
  left join rbn_hourly h on h.hour = s.slot
  left join aprs_packet_hours ah on ah.hour_start = s.slot
),
```

Edit D: after the `rbn as (...)` CTE (before the final `select`), add a comma after its closing
paren and insert:

```sql
-- aprs: packets from aprs_packet_hours, the rest from the day rollups; never
-- aprs_packets. Stations and igates are distinct over the whole week.
aprs_type_order as (
  select unnest(array[
    'position', 'mic_e', 'object', 'item', 'message', 'status', 'weather',
    'telemetry', 'nmea', 'third_party', 'capabilities', 'query', 'user_defined', 'other'
  ]) as type
),
aprs_type_counts as (
  select packet_type as type, sum(packets) as n
  from aprs_daily_types
  where day >= v_first_day and day < v_end_day
  group by 1
),
aprs as (
  select jsonb_build_object(
           'packets', (select coalesce(sum(packets), 0) from aprs_packet_hours
                       where hour_start >= v_window_start and hour_start < v_window_end),
           'stations', (select count(distinct base) from aprs_daily_stations
                        where day >= v_first_day and day < v_end_day),
           'igates', (select count(distinct igate) from aprs_daily_igates
                      where day >= v_first_day and day < v_end_day),
           'types', (select jsonb_agg(jsonb_build_object('type', o.type, 'packets', coalesce(c.n, 0))
                                      order by coalesce(c.n, 0) desc, o.type asc)
                     from aprs_type_order o
                     left join aprs_type_counts c using (type))
         ) as v
)
```

Edit E: in the final `jsonb_build_object`, after `'rbn',              r.v` add `,` and
`'aprs',             ap.v`; after `cross join rbn r` add `cross join aprs ap`.

3. After the function, append:

```sql
comment on function public.refresh_stats_snapshot_at(timestamptz) is
  'Rolls up RBN and APRS days and RBN hours, inserts one stats_snapshots row as of p_now (7 complete UTC days; hourly to the last complete hour) and prunes to 48 rows. Cron only, through refresh_stats_snapshot().';

revoke all on function public.refresh_stats_snapshot_at(timestamptz) from public, anon, authenticated;
```

`refresh_stats_snapshot()` and the cron job are unchanged.

- [ ] **Step 4: Run the suites and see them pass**

Run: `cd /Users/bradbazemore/Dev/longlines-aprs-stats && supabase db reset && supabase test db`
Expected: every suite PASS, including `stats_snapshot.test.sql` (146), `aprs.test.sql` (54),
`stats_hidden.test.sql` and `advisor.test.sql`.

Then:
`docker exec -i supabase_db_longlines psql -U postgres -v ON_ERROR_STOP=1 < scripts/smoke-test.sql`
(expected: no errors) and `supabase db lint --level warning` (expected: no new findings).

Check the seed refresh still works: `supabase db reset` ran `seed.sql`, which ends with a refresh;
run
`docker exec -i supabase_db_longlines psql -U postgres -Atc "select payload->'aprs' from stats_snapshots order by generated_at desc limit 1"`.
Expected: `{"types": [...14 zero entries...], "igates": 0, "packets": 0, "stations": 0}`.

- [ ] **Step 5: Update the docs**

`CLAUDE.md`, Relay rules, the APRS-IS bullet: replace "never send them to `raw_spots`, matching,
`spot_stream` or the rollups." with "never send them to `raw_spots`, matching, `spot_stream` or the
callsign rollups. The Stats refresh rolls them up per day (`rollup_aprs_day` into `aprs_daily_*`),
and `maintain_aprs_packets` keeps a day until that rollup is final."

`CLAUDE.md`, Phase 3 stats rules, after the sentence ending "never from `rbn_spots` directly: the
refresh runs hourly and the firehose is ~1.5M rows a day.": add "APRS figures come from
`aprs_packet_hours` and the `aprs_daily_*` tables, never `aprs_packets`."

`docs/ARCHITECTURE.md`:

- In the "Phase 3: stats snapshot" mermaid, add after the `UH --> RR` line:
  ```
  AP[(aprs_packets)] -->|once per complete day| UA[rollup_aprs_day]
  UA --> AR[(aprs_daily_stations, aprs_daily_igates, aprs_daily_types)]
  AH[(aprs_packet_hours)] --> F
  AR --> F
  ```
- In Counting rules, change the `hourly` bullet's "each with the POTA and SOTAwatch `raw_spots` rows
  and the `rbn_spots` rows whose `spot_time` falls in that hour" to "each with the POTA and
  SOTAwatch `raw_spots` rows, the `rbn_spots` rows whose `spot_time` falls in that hour and the
  hour's APRS-IS packets from `aprs_packet_hours`", and "`daily[].rbn` is the RBN count per day." to
  "`daily[].rbn` and `daily[].aprs` are the RBN and APRS-IS counts per day."
- Add a section before "The payload's TypeScript shape is ...":

  ```markdown
  ## APRS-IS figures

  `aprs` holds the week's APRS-IS packets, distinct stations (base calls, so SSIDs combine), distinct
  igates as sent, and packets for each of the 14 packet types, busiest first. Packets come from
  `aprs_packet_hours`, which ingest keeps current. `aprs_packets` keeps only about two days, so
  `rollup_aprs_day(day)` saves the rest per UTC day into `aprs_daily_stations`, `aprs_daily_igates`
  and `aprs_daily_types`, on the same schedule as the RBN days, including the re-roll an hour after
  the day ends. It refuses a day whose rows no longer add up to its `aprs_packet_hours`.
  `maintain_aprs_packets()` keeps a day until `aprs_rollup_days` shows a rollup at least an hour after
  the day ended.
  ```
- In the "APRS-IS" section, the "Packets, not spots." bullet: change "Nothing reaches `raw_spots`,
  the matcher, `spot_stream`, the rollups or Stats" to "Nothing reaches `raw_spots`, the matcher,
  `spot_stream` or the callsign rollups; Stats reads its own per-day rollups (see \"APRS-IS
  figures\")". In the "Two days." bullet, after "five-minute slice is archived with a matching
  count" add ", and the Stats rollup of the day is final".

- [ ] **Step 6: Commit**

```bash
cd /Users/bradbazemore/Dev/longlines-aprs-stats
git add supabase/migrations/20261014000030_stats_aprs.sql supabase/tests/stats_snapshot.test.sql CLAUDE.md docs/ARCHITECTURE.md
git commit -m "Stats snapshot: APRS-IS packets per day and hour, stations, igates and packet types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: APRS on the Stats page

**Files:**

- Modify: `web/src/stats/types.ts`, `web/src/stats/format.ts`, `web/src/stats/StatsPage.tsx`
- Modify: `web/src/stats/format.test.ts`, `web/src/stats/StatsPage.test.tsx`
- Modify: `web/src/lib/database.types.ts`

**Interfaces:**

- Consumes: the payload from Task 2.
- Produces: `AprsPacketType`, `StatsPayload["aprs"]`, `aprsTypeLabel(type: AprsPacketType): string`.

- [ ] **Step 1: Update the types (needed for the tests to compile)**

In `web/src/stats/types.ts`, change the header's migration reference to
`supabase/migrations/20261014000030_stats_aprs.sql`. Add after `export type Program`:

```ts
// aprs_packets.packet_type's check constraint (20261014000010).
export type AprsPacketType =
  | "position"
  | "mic_e"
  | "object"
  | "item"
  | "message"
  | "status"
  | "weather"
  | "telemetry"
  | "nmea"
  | "third_party"
  | "capabilities"
  | "query"
  | "user_defined"
  | "other";
```

Change `daily` and `hourly`:

```ts
daily: {
  day: string;
  pota: number;
  sota: number;
  rbn: number;
  aprs: number;
}
[]; // exactly 7, oldest first, zero-filled
hourly: {
  hour: string;
  pota: number;
  sota: number;
  rbn: number;
  aprs: number;
}
[]; // exactly 168, oldest first, zero-filled, ending at the last complete hour; hour is ISO UTC
```

Add after `rbn: {...};`:

```ts
// Every APRS-IS packet: packets from aprs_packet_hours, the rest from the aprs_daily_* rollups.
aprs: {
  packets: number;
  stations: number; // distinct base calls, so SSIDs combine
  igates: number; // distinct igates, as sent
  types: {
    type: AprsPacketType;
    packets: number;
  }
  []; // all 14, packets desc then type asc
}
```

- [ ] **Step 2: Write the failing tests**

`web/src/stats/format.test.ts`: add `aprsTypeLabel` to the import from `./format`. In the `payload`
helper add `aprs: { packets: 0, stations: 0, igates: 0, types: [] },` after `rbn`. Add:

```ts
describe("aprsTypeLabel", () => {
  it("names every packet type", () => {
    expect(aprsTypeLabel("position")).toBe("Position");
    expect(aprsTypeLabel("mic_e")).toBe("Mic-E");
    expect(aprsTypeLabel("nmea")).toBe("NMEA");
    expect(aprsTypeLabel("third_party")).toBe("Third party");
    expect(aprsTypeLabel("user_defined")).toBe("User defined");
  });

  it("shows a type it does not know as sent", () => {
    expect(aprsTypeLabel("beacon" as AprsPacketType)).toBe("beacon");
  });
});
```

and import `AprsPacketType` alongside `LatestStats, StatsPayload` from `./types`.

`web/src/stats/StatsPage.test.tsx`:

- `daily` fixture: `day, pota: 1000 + i, sota: 300 + i, rbn: 24000, aprs: 250000,`
- `hourly` fixture: `pota: 50, sota: 10, rbn: 1000, aprs: 10000,`
- After `rbn: {...},` add:

```ts
aprs: {
  packets: 1750000, stations: 41234, igates: 9876,
  types: [{ type: "position", packets: 1000000 }, { type: "mic_e", packets: 500000 }, { type: "weather", packets: 250000 }],
},
```

- In "renders the dashboard from the snapshot": `"180,345"` becomes `"1,930,345"`, and
  `"168,000 RBN, 10,000 POTA, 2,345 SOTA"` becomes
  `"168,000 RBN, 1,750,000 APRS, 10,000 POTA, 2,345 SOTA"`.
- Rename "shows ingest volume across all three sources" to "shows ingest volume across every
  source". Its comment becomes
  `// 1,930,345 spots and packets over 10,080 minutes; every hour of the fixture is 50 + 10 + 1,000 + 10,000.`.
  `"18/min"` becomes `"192/min"`, and `"Peak hour: 1,060 spots"` becomes
  `"Peak hour: 11,060 spots"`. Add
  `expect(screen.getByText("1,750,000 packets")).toBeInTheDocument();` after the `"168,000 spots"`
  line.
- In "renders a snapshot written before activations and chasers existed": `"180,345"` becomes
  `"1,930,345"`.
- Replace "renders a snapshot written before RBN figures and the hourly series existed" with:

```ts
it("renders a snapshot written before RBN figures and the hourly series existed", () => {
  const { hourly: _hourly, rbn: _rbn, aprs: _aprs, ...old } = PAYLOAD;
  const daily = PAYLOAD.daily.map(({ rbn: _r, aprs: _a, ...d }) => d);
  const stats = { ...STATS, payload: { ...old, daily } } as unknown as LatestStats;
  vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
  renderPage(<StatsPage />);
  expect(screen.getByText("12,345")).toBeInTheDocument();
  expect(screen.getByText("0 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
  expect(screen.getByText("Peak hour: 0 spots")).toBeInTheDocument();
  expect(screen.queryByText("Spots processed per hour")).not.toBeInTheDocument();
});
```

- Add two tests:

```ts
it("shows the APRS-IS section", () => {
  vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
  renderPage(<StatsPage />);
  expect(screen.getByText("APRS-IS")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Every packet on the APRS-IS full feed. Packets aren't spots and never trigger alerts.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("APRS packets")).toBeInTheDocument();
  expect(screen.getByText("1,750,000")).toBeInTheDocument();
  expect(screen.getByText("Stations heard")).toBeInTheDocument();
  expect(screen.getByText("41,234")).toBeInTheDocument();
  expect(screen.getByText("Unique callsigns that sent a packet, SSIDs combined"))
    .toBeInTheDocument();
  expect(screen.getByText("Igates")).toBeInTheDocument();
  expect(screen.getByText("9,876")).toBeInTheDocument();
  expect(screen.getByText("Packet types")).toBeInTheDocument();
  expect(screen.getByText("What APRS stations sent")).toBeInTheDocument();
  expect(screen.getByText(/RBN and APRS run 100 times the volume of POTA or more/))
    .toBeInTheDocument();
});

it("renders a snapshot written before APRS figures existed", () => {
  const { aprs: _aprs, ...old } = PAYLOAD;
  const daily = PAYLOAD.daily.map(({ aprs: _a, ...d }) => d);
  const hourly = PAYLOAD.hourly.map(({ aprs: _a, ...h }) => h);
  const stats = { ...STATS, payload: { ...old, daily, hourly } } as unknown as LatestStats;
  vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
  renderPage(<StatsPage />);
  expect(screen.getByText("180,345")).toBeInTheDocument();
  expect(screen.getByText("168,000 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
  expect(screen.getByText("Peak hour: 1,060 spots")).toBeInTheDocument();
  expect(screen.getByText("0 packets")).toBeInTheDocument();
  expect(screen.getByText("APRS packets")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `cd /Users/bradbazemore/Dev/longlines-aprs-stats/web && npm ci && npx vitest run src/stats`
Expected: FAIL: `aprsTypeLabel` is not exported, and the APRS text is not found.

- [ ] **Step 4: Implement**

`web/src/stats/format.ts`: change the import to
`import type { AprsPacketType, LatestStats } from "./types";` and add at the end:

```ts
const APRS_TYPE_LABELS: Record<AprsPacketType, string> = {
  position: "Position",
  mic_e: "Mic-E",
  object: "Object",
  item: "Item",
  message: "Message",
  status: "Status",
  weather: "Weather",
  telemetry: "Telemetry",
  nmea: "NMEA",
  third_party: "Third party",
  capabilities: "Capabilities",
  query: "Query",
  user_defined: "User defined",
  other: "Other",
};

/** Packet type as the Stats page names it; a type added in SQL first shows as sent. */
export const aprsTypeLabel = (type: AprsPacketType): string => APRS_TYPE_LABELS[type] ?? type;
```

`web/src/stats/StatsPage.tsx`:

- Import `aprsTypeLabel` from `./format`, beside the other format helpers.
- After `const NO_RBN ...` add:

```ts
// Likewise for APRS-IS figures (20261014000030).
const NO_APRS: StatsPayload["aprs"] = { packets: 0, stations: 0, igates: 0, types: [] };
```

- In `Dashboard`: change the colour comment to
  `// Color follows the source everywhere on the page: POTA is primary, SOTA is secondary, RBN is warning, APRS is success.`
  and add `const aprsColor = theme.palette.success.main;` after `rbnColor`. Then:

```ts
const rbn = payload.rbn ?? NO_RBN;
const aprs = payload.aprs ?? NO_APRS;
const hourly = payload.hourly ?? [];
const hours = hourly.map((h) => new Date(h.hour));
const hourTotals = hourly.map((h) => h.pota + h.sota + h.rbn + (h.aprs ?? 0));
// Midnight ticks; every other day on phones so the labels do not collide.
const midnights = midnightTicks(hours, mobile);
const processed = payload.totals.spots + rbn.spots + aprs.packets;
const perDay: [string, number[], string, string][] = [
  ["RBN", payload.daily.map((d) => d.rbn ?? 0), rbnColor, "spots"],
  ["APRS", payload.daily.map((d) => d.aprs ?? 0), aprsColor, "packets"],
  ["POTA", payload.daily.map((d) => d.pota), pota, "spots"],
  ["SOTA", payload.daily.map((d) => d.sota), sota, "spots"],
];
```

- Spots processed detail:
  ``detail={`${fmt(rbn.spots)} RBN, ${fmt(aprs.packets)} APRS, ${fmt(payload.totals.potaSpots)} POTA, ${fmt(payload.totals.sotaSpots)} SOTA`}``
- Spots per day text:
  `One chart per source. RBN and APRS run 100 times the volume of POTA or more, so they don't share a scale.`
- Per-day grid:

```tsx
{perDay.map(([label, data, color, unit]) => (
  <Grid key={label} size={{ xs: 12, sm: 6, md: 3 }}>
    <ChartCard title={label} subheader={`${fmt(data.reduce((sum, n) => sum + n, 0))} ${unit}`}>
```

(the `LineChart` inside is unchanged).

- After the "Most heard on RBN" `ChartCard`, before the closing `</>`:

```tsx
<Box>
  <Typography variant="h6" gutterBottom>APRS-IS</Typography>
  <Typography variant="body2" color="text.secondary">
    Every packet on the APRS-IS full feed. Packets aren't spots and never trigger alerts.
  </Typography>
</Box>
<Grid container spacing={2}>
  <Grid size={{ xs: 12, sm: 4 }}>
    <Kpi label="APRS packets" value={fmt(aprs.packets)} detail="Every packet on the full feed" />
  </Grid>
  <Grid size={{ xs: 12, sm: 4 }}>
    <Kpi label="Stations heard" value={fmt(aprs.stations)} detail="Unique callsigns that sent a packet, SSIDs combined" />
  </Grid>
  <Grid size={{ xs: 12, sm: 4 }}>
    <Kpi label="Igates" value={fmt(aprs.igates)} detail="Unique gateways that passed a packet to APRS-IS" />
  </Grid>
</Grid>
<ChartCard title="Packet types" subheader="What APRS stations sent">
  <BarChart
    height={380}
    hideLegend
    layout="horizontal"
    yAxis={[{ scaleType: "band", data: aprs.types.map((t) => aprsTypeLabel(t.type)), width: 96 }]}
    xAxis={[{ valueFormatter: axis }]}
    series={[{ label: "Packets", data: aprs.types.map((t) => t.packets), color: aprsColor, valueFormatter: count }]}
  />
</ChartCard>
```

- [ ] **Step 5: Run the web checks and see them pass**

Run:
`cd /Users/bradbazemore/Dev/longlines-aprs-stats/web && npx vitest run src/stats && npm run build && npm run lint && npm run coverage`
Expected: all pass; build with zero TS errors; coverage at or above 80%.

- [ ] **Step 6: Splice the generated types**

Run
`cd /Users/bradbazemore/Dev/longlines-aprs-stats && supabase gen types typescript --local > /private/tmp/claude-501/-Users-bradbazemore-Dev-longlines/20db10a7-0f82-4914-88ef-4bc67fc12e8a/scratchpad/types.ts`
and copy only the new entries from it into `web/src/lib/database.types.ts`, keeping alphabetical
order and leaving every other line alone (the generator drifts on computed fields):

- Tables `aprs_daily_igates`, `aprs_daily_stations`, `aprs_daily_types` (before `aprs_packet_hours`)
  and `aprs_rollup_days` (after `aprs_packets`).
- Function `rollup_aprs_day` (`{ Args: { "p_day": string }; Returns: boolean }`), before
  `rollup_callsign_day`.

Then `cd web && npm run build` again. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/bradbazemore/Dev/longlines-aprs-stats
git add web/src/stats web/src/lib/database.types.ts
git commit -m "Stats page: APRS-IS in the volume figures and its own section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Whole-branch verification

- [ ] **Step 1:** `cd /Users/bradbazemore/Dev/longlines-aprs-stats/web && npm run test:all:fresh`.
      Expected: every check green in the summary (Deno fmt/lint/check/coverage, pgTAP, smoke test,
      db lint, web build/lint/coverage).
- [ ] **Step 2:** Look at the page in a browser against the local stack (`npm run dev:full`, then
      `/stats`). Insert a few APRS packets for yesterday through `ingest_aprs_packets` and run
      `select refresh_stats_snapshot()` so the section shows non-zero numbers. Check desktop and
      phone widths, both colour schemes.
- [ ] **Step 3:** Push the branch and open a PR only when Brad asks.
