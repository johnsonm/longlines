-- Every RBN spot, kept for seven days in the database and archived to Storage
-- (spec: docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md).
--
-- raw_spots keeps only RBN spots of watched callsigns, so matching and delivery
-- never see the firehose. This table holds all of them, partitioned by UTC day
-- so old days can be dropped whole once archived (PR 2).
--
-- The unique key includes spot_time because Postgres requires the partition key
-- in every unique constraint; it is also what identifies an RBN spot, so a batch
-- the relay retries inserts nothing new.
--
-- Partitions live in their own schema, `partitions`, which PostgREST does not
-- expose and `supabase gen types` does not read. In public, every day would add
-- a table to the API and to web/src/lib/database.types.ts. Inserts and queries go
-- through the parent, public.rbn_spots.

create schema partitions;
revoke all on schema partitions from public, anon, authenticated;

create table rbn_spots (
  spot_time      timestamptz   not null,
  received_at    timestamptz   not null,
  ingested_at    timestamptz   not null default now(),
  spotter        text          not null,
  callsign       text          not null,
  frequency_khz  numeric(12,3) not null,
  band           text,
  mode           text,
  mode_family    text,
  snr            smallint      not null,
  speed          smallint      not null,
  speed_unit     text          not null check (speed_unit in ('WPM', 'BPS')),
  spot_type      text          not null,
  line           text          not null,
  unique (spot_time, spotter, callsign, frequency_khz)
) partition by range (spot_time);

create index rbn_spots_callsign_time_idx on rbn_spots (callsign, spot_time);

-- Catches rows for a day without a partition (the daily job did not run), so an
-- insert never fails for lack of one. create_rbn_spots_partition moves them out.
create table partitions.rbn_spots_default partition of rbn_spots default;

alter table rbn_spots enable row level security;
alter table partitions.rbn_spots_default enable row level security;
revoke all on rbn_spots from anon, authenticated;
revoke all on partitions.rbn_spots_default from anon, authenticated;

-- Creates the partition for one UTC day. A plain CREATE ... PARTITION OF fails
-- when the default partition already holds rows for that day, so the table is
-- built standalone, those rows are moved into it, and it is attached. New
-- tables pick up Supabase's default grants, so access is revoked here too.
create function public.create_rbn_spots_partition(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text        := 'rbn_spots_' || to_char(p_day, 'YYYYMMDD');
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if to_regclass('partitions.' || v_name) is not null then
    return;
  end if;
  execute format('create table partitions.%I (like rbn_spots including defaults including constraints)', v_name);
  execute format(
    'with moved as (delete from partitions.rbn_spots_default where spot_time >= %L and spot_time < %L returning *)
     insert into partitions.%I select * from moved',
    v_from, v_to, v_name);
  execute format('alter table rbn_spots attach partition partitions.%I for values from (%L) to (%L)', v_name, v_from, v_to);
  execute format('alter table partitions.%I enable row level security', v_name);
  execute format('revoke all on partitions.%I from anon, authenticated', v_name);
end;
$$;

-- Daily: partitions for today and the next three UTC days. PR 2 adds the
-- archived-only drop of days older than seven.
create function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
begin
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    perform public.create_rbn_spots_partition(v_day);
  end loop;
end;
$$;

-- One batch from ingest-rbn. Keys match the columns (RbnSpotRow in
-- _shared/types.ts). Returns the number of rows inserted.
create function public.ingest_rbn_spots(p_rows jsonb)
returns int
language sql
security definer
set search_path = public
as $$
  with ins as (
    insert into rbn_spots (
      spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family,
      snr, speed, speed_unit, spot_type, line
    )
    select x.spot_time, x.received_at, x.spotter, x.callsign, x.frequency_khz, x.band, x.mode,
           x.mode_family, x.snr, x.speed, x.speed_unit, x.spot_type, x.line
    from jsonb_to_recordset(p_rows) as x(
      spot_time timestamptz, received_at timestamptz, spotter text, callsign text,
      frequency_khz numeric, band text, mode text, mode_family text, snr smallint,
      speed smallint, speed_unit text, spot_type text, line text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;

revoke all on function public.create_rbn_spots_partition(date) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
revoke all on function public.ingest_rbn_spots(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_rbn_spots(jsonb) to service_role;
grant execute on function public.maintain_rbn_spots() to service_role;

select public.maintain_rbn_spots();
select cron.schedule('maintain-rbn-spots', '30 3 * * *', $$ select public.maintain_rbn_spots(); $$);
