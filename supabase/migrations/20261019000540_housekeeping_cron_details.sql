-- run_housekeeping, as in 20261017004010, plus:
-- - cron.job_run_details older than 7 days (REVIEW.md, "Database: ingest,
--   retention, ..." #3): pg_cron never prunes it, and the per-minute and
--   sub-minute jobs write about 7,700 rows a day. The function's owner
--   (postgres) may delete from it on Supabase;
-- - ingest_failures by last_seen_at (20261019000510), so an item that keeps
--   failing stays one row;
-- - send_test_limits windows older than an hour (20261019000530).
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
  delete from ingest_failures where last_seen_at < now() - interval '30 days';
  delete from subscription_quiet where last_sent_at < now() - interval '1 hour';
  delete from send_test_limits where window_start < now() - interval '1 hour';
  delete from cron.job_run_details where end_time < now() - interval '7 days';
$$;

revoke all on function public.run_housekeeping() from public, anon, authenticated;
