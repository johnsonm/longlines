-- The hourly Stats refresh gets ten minutes instead of the cron session's two.
--
-- refresh_stats_snapshot() rolls up the previous UTC day (RBN, about 1.5M rows; APRS-IS;
-- countries) at 00:05 and, to catch late rows, again at 01:05, then recounts the RBN top stations.
-- Those two runs took 100-120 s a day in October 2026 and failed four times in a week on the
-- 2-minute statement_timeout; every other hour takes about 15 s. The whole refresh is one
-- statement, so a function's own SET clause can't extend it: the timeout is armed when the
-- statement starts. The job's command sets it first instead. pg_cron (libpq mode on hosted) sends
-- the command as one simple query, which runs as an implicit transaction and arms the timeout per
-- statement, so SET LOCAL governs the select after it and ends with the job's transaction.

select cron.schedule('refresh-stats-snapshot', '5 * * * *',
  $$ set local statement_timeout = '10min'; select public.refresh_stats_snapshot(); $$);
