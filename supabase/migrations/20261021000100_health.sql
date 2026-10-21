-- The public Health page (docs/superpowers/specs/2026-10-21-health-page-design.md).
--
-- - health_samples: one row a minute from the health-sample cron job, for the
--   figures that exist only in the moment (queue depths and ages, connections,
--   database size) and each source's running spot total.
-- - worker_heartbeats: the sender (record_sender_heartbeat, its own role) and
--   the relay (record_relay_heartbeat through relay-status) report in once a
--   minute: start time, RSS, progress or feeds.
-- - cron_http_requests: cron_call_function logs every pg_net request id a cron
--   job sends; the sampler copies its response status before pg_net forgets it.
--   The six function-calling jobs are rescheduled through it, same schedules,
--   bodies and timeouts.
-- - deliveries.last_failed_at, set by trigger, since mark_deliveries_failed
--   writes no time and a later success overwrites the row.
-- - health_snapshot(range) builds the payload (HealthPayload in
--   web/src/health/types.ts, pinned by supabase/tests/health_snapshot.test.sql);
--   cached_health(range) serves it to the public health function, 30 seconds a
--   range, as cached_band_map does.
--
-- Everything is service-role only. The payload carries statuses and numbers,
-- never error text, ids or URLs. The sampler prunes its own tables after 8
-- days, so run_housekeeping is not redefined.

-- ---------------------------------------------------------------------------
-- Knobs.

-- What "disk % full" is measured against: Supabase Pro's included 8 GB.
-- Postgres can't see the plan's limit; change this when the disk grows.
create function public.health_disk_limit_bytes()
returns bigint
language sql
immutable
set search_path = public
as $$ select 8::bigint * 1024 * 1024 * 1024 $$;

-- Each Fly machine's memory (sender/fly.toml, relay/fly.toml).
create function public.health_worker_memory_bytes()
returns bigint
language sql
immutable
set search_path = public
as $$ select 256::bigint * 1024 * 1024 $$;

revoke all on function public.health_disk_limit_bytes() from public, anon, authenticated;
revoke all on function public.health_worker_memory_bytes() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables.

create table health_samples (
  sampled_at                     timestamptz primary key,
  match_waiting                  bigint not null,
  match_oldest_seconds           int,
  delivery_waiting               bigint not null,
  delivery_oldest_ready_seconds  int,
  throttled_destinations         int    not null,
  db_connections                 int    not null,
  db_bytes                       bigint not null,
  -- {source: ingest_state.total_spots_ingested}; spots per bucket are the differences.
  spots_total                    jsonb  not null
);

create table worker_heartbeats (
  id                bigserial primary key,
  worker            text        not null check (worker in ('sender', 'relay')),
  received_at       timestamptz not null default now(),
  started_at        timestamptz not null,
  rss_bytes         bigint      not null check (rss_bytes >= 0),
  last_progress_at  timestamptz,                   -- sender
  reconnects        int check (reconnects >= 0),   -- relay, since started_at
  feeds             jsonb                          -- relay: [{id, connected}]
);

create index worker_heartbeats_worker_received_idx on worker_heartbeats (worker, received_at desc);

create table cron_http_requests (
  request_id   bigint primary key,
  job          text        not null,
  sent_at      timestamptz not null default now(),
  status_code  int,
  timed_out    boolean,
  answered_at  timestamptz
);

create index cron_http_requests_job_sent_idx on cron_http_requests (job, sent_at desc);
create index cron_http_requests_unanswered_idx on cron_http_requests (request_id) where answered_at is null;

create table health_cache (
  range         text        primary key check (range in ('1h', '24h', '7d')),
  payload       jsonb       not null,
  generated_at  timestamptz not null
);

comment on table health_samples is 'One row a minute from record_health_sample(); kept 8 days.';
comment on table worker_heartbeats is 'Sender and relay heartbeats, about one a minute each; kept 8 days.';
comment on table cron_http_requests is 'pg_net requests sent by cron_call_function, with the response status once answered; kept 8 days.';
comment on table health_cache is 'The health payload per range; cached_health() rebuilds a row when it is over 30 seconds old.';

alter table health_samples enable row level security;
alter table worker_heartbeats enable row level security;
alter table cron_http_requests enable row level security;
alter table health_cache enable row level security;

revoke all on health_samples from anon, authenticated;
revoke all on worker_heartbeats from anon, authenticated;
revoke all on sequence worker_heartbeats_id_seq from anon, authenticated;
revoke all on cron_http_requests from anon, authenticated;
revoke all on health_cache from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Delivery event times. A failure is when attempts goes up with status failed;
-- the partial indexes keep the per-bucket counts off the whole table.

alter table deliveries add column last_failed_at timestamptz;

create function public.deliveries_set_last_failed_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'failed' and new.attempts > old.attempts then
    new.last_failed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.deliveries_set_last_failed_at() from public, anon, authenticated;

create trigger deliveries_last_failed_at
before update of status, attempts on deliveries
for each row execute function public.deliveries_set_last_failed_at();

create index deliveries_sent_at_idx on deliveries (sent_at) where sent_at is not null;
create index deliveries_dropped_at_idx on deliveries (dropped_at) where dropped_at is not null;
create index deliveries_last_failed_at_idx on deliveries (last_failed_at) where last_failed_at is not null;

-- ---------------------------------------------------------------------------
-- Cron jobs that call a function. The request id goes in cron_http_requests so
-- the job's HTTP status can be read back; Vault holds the URL and key, as in
-- 20261005000008. Missing secrets fail the run as before.

create function public.cron_call_function(
  p_job text,
  p_function text,
  p_body jsonb default '{}'::jsonb,
  p_timeout_ms int default 30000
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
           || '/functions/v1/' || p_function,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
    ),
    body := p_body,
    timeout_milliseconds := p_timeout_ms
  ) into v_id;
  insert into cron_http_requests (request_id, job) values (v_id, p_job);
  return v_id;
end;
$$;

revoke all on function public.cron_call_function(text, text, jsonb, int) from public, anon, authenticated;

-- Same names, schedules, bodies and timeouts; cron.schedule replaces by name.
select cron.schedule('ingest-pota', '* * * * *',
  $$ select public.cron_call_function('ingest-pota', 'ingest-pota', '{}'::jsonb, 30000); $$);
select cron.schedule('ingest-sotawatch', '30 seconds',
  $$ select public.cron_call_function('ingest-sotawatch', 'ingest-sotawatch', '{}'::jsonb, 30000); $$);
select cron.schedule('ingest-wwff', '* * * * *',
  $$ select public.cron_call_function('ingest-wwff', 'ingest-wwff', '{}'::jsonb, 30000); $$);
select cron.schedule('archive-spots', '*/10 * * * *',
  $$ select public.cron_call_function('archive-spots', 'archive', '{}'::jsonb, 120000); $$);
select cron.schedule('archive-aprs', '2-59/5 * * * *',
  $$ select public.cron_call_function('archive-aprs', 'archive', '{"sources": ["aprs"]}'::jsonb, 120000); $$);
select cron.schedule('import-cty', '20 4 * * 1',
  $$ select public.cron_call_function('import-cty', 'import-cty', '{}'::jsonb, 60000); $$);

-- ---------------------------------------------------------------------------
-- Oldest ready delivery, per destination (decision 4): deliveries go newest
-- first under a budget, so a busy destination always has old rows waiting.
-- The figure is, per destination, the age of its newest ready row, then the
-- largest: how long some destination has had something to send and got
-- nothing. "Ready" is claim_deliveries' ready predicate; change them together.
-- Null when nothing is ready.

create function public.health_oldest_ready_seconds(p_now timestamptz)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select max(x.age)::int
  from (
    select extract(epoch from p_now - max(d.created_at)) as age
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where q.vt <= p_now
      and d.created_at >= p_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and not public.webhook_retries_exhausted(ws.retry_policy, d.attempts)
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= p_now)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
    group by d.destination_id
  ) x;
$$;

revoke all on function public.health_oldest_ready_seconds(timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sampler: one row a minute, then the response copy and the prune.

create function public.record_health_sample()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_spots record;
  v_dels  record;
begin
  select * into v_spots from pgmq.metrics('spot_events');
  select * into v_dels from pgmq.metrics('deliveries_queue');

  insert into health_samples (
    sampled_at, match_waiting, match_oldest_seconds, delivery_waiting,
    delivery_oldest_ready_seconds, throttled_destinations, db_connections, db_bytes, spots_total
  ) values (
    date_trunc('minute', v_now),
    v_spots.queue_length,
    v_spots.oldest_msg_age_sec,
    v_dels.queue_length,
    public.health_oldest_ready_seconds(v_now),
    (select count(*) from destinations where throttled_until > v_now),
    (select count(*) from pg_stat_activity where backend_type = 'client backend'),
    pg_database_size(current_database()),
    (select coalesce(jsonb_object_agg(source, total_spots_ingested), '{}'::jsonb) from ingest_state)
  )
  on conflict (sampled_at) do nothing;

  update cron_http_requests r
  set status_code = h.status_code,
      timed_out = coalesce(h.timed_out, false),
      answered_at = h.created
  from net._http_response h
  where h.id = r.request_id
    and r.answered_at is null;

  delete from health_samples where sampled_at < v_now - interval '8 days';
  delete from worker_heartbeats where received_at < v_now - interval '8 days';
  delete from cron_http_requests where sent_at < v_now - interval '8 days';
end;
$$;

revoke all on function public.record_health_sample() from public, anon, authenticated;

select cron.schedule('health-sample', '* * * * *', $$ select public.record_health_sample(); $$);

-- ---------------------------------------------------------------------------
-- Heartbeats. At most one row per worker per 30 seconds, whatever the caller's
-- interval, so a misconfigured worker can't grow the table.

create function public.record_sender_heartbeat(
  p_started_at timestamptz,
  p_last_progress_at timestamptz,
  p_rss_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_started_at is null or p_rss_bytes is null or p_rss_bytes < 0 then
    raise exception 'A heartbeat needs a start time and a memory figure.' using errcode = '22023';
  end if;
  if exists (select 1 from worker_heartbeats
             where worker = 'sender' and received_at > now() - interval '30 seconds') then
    return;
  end if;
  insert into worker_heartbeats (worker, started_at, rss_bytes, last_progress_at)
  values ('sender', p_started_at, p_rss_bytes, p_last_progress_at);
end;
$$;

create function public.record_relay_heartbeat(
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
             where worker = 'relay' and received_at > now() - interval '30 seconds') then
    return;
  end if;
  insert into worker_heartbeats (worker, started_at, rss_bytes, reconnects, feeds)
  values ('relay', p_started_at, p_rss_bytes, p_reconnects,
          coalesce((select jsonb_agg(jsonb_build_object('id', f ->> 'id',
                                                        'connected', coalesce((f ->> 'connected')::boolean, false))
                                     order by f ->> 'id')
                    from jsonb_array_elements(p_feeds) f
                    where f ->> 'id' in ('rbn', 'dxcluster', 'aprs')), '[]'::jsonb));
end;
$$;

revoke all on function public.record_sender_heartbeat(timestamptz, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.record_relay_heartbeat(timestamptz, bigint, int, jsonb) from public, anon, authenticated;
-- The sender's allowlist (sender/db.ts SENDER_RPCS, sender_role.test.sql).
grant execute on function public.record_sender_heartbeat(timestamptz, timestamptz, bigint) to delivery_sender;

-- ---------------------------------------------------------------------------
-- The payload. Every status is decided here; the web words it. Thresholds
-- match the page's rule copy and are pinned by health_snapshot.test.sql.

create function public.health_snapshot(p_range text)
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
  v_relay    worker_heartbeats%rowtype;
  v_checks   jsonb;
  v_series   jsonb;
  v_jobs     jsonb;
  v_pulled   jsonb;
  v_relayed  jsonb;
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
  select * into v_relay from worker_heartbeats
  where worker = 'relay' order by received_at desc limit 1;

  -- Feeds checked: the relay's own list when it reported in the last 10
  -- minutes, else the relay sources that succeeded in the last 7 days.
  if v_relay.received_at > v_now - interval '10 minutes' then
    select coalesce(array_agg(f ->> 'id' order by f ->> 'id'), '{}') into v_feeds
    from jsonb_array_elements(v_relay.feeds) f;
  else
    select coalesce(array_agg(source order by source), '{}') into v_feeds
    from ingest_state
    where source in ('rbn', 'dxcluster', 'aprs') and last_success_at > v_now - interval '7 days';
  end if;

  select jsonb_agg(jsonb_build_object(
           'source', s.source,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by s.source)
  into v_pulled
  from ingest_state s where s.source in ('pota', 'sotawatch', 'wwff');

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', f.id,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by f.id), '[]'::jsonb)
  into v_relayed
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
           extract(epoch from r.answered_at - r.sent_at)
    from cron_http_requests r
    where r.sent_at > v_now - interval '8 days'
      and r.answered_at is not null
  ),
  ranked as (
    select runs.*, row_number() over (partition by runs.job order by runs.at desc) as rn
    from runs
  ),
  per_job as (
    select j.jobname, j.schedule,
           greatest(
             (select max(d.start_time) from cron.job_run_details d
              where d.jobid = j.jobid and d.start_time > v_now - interval '8 days'),
             (select max(r.sent_at) from cron_http_requests r
              where r.job = j.jobname and r.sent_at > v_now - interval '8 days')) as last_run_at,
           (select to_jsonb(x) - 'job' - 'at' - 'rn' from ranked x where x.job = j.jobname and x.rn = 1) as last,
           (select count(*) from ranked x where x.job = j.jobname and x.rn <= 3 and not x.ok) as failed_of_last3,
           (select count(*) from ranked x where x.job = j.jobname and x.rn <= 3) as last3,
           (select count(*) from ranked x
            where x.job = j.jobname and not x.ok and x.at > v_now - interval '24 hours') as failed_24h,
           (select count(*) from ranked x
            where x.job = j.jobname and not x.ok and x.at > v_now - interval '1 hour') as failed_1h
    from jobs j
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
           'failed_1h', p.failed_1h)
         order by p.last_run_at desc nulls last, p.jobname), '[]'::jsonb)
  into v_jobs
  from per_job p;

  v_checks := jsonb_build_object(
    'pulled', jsonb_build_object(
      'status', case when exists (select 1 from jsonb_array_elements(v_pulled) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'sources', v_pulled),
    'relay', jsonb_build_object(
      'status', case when jsonb_array_length(v_relayed) = 0 then 'unknown'
                     when exists (select 1 from jsonb_array_elements(v_relayed) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'feeds', v_relayed,
      'reconnects_24h', (
        select sum(g.hi - case when g.started_at < v_now - interval '24 hours' then g.lo else 0 end)::int
        from (select h.started_at, max(h.reconnects) as hi, min(h.reconnects) as lo
              from worker_heartbeats h
              where h.worker = 'relay' and h.received_at > v_now - interval '24 hours'
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
                     then 'failing' else 'healthy' end,
      'count', jsonb_array_length(v_jobs),
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
           max(s.db_connections) as connections
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
      and e.key in ('pota', 'sotawatch', 'wwff', 'dxcluster')
  ),
  spots as (
    select date_bin(v_bucket, t.sampled_at, v_start) as t,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'pota') as pota,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'sotawatch') as sotawatch,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'wwff') as wwff,
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
           max(h.rss_bytes) filter (where h.worker = 'relay') as relay
    from worker_heartbeats h
    where h.received_at >= v_start and h.received_at < v_end
    group by 1
  )
  select jsonb_build_object(
    'match_waiting', jsonb_agg(sa.match_waiting order by b.i),
    'delivery_waiting', jsonb_agg(sa.delivery_waiting order by b.i),
    'oldest_ready_seconds', jsonb_agg(sa.oldest_ready order by b.i),
    'connections', jsonb_agg(sa.connections order by b.i),
    -- deliveries keeps 7 days, so an empty bucket is a true 0.
    'failed', jsonb_agg(coalesce(f.n, 0) order by b.i),
    'expired', jsonb_agg(coalesce(e.n, 0) order by b.i),
    'latency_p50', jsonb_agg(round(se.p50::numeric, 1) order by b.i),
    'latency_p95', jsonb_agg(round(se.p95::numeric, 1) order by b.i),
    'spots', jsonb_build_object(
      'pota', jsonb_agg(sp.pota order by b.i),
      'sotawatch', jsonb_agg(sp.sotawatch order by b.i),
      'wwff', jsonb_agg(sp.wwff order by b.i),
      'dxcluster', jsonb_agg(sp.dxcluster order by b.i)),
    'sender_memory', jsonb_agg(m.sender order by b.i),
    'relay_memory', jsonb_agg(m.relay order by b.i))
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

-- The payload with its generated_at, rebuilt at most every 30 seconds a range
-- under a transaction-scoped advisory lock, as cached_band_map() does.
create function public.cached_health(p_range text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload      jsonb;
  v_generated_at timestamptz;
begin
  if p_range is null or p_range not in ('1h', '24h', '7d') then
    raise exception 'Unknown range.' using errcode = '22023';
  end if;

  select c.payload, c.generated_at into v_payload, v_generated_at
  from health_cache c
  where c.range = p_range and c.generated_at > clock_timestamp() - interval '30 seconds';
  if found then
    return v_payload || jsonb_build_object('generated_at', v_generated_at);
  end if;

  perform pg_advisory_xact_lock(hashtext('health_cache:' || p_range));
  select c.payload, c.generated_at into v_payload, v_generated_at
  from health_cache c
  where c.range = p_range and c.generated_at > clock_timestamp() - interval '30 seconds';
  if found then
    return v_payload || jsonb_build_object('generated_at', v_generated_at);
  end if;

  v_payload := public.health_snapshot(p_range);
  v_generated_at := now();
  insert into health_cache (range, payload, generated_at)
  values (p_range, v_payload, v_generated_at)
  on conflict (range) do update set payload = excluded.payload, generated_at = excluded.generated_at;
  return v_payload || jsonb_build_object('generated_at', v_generated_at);
end;
$$;

revoke all on function public.health_snapshot(text) from public, anon, authenticated;
revoke all on function public.cached_health(text) from public, anon, authenticated;
grant execute on function public.cached_health(text) to service_role;
grant execute on function public.record_relay_heartbeat(timestamptz, bigint, int, jsonb) to service_role;

-- A first sample, so the page has a point as soon as this is applied.
select public.record_health_sample();
