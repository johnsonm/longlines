-- RBN spot counts on the Sources page come from rbn_spots.
--
-- raw_spots holds only the RBN spots of callsigns some subscription watches, so
-- counting it showed 0 for RBN until someone subscribed to a station. Every RBN
-- spot lands in rbn_spots (20261011000003), so RBN counts that instead, like
-- POTA and SOTAwatch count their whole feed.
--
-- rbn_spots is filtered on spot_time rather than ingested_at: spot_time leads
-- the unique index and is the partition key, so the count reads one or two days
-- of index rather than the whole table. The relay forwards spots within seconds,
-- so the two windows agree.
--
-- Same columns as before, so list_ingest_health() and the client types are
-- unchanged. A CASE runs only the subquery for its own branch.

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
  case when s.source = 'rbn'
    then (select count(*) from rbn_spots r where r.spot_time > now() - interval '1 hour')
    else (select count(*) from raw_spots r where r.source = s.source and r.ingested_at > now() - interval '1 hour')
  end as spots_last_hour,
  case when s.source = 'rbn'
    then (select count(*) from rbn_spots r where r.spot_time > now() - interval '24 hours')
    else (select count(*) from raw_spots r where r.source = s.source and r.ingested_at > now() - interval '24 hours')
  end as spots_last_24h,
  s.total_spots_ingested
from ingest_state s;

revoke all on ingest_health from anon, authenticated;
