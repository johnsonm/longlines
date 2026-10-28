-- The stream worker on Fly.io is now the inbound worker (inbound/, app
-- longlines-inbound), the counterpart of the sender; "relay" is wanted for
-- something else. The database side of that name:
--
--   * worker_heartbeats.worker is 'inbound' (rows renamed in place, so the
--     Health page's history and reconnect counts carry over);
--   * record_relay_heartbeat is record_inbound_heartbeat, called by the
--     inbound-status function (formerly relay-status), service role only;
--   * health_snapshot's check is `inbound` and its series `inbound_memory`
--     (HealthPayload in web/src/health/types.ts, health_snapshot.test.sql).
--     Otherwise the function is as in 20261026001200.
--
-- health_cache is emptied so no payload with the old keys is served after this.

alter table worker_heartbeats drop constraint worker_heartbeats_worker_check;
update worker_heartbeats set worker = 'inbound' where worker = 'relay';
alter table worker_heartbeats
  add constraint worker_heartbeats_worker_check check (worker in ('sender', 'inbound'));
comment on table worker_heartbeats is 'Sender and inbound worker heartbeats, about one a minute each; kept 8 days.';

drop function public.record_relay_heartbeat(timestamptz, bigint, int, jsonb);

create function public.record_inbound_heartbeat(
  p_started_at timestamptz,
  p_rss_bytes bigint,
  p_reconnects int,
  p_feeds jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_started_at is null or p_rss_bytes is null or p_rss_bytes < 0
     or p_reconnects is null or p_reconnects < 0
     or jsonb_typeof(p_feeds) is distinct from 'array' then
    raise exception 'A heartbeat needs a start time, memory, reconnects and feeds.' using errcode = '22023';
  end if;
  if exists (select 1 from worker_heartbeats
             where worker = 'inbound' and received_at > now() - interval '30 seconds') then
    return;
  end if;
  insert into worker_heartbeats (worker, started_at, rss_bytes, reconnects, feeds)
  values ('inbound', p_started_at, p_rss_bytes, p_reconnects,
          coalesce((select jsonb_agg(jsonb_build_object('id', f ->> 'id',
                                                        'connected', coalesce((f ->> 'connected')::boolean, false))
                                     order by f ->> 'id')
                    from jsonb_array_elements(p_feeds) f
                    where f ->> 'id' in ('rbn', 'dxcluster', 'aprs')), '[]'::jsonb));
end;
$$;

revoke all on function public.record_inbound_heartbeat(timestamptz, bigint, int, jsonb) from public, anon, authenticated;
grant execute on function public.record_inbound_heartbeat(timestamptz, bigint, int, jsonb) to service_role;

create or replace function public.health_snapshot(p_range text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now      timestamptz := now();
  v_bucket   interval;
  v_count    int;
  v_end      timestamptz;
  v_start    timestamptz;
  v_spots    record;
  v_dels     record;
  v_ready    int;
  v_conn     int;
  v_max_conn int := current_setting('max_connections')::int;
  v_bytes    bigint := pg_database_size(current_database());
  v_feeds    text[];
  v_sender   worker_heartbeats%rowtype;
  v_inbound    worker_heartbeats%rowtype;
  v_checks   jsonb;
  v_series   jsonb;
  v_jobs     jsonb;
  v_pulled   jsonb;
  v_inbound_feeds  jsonb;
  v_archived timestamptz;
begin
  case p_range
    when '1h' then v_bucket := interval '1 minute'; v_count := 60;
    when '24h' then v_bucket := interval '30 minutes'; v_count := 48;
    when '7d' then v_bucket := interval '3 hours'; v_count := 56;
    else raise exception 'Unknown range.' using errcode = '22023';
  end case;
  -- Buckets on a fixed UTC grid; the last one holds now.
  v_end := date_bin(v_bucket, v_now, timestamptz '2000-01-01 00:00:00+00') + v_bucket;
  v_start := v_end - v_bucket * v_count;

  -- Live figures.
  select * into v_spots from pgmq.metrics('spot_events');
  select * into v_dels from pgmq.metrics('deliveries_queue');
  v_ready := public.health_oldest_ready_seconds(v_now);
  select count(*) into v_conn from pg_stat_activity where backend_type = 'client backend';

  select * into v_sender from worker_heartbeats
  where worker = 'sender' order by received_at desc limit 1;
  select * into v_inbound from worker_heartbeats
  where worker = 'inbound' order by received_at desc limit 1;

  -- Feeds checked: the inbound worker's own list when it reported in the last 10
  -- minutes, else the inbound sources that succeeded in the last 7 days.
  if v_inbound.received_at > v_now - interval '10 minutes' then
    select coalesce(array_agg(f ->> 'id' order by f ->> 'id'), '{}') into v_feeds
    from jsonb_array_elements(v_inbound.feeds) f;
  else
    select coalesce(array_agg(source order by source), '{}') into v_feeds
    from ingest_state
    where source in ('rbn', 'dxcluster', 'aprs') and last_success_at > v_now - interval '7 days';
  end if;

  select jsonb_agg(jsonb_build_object(
           'source', s.source,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by s.source)
  into v_pulled
  from ingest_state s where s.source in ('pota', 'sotawatch', 'wwff', 'wwbota');

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', f.id,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by f.id), '[]'::jsonb)
  into v_inbound_feeds
  from unnest(v_feeds) f(id)
  left join ingest_state s on s.source = f.id;

  select max(archived_at) into v_archived from archive_log;

  -- Jobs: cron's own runs, except that a cron_call_function job's successful
  -- runs are its HTTP responses (a request still unanswered is left out).
  with jobs as (
    select j.jobid, j.jobname, j.schedule, j.command like '%cron_call_function(%' as http
    from cron.job j
    where j.active
  ),
  runs as (
    select j.jobname as job, d.start_time as at, d.status = 'succeeded' as ok,
           null::int as http_status, false as timed_out,
           extract(epoch from d.end_time - d.start_time) as seconds
    from cron.job_run_details d
    join jobs j on j.jobid = d.jobid
    where d.start_time > v_now - interval '8 days'
      and d.status in ('succeeded', 'failed')
      and (not j.http or d.status = 'failed')
    union all
    select r.job, r.sent_at,
           coalesce(r.status_code between 200 and 299, false) and not coalesce(r.timed_out, false),
           r.status_code, coalesce(r.timed_out, false),
           r.run_seconds
    from cron_http_requests r
    where r.sent_at > v_now - interval '8 days'
      and r.answered_at is not null
  ),
  ranked as (
    select runs.*, row_number() over (partition by runs.job order by runs.at desc) as rn
    from runs
  ),
  -- Run times are successful runs' only. The range's figures are shown; the
  -- last hour against the 7 days before it decides whether a job is unusual.
  -- The last run and the recent failures come from the same pass: one scan of
  -- ranked, never one per job.
  stats as (
    select x.job,
           (array_agg(to_jsonb(x) - 'job' - 'at' - 'rn') filter (where x.rn = 1))[1] as last,
           count(*) filter (where x.rn <= 3 and not x.ok) as failed_of_last3,
           count(*) filter (where x.rn <= 3) as last3,
           count(*) filter (where not x.ok and x.at > v_now - interval '24 hours') as failed_24h,
           count(*) filter (where not x.ok and x.at > v_now - interval '1 hour') as failed_1h,
           count(*) filter (where x.at >= v_start) as runs,
           count(*) filter (where x.at >= v_start and not x.ok) as failed,
           avg(x.seconds) filter (where x.at >= v_start and x.ok) as avg_s,
           stddev_samp(x.seconds) filter (where x.at >= v_start and x.ok) as sd_s,
           percentile_cont(0.95) within group (order by x.seconds) filter (where x.at >= v_start and x.ok) as p95_s,
           count(*) filter (where x.at >= v_now - interval '1 hour') as runs_1h,
           avg(x.seconds) filter (where x.at >= v_now - interval '1 hour' and x.ok) as avg_1h,
           count(*) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour') as base_runs,
           count(*) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                              and not x.ok) as base_failed,
           count(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                      and x.ok) as base_timed,
           avg(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                    and x.ok) as base_avg,
           stddev_samp(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                            and x.ok) as base_sd
    from ranked x
    group by x.job
  ),
  -- Each job's last start of any status, for last_run_at.
  started as (
    select d.jobid, max(d.start_time) as at
    from cron.job_run_details d
    where d.start_time > v_now - interval '8 days'
    group by d.jobid
  ),
  per_job as (
    select j.jobname, j.schedule,
           s.runs, s.failed, s.avg_s, s.sd_s, s.p95_s, s.runs_1h, s.avg_1h,
           s.base_runs, s.base_failed, s.base_timed, s.base_avg, s.base_sd,
           greatest(
             st.at,
             (select max(r.sent_at) from cron_http_requests r
              where r.job = j.jobname and r.sent_at > v_now - interval '8 days')) as last_run_at,
           s.last,
           coalesce(s.failed_of_last3, 0) as failed_of_last3,
           coalesce(s.last3, 0) as last3,
           coalesce(s.failed_24h, 0) as failed_24h,
           coalesce(s.failed_1h, 0) as failed_1h
    from jobs j
    left join stats s on s.job = j.jobname
    left join started st on st.jobid = j.jobid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', p.jobname,
           'schedule', p.schedule,
           'last_run_at', p.last_run_at,
           'result', case when p.last is null then null else jsonb_build_object(
                       'ok', (p.last ->> 'ok')::boolean,
                       'http_status', p.last -> 'http_status',
                       'timed_out', (p.last ->> 'timed_out')::boolean,
                       'seconds', round((p.last ->> 'seconds')::numeric, 1)) end,
           'status', case
                       when p.last is null then 'unknown'
                       when p.last3 = 3 and p.failed_of_last3 = 3 then 'failing'
                       when not (p.last ->> 'ok')::boolean then 'delayed'
                       else 'healthy' end,
           'failed_24h', p.failed_24h,
           'failed_1h', p.failed_1h,
           'timing', jsonb_build_object(
                       'runs', coalesce(p.runs, 0),
                       'failed', coalesce(p.failed, 0),
                       'average', round(p.avg_s::numeric, 2),
                       'sd', round(p.sd_s::numeric, 2),
                       'p95', round(p.p95_s::numeric, 2)),
           -- failures: 3 or more in the last hour, over 3 standard deviations
           -- (Poisson) above what the 7-day failure rate predicts for that many runs.
           -- slow: the last hour's average over 3 standard deviations and at least
           -- a second above the 7-day average, from at least 10 timed runs.
           'unusual', case
                        when p.failed_1h >= 3 and p.base_runs > 0
                             and p.failed_1h > p.base_failed::numeric / p.base_runs * p.runs_1h
                                               + 3 * sqrt(p.base_failed::numeric / p.base_runs * p.runs_1h)
                        then 'failures'
                        when p.base_timed >= 10 and p.avg_1h is not null
                             and p.avg_1h > p.base_avg + 3 * coalesce(p.base_sd, 0)
                             and p.avg_1h - p.base_avg >= 1
                        then 'slow'
                      end)
         order by p.last_run_at desc nulls last, p.jobname), '[]'::jsonb)
  into v_jobs
  from per_job p;

  v_checks := jsonb_build_object(
    'pulled', jsonb_build_object(
      'status', case when exists (select 1 from jsonb_array_elements(v_pulled) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'sources', v_pulled),
    'inbound', jsonb_build_object(
      'status', case when jsonb_array_length(v_inbound_feeds) = 0 then 'unknown'
                     when exists (select 1 from jsonb_array_elements(v_inbound_feeds) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'feeds', v_inbound_feeds,
      'reconnects_24h', (
        select sum(g.hi - case when g.started_at < v_now - interval '24 hours' then g.lo else 0 end)::int
        from (select h.started_at, max(h.reconnects) as hi, min(h.reconnects) as lo
              from worker_heartbeats h
              where h.worker = 'inbound' and h.received_at > v_now - interval '24 hours'
              group by h.started_at) g)),
    'match_queue', jsonb_build_object(
      'status', case when coalesce(v_spots.oldest_msg_age_sec, 0) > 120 then 'delayed' else 'healthy' end,
      'waiting', v_spots.queue_length,
      'oldest_seconds', v_spots.oldest_msg_age_sec),
    'delivery_queue', jsonb_build_object(
      'status', case when coalesce(v_ready, 0) > 120 then 'delayed' else 'healthy' end,
      'waiting', v_dels.queue_length,
      'oldest_ready_seconds', v_ready,
      'throttled', (select count(*) from destinations where throttled_until > v_now)),
    'sender', jsonb_build_object(
      'status', case when v_sender.id is null then 'unknown'
                     when v_now - coalesce(v_sender.last_progress_at, v_sender.started_at) > interval '120 seconds'
                     then 'failing' else 'healthy' end,
      'progress_seconds', extract(epoch from v_now - coalesce(v_sender.last_progress_at, v_sender.started_at))::int,
      'restarts_24h', case when v_sender.id is null then null else (
        select greatest(count(distinct h.started_at) - 1, 0)::int from worker_heartbeats h
        where h.worker = 'sender' and h.received_at > v_now - interval '24 hours') end,
      'memory_bytes', v_sender.rss_bytes),
    'database', jsonb_build_object(
      'status', case when v_conn > 0.8 * v_max_conn or v_bytes > 0.8 * public.health_disk_limit_bytes()
                     then 'delayed' else 'healthy' end,
      'connections', v_conn,
      'max_connections', v_max_conn,
      'bytes', v_bytes,
      'disk_limit_bytes', public.health_disk_limit_bytes()),
    'jobs', jsonb_build_object(
      'status', case when exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'status' = 'failing')
                     then 'failing'
                     when exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'unusual' is not null)
                     then 'delayed' else 'healthy' end,
      'count', jsonb_array_length(v_jobs),
      'unusual', (select count(*) from jsonb_array_elements(v_jobs) j where j ->> 'unusual' is not null),
      'failed_1h', (select coalesce(sum((j ->> 'failed_1h')::int), 0) from jsonb_array_elements(v_jobs) j)),
    'archive', jsonb_build_object(
      'status', case when v_archived is null or v_archived < v_now - interval '2 hours'
                     then 'delayed' else 'healthy' end,
      'seconds', extract(epoch from v_now - v_archived)::int)
  );

  -- Series, one value per bucket (null where nothing was recorded). Gauges are
  -- the bucket's maximum, counts its sum; percentiles come from the rows.
  with buckets as (
    select i, v_start + v_bucket * i as t
    from generate_series(0, v_count - 1) i
  ),
  samples as (
    select date_bin(v_bucket, s.sampled_at, v_start) as t,
           max(s.match_waiting) as match_waiting,
           max(s.delivery_waiting) as delivery_waiting,
           max(s.delivery_oldest_ready_seconds) as oldest_ready,
           max(s.db_connections) as connections,
           max(s.db_bytes) as db_bytes
    from health_samples s
    where s.sampled_at >= v_start and s.sampled_at < v_end
    group by 1
  ),
  totals as (
    select s.sampled_at, e.key as source, e.value::bigint as total,
           lag(e.value::bigint) over (partition by e.key order by s.sampled_at) as prev
    from health_samples s
    cross join lateral jsonb_each_text(s.spots_total) e
    where s.sampled_at >= v_start - interval '10 minutes' and s.sampled_at < v_end
      and e.key in ('pota', 'sotawatch', 'wwff', 'wwbota', 'dxcluster')
  ),
  spots as (
    select date_bin(v_bucket, t.sampled_at, v_start) as t,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'pota') as pota,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'sotawatch') as sotawatch,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'wwff') as wwff,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'wwbota') as wwbota,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'dxcluster') as dxcluster
    from totals t
    where t.sampled_at >= v_start and t.prev is not null
    group by 1
  ),
  sent as (
    select date_bin(v_bucket, d.sent_at, v_start) as t,
           percentile_cont(0.5) within group (order by extract(epoch from d.sent_at - d.created_at)) as p50,
           percentile_cont(0.95) within group (order by extract(epoch from d.sent_at - d.created_at)) as p95
    from deliveries d
    where d.sent_at >= v_start and d.sent_at < v_end
    group by 1
  ),
  failed as (
    select date_bin(v_bucket, d.last_failed_at, v_start) as t, count(*) as n
    from deliveries d
    where d.last_failed_at >= v_start and d.last_failed_at < v_end
    group by 1
  ),
  expired as (
    -- The claim's unwanted sweep also stamps dropped_at for a paused webhook; that is not expiry.
    select date_bin(v_bucket, d.dropped_at, v_start) as t, count(*) as n
    from deliveries d
    join destinations dest on dest.id = d.destination_id
    where d.dropped_at >= v_start and d.dropped_at < v_end and dest.auto_disabled_at is null
    group by 1
  ),
  memory as (
    select date_bin(v_bucket, h.received_at, v_start) as t,
           max(h.rss_bytes) filter (where h.worker = 'sender') as sender,
           max(h.rss_bytes) filter (where h.worker = 'inbound') as inbound
    from worker_heartbeats h
    where h.received_at >= v_start and h.received_at < v_end
    group by 1
  )
  select jsonb_build_object(
    'match_waiting', jsonb_agg(sa.match_waiting order by b.i),
    'delivery_waiting', jsonb_agg(sa.delivery_waiting order by b.i),
    'oldest_ready_seconds', jsonb_agg(sa.oldest_ready order by b.i),
    'connections', jsonb_agg(sa.connections order by b.i),
    'db_bytes', jsonb_agg(sa.db_bytes order by b.i),
    -- deliveries keeps 7 days, so an empty bucket is a true 0.
    'failed', jsonb_agg(coalesce(f.n, 0) order by b.i),
    'expired', jsonb_agg(coalesce(e.n, 0) order by b.i),
    'latency_p50', jsonb_agg(round(se.p50::numeric, 1) order by b.i),
    'latency_p95', jsonb_agg(round(se.p95::numeric, 1) order by b.i),
    'spots', jsonb_build_object(
      'pota', jsonb_agg(sp.pota order by b.i),
      'sotawatch', jsonb_agg(sp.sotawatch order by b.i),
      'wwff', jsonb_agg(sp.wwff order by b.i),
      'wwbota', jsonb_agg(sp.wwbota order by b.i),
      'dxcluster', jsonb_agg(sp.dxcluster order by b.i)),
    'sender_memory', jsonb_agg(m.sender order by b.i),
    'inbound_memory', jsonb_agg(m.inbound order by b.i))
  into v_series
  from buckets b
  left join samples sa on sa.t = b.t
  left join spots sp on sp.t = b.t
  left join sent se on se.t = b.t
  left join failed f on f.t = b.t
  left join expired e on e.t = b.t
  left join memory m on m.t = b.t;

  return jsonb_build_object(
    'range', p_range,
    'start', v_start,
    'bucket_seconds', extract(epoch from v_bucket)::int,
    'checks', v_checks,
    'limits', jsonb_build_object(
      'match_batch', 500,
      'oldest_ready_seconds', 120,
      'max_connections', v_max_conn,
      'worker_memory_bytes', public.health_worker_memory_bytes()),
    'series', v_series,
    'jobs', v_jobs
  );
end;
$$;

delete from health_cache;

-- The two load-finish refusals named the relay in their message (20261012000050, 20261026001100);
-- otherwise unchanged. create or replace keeps their grants (service role only).
create or replace function public.fcc_license_load_finish(p_load bigint, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := fcc_license_staged_counts();
begin
  perform 1 from license_loads where id = p_load and authority = 'FCC' and status = 'loading'
  for update;
  if not found then
    raise exception 'fcc_license_load_finish: load % is not loading', p_load;
  end if;
  if v_counts is distinct from p_counts then
    raise exception 'fcc_license_load_finish: staged % but the inbound worker sent %', v_counts, p_counts;
  end if;
  update license_loads set status = 'ready', ready_at = now(), counts = v_counts
   where id = p_load;
end;
$$;

create or replace function public.finish_reference_load(p_load bigint, p_rows integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program text;
  v_staged integer;
  v_floor integer;
  v_error text;
begin
  select program into v_program from reference_catalog_loads
  where id = p_load and state = 'staging'
  for update;
  if not found then
    raise exception 'finish_reference_load: load % is not staging', p_load;
  end if;

  select count(*) into v_staged from reference_catalog_stage where load_id = p_load;
  v_floor := reference_load_floor(v_program);
  if p_rows is null or v_staged <> p_rows then
    v_error := format('incomplete: staged %s rows but the inbound worker sent %s', v_staged, coalesce(p_rows::text, 'none'));
  elsif v_staged < v_floor then
    v_error := format('too few rows: staged %s, the floor is %s', v_staged, v_floor);
  end if;

  if v_error is not null then
    update reference_catalog_loads
       set state = 'refused', staged_rows = v_staged, finished_at = now(), error = v_error
     where id = p_load;
    delete from reference_catalog_stage where load_id = p_load;
    return 'refused';
  end if;

  update reference_catalog_loads set state = 'finished', staged_rows = v_staged, finished_at = now()
   where id = p_load;
  return 'finished';
end;
$$;
