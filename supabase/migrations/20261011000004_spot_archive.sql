-- Archive of every spot to Supabase Storage as gzipped NDJSON (spec
-- docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md and its
-- "Amendment after measurement").
--
-- Postgres decides which slices are due and builds each slice's NDJSON, so the
-- archive Edge Function only gzips and uploads (it has 2 s of CPU per call).
-- A slice is logged in archive_log only after its upload succeeds; retention
-- (20261011000005) drops nothing that is not logged with a matching count.

-- Private bucket. Guarded because a database started without Storage (CI runs
-- `supabase db start`) has no storage schema; hosted projects always do.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('archive', 'archive', false)
    on conflict (id) do nothing;
  end if;
end $$;

create table archive_log (
  source       text        not null check (source in ('pota', 'sotawatch', 'rbn')),
  slice_start  timestamptz not null,
  slice_end    timestamptz not null check (slice_end > slice_start),
  row_count    int         not null check (row_count >= 0),
  bytes        int,
  object_path  text,
  archived_at  timestamptz not null default now(),
  primary key (source, slice_start),
  -- An empty slice is logged without an object; a slice with rows always has one.
  check ((row_count = 0) = (object_path is null))
);

alter table archive_log enable row level security;
revoke all on archive_log from anon, authenticated;

-- The one place slice length is defined: RBN is busy enough to need 10-minute
-- slices to stay inside the function's CPU budget; the other sources are tiny.
create function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
as $$
  select case p_source when 'rbn' then 10 when 'pota' then 60 when 'sotawatch' then 60 end;
$$;

-- Slices of one source that have ended before p_before and are not logged yet,
-- oldest first, from the slice holding the source's earliest spot. Empty slices
-- are included so that a gap in archive_log always means "not archived".
create function public.archive_pending_slices(p_source text, p_before timestamptz, p_limit int)
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
             else (select min(s.spot_time) from raw_spots s where s.source = p_source)
           end as t
  )
  select g.s, g.s + cfg.step
  from cfg, first_spot,
       generate_series(date_bin(cfg.step, first_spot.t, timestamptz '2000-01-01 00:00+00'),
                       p_before - cfg.step, cfg.step) as g(s)
  where first_spot.t is not null
    and not exists (select 1 from archive_log l where l.source = p_source and l.slice_start = g.s)
  order by g.s
  limit p_limit;
$$;

-- One slice as NDJSON, [p_from, p_to) by spot_time, one JSON object per line,
-- built here so the Edge Function never parses rows.
create function public.archive_ndjson(p_source text, p_from timestamptz, p_to timestamptz)
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
  elsif p_source in ('pota', 'sotawatch') then
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

-- Records an archived slice; a re-archive overwrites the row.
create function public.log_archive(
  p_source text, p_slice_start timestamptz, p_slice_end timestamptz,
  p_row_count int, p_bytes int, p_object_path text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into archive_log (source, slice_start, slice_end, row_count, bytes, object_path)
  values (p_source, p_slice_start, p_slice_end, p_row_count, p_bytes, p_object_path)
  on conflict (source, slice_start) do update
    set slice_end   = excluded.slice_end,
        row_count   = excluded.row_count,
        bytes       = excluded.bytes,
        object_path = excluded.object_path,
        archived_at = now();
$$;

-- At a glance: how far each source is archived and how many finished slices wait.
create view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn')) as s(source);

revoke all on archive_status from anon, authenticated;
revoke all on function public.archive_slice_minutes(text) from public, anon, authenticated;
revoke all on function public.archive_pending_slices(text, timestamptz, int) from public, anon, authenticated;
revoke all on function public.archive_ndjson(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.log_archive(text, timestamptz, timestamptz, int, int, text) from public, anon, authenticated;
grant execute on function public.archive_slice_minutes(text) to service_role;
grant execute on function public.archive_pending_slices(text, timestamptz, int) to service_role;
grant execute on function public.archive_ndjson(text, timestamptz, timestamptz) to service_role;
grant execute on function public.log_archive(text, timestamptz, timestamptz, int, int, text) to service_role;

-- Every 10 minutes, like the ingest jobs: Vault holds the URL and key.
select cron.schedule(
  'archive-spots',
  '*/10 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
             || '/functions/v1/archive',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);
