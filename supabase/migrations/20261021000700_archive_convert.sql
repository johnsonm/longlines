-- The one-off NDJSON-to-Parquet conversion (issue #174; convert-archive and
-- _shared/archive_convert.ts). Slices archived before 2026-10-14 are gzipped
-- NDJSON at <source>/YYYY/MM/DD/HHMM.ndjson.gz; the function rewrites each as
-- Parquet at the live path and then repoints its archive_log row here.
--
-- Retention is unaffected: rbn_day_archived and aprs_day_archived compare row
-- counts and never read object_path (supabase/tests/archive_convert.test.sql).
-- Drop both functions with the tool once no .ndjson.gz row is left.

-- Log rows still on NDJSON after the cursor (every one when p_after_start is
-- null), oldest first, so a slice that keeps failing can be stepped past.
create function public.archive_ndjson_slices(
  p_after_start timestamptz, p_after_source text, p_limit int
)
returns table (source text, slice_start timestamptz, slice_end timestamptz, row_count int,
               object_path text)
language sql
stable
security definer
set search_path = public
as $$
  select l.source, l.slice_start, l.slice_end, l.row_count, l.object_path
  from archive_log l
  where l.object_path like '%.ndjson.gz'
    and (p_after_start is null
         or (l.slice_start, l.source) > (p_after_start, coalesce(p_after_source, '')))
  order by l.slice_start, l.source
  limit greatest(p_limit, 0);
$$;

-- Points one log row at its Parquet object: only while the row still names the
-- NDJSON object the caller converted, has the row count the caller verified,
-- and the new path is the live layout's for that slice (objectPath in
-- _shared/archive.ts). True when the row changed; false leaves it as it was,
-- and the caller then keeps the NDJSON object.
create function public.archive_repoint_slice(
  p_source text, p_slice_start timestamptz, p_from_path text, p_to_path text,
  p_row_count int, p_bytes int
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with moved as (
    update archive_log l
    set object_path = p_to_path,
        bytes = p_bytes
    where l.source = p_source
      and l.slice_start = p_slice_start
      and l.object_path = p_from_path
      and p_from_path like '%.ndjson.gz'
      and l.row_count = p_row_count
      and l.row_count > 0
      and p_bytes > 0
      and p_to_path = p_source || to_char(p_slice_start at time zone 'utc',
                                          '"/year="YYYY"/month="MM"/day="DD"/"HH24MI".parquet"')
    returning 1
  )
  select exists (select 1 from moved);
$$;

revoke all on function public.archive_ndjson_slices(timestamptz, text, int) from public, anon, authenticated;
revoke all on function public.archive_repoint_slice(text, timestamptz, text, text, int, int) from public, anon, authenticated;
grant execute on function public.archive_ndjson_slices(timestamptz, text, int) to service_role;
grant execute on function public.archive_repoint_slice(text, timestamptz, text, text, int, int) to service_role;
