-- One ingest_failures row per bad item (REVIEW.md, "Shared ingest modules"
-- #1). A spot that throws before the adapter's age check stays in the feed
-- and was dead-lettered again on every poll (about 1,440 rows a day for a
-- WWFF item). The functions insert into the table directly (db.ts
-- recordSpotFailures, a PostgREST insert), so the dedup is a trigger and the
-- deployed functions keep working unchanged:
-- - payload_hash is md5(source || ':' || raw_payload::text), unique;
-- - an insert whose hash is already stored updates that row instead
--   (occurrences + 1, last_seen_at, the latest error) and inserts nothing;
-- - housekeeping prunes by last_seen_at (20261019000540), so an item that
--   keeps failing stays one row and is not pruned while it does.
-- occurred_at stays the first failure. Deleting a row after triage (as
-- docs/OPERATIONS.md says) lets the next failure of that item start a new one.

alter table ingest_failures
  add column payload_hash text generated always as (md5(source || ':' || raw_payload::text)) stored,
  add column last_seen_at timestamptz,
  add column occurrences  int not null default 1;

-- Existing duplicates fold into their first row.
with groups as (
  select payload_hash, min(id) as keep, count(*)::int as n, max(occurred_at) as last_seen,
         (array_agg(error order by occurred_at desc, id desc))[1] as last_error
  from ingest_failures
  group by payload_hash
),
gone as (
  delete from ingest_failures f
  using groups g
  where f.payload_hash = g.payload_hash and f.id <> g.keep
)
update ingest_failures f
set occurrences = g.n, last_seen_at = g.last_seen, error = g.last_error
from groups g
where f.id = g.keep;

alter table ingest_failures
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

create unique index ingest_failures_payload_hash_key on ingest_failures (payload_hash);
create index ingest_failures_last_seen_at_idx on ingest_failures (last_seen_at);

-- BEFORE INSERT: a known item bumps its row and the insert is skipped. The
-- advisory lock serialises inserts of one item, so two concurrent runs never
-- both insert it (which would fail the second batch on the unique index).
-- Generated columns are not computed yet in a BEFORE trigger, so the hash is
-- computed here with payload_hash's expression.
create function public.ingest_failures_dedup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := md5(new.source || ':' || new.raw_payload::text);
begin
  perform pg_advisory_xact_lock(hashtextextended('ingest_failures:' || v_hash, 0));
  update ingest_failures f
  set occurrences  = f.occurrences + 1,
      last_seen_at = greatest(f.last_seen_at, coalesce(new.occurred_at, now())),
      error        = new.error
  where f.payload_hash = v_hash;
  if found then
    return null;
  end if;
  new.last_seen_at := coalesce(new.occurred_at, now());
  new.occurrences := 1;
  return new;
end;
$$;

revoke all on function public.ingest_failures_dedup() from public, anon, authenticated;

create trigger ingest_failures_dedup
before insert on ingest_failures
for each row execute function public.ingest_failures_dedup();
