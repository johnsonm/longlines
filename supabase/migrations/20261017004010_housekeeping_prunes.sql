-- run_housekeeping, as in 20261006000009, plus two prunes:
-- - ingest_failures older than 30 days (the triage window in docs/OPERATIONS.md
--   is a week; an item that keeps failing is logged again on every run);
-- - subscription_quiet rows sent more than an hour ago, which no quiet window
--   (at most 60 minutes) can still use.
create or replace function public.run_housekeeping()
returns void
language sql
security definer
set search_path = public, pgmq
as $$
  delete from deliveries where created_at < now() - interval '7 days';
  delete from pgmq.a_spot_events where archived_at < now() - interval '7 days';
  delete from pgmq.a_deliveries_queue where archived_at < now() - interval '7 days';
  delete from sign_in_attempts where attempted_at < now() - interval '1 day';
  delete from ingest_failures where occurred_at < now() - interval '30 days';
  delete from subscription_quiet where last_sent_at < now() - interval '1 hour';
$$;

revoke all on function public.run_housekeeping() from public, anon, authenticated;
