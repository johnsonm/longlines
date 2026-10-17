-- RLS on the last public tables without it. Clients are already kept out by
-- revoked grants; RLS with no policies is the second barrier, as for every other
-- service-role-only table. service_role bypasses RLS, and the definer functions
-- that read or write these tables (ingest_spots, record_spot_failures,
-- list_recent_spots, list_ingest_health, the stats refresh, the archive) run as
-- their owner, which RLS does not apply to.
alter table raw_spots enable row level security;
alter table ingest_state enable row level security;
alter table ingest_failures enable row level security;
