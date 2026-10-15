-- Rate-aware, newest-first claim with throttle state in Postgres
-- (docs/superpowers/specs/2026-10-15-outbound-sender-design.md, section 2).
--
-- A sender process that polls every few seconds would multiply the worker's
-- per-run caps, so the budget moves into the claim: a token bucket per
-- destination, refilled in spots per minute, and the newest spots first so a
-- backlog never delays the spot that matters. Expiry moves into SQL for the
-- same reason: under newest first the oldest rows would never be claimed, so
-- a worker-side age check would never see them and the queue would grow
-- without bound. A 429 throttles the destination (throttle_destination)
-- without counting toward its health. The sender only sends.
--
-- The claim updates pgmq.q_deliveries_queue directly (pgmq.read cannot rank
-- within a destination), so the function owner must be allowed to update that
-- table. Locally the owner (postgres) owns the queue table; the hosted
-- project is checked by hand before this migration is pushed.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table destinations
  add column throttled_until timestamptz,                             -- not claimable until then
  add column throttle_level int not null default 0,                   -- backoff step, decays per success
  add column claim_tokens numeric not null default 0,                 -- spots left in the bucket
  add column claim_tokens_at timestamptz not null default now();      -- when claim_tokens was last true

-- The client column grant on destinations (20261006000002) is a column list,
-- so the throttle columns stay service-role only without a change here.

alter table deliveries add column dropped_at timestamptz;
create index deliveries_destination_dropped_at_idx on deliveries (destination_id, dropped_at);

-- ---------------------------------------------------------------------------
-- Knobs. Starting values; change them here, never in the sender.
-- ---------------------------------------------------------------------------

-- Spots (delivery rows) a destination may be handed per minute, and the most
-- it can bank. Burst equals the rate. Request equivalents per type:
--   discord  300 = 30 messages of 10 embeds (the DISCORD_MESSAGES_PER_RUN figure)
--   push       3 = 3 notifications per device, per push destination
--   webhook 1000 = 20 requests of 50; effectively uncapped, as today, until
--                  Phase 2 sets a real number
create function public.destination_budget(p_type text)
returns table (rate_per_minute numeric, burst numeric)
language sql
immutable
set search_path = ''
as $$
  select r, r
  from (values ('discord', 300::numeric), ('push', 3::numeric), ('webhook', 1000::numeric)) as b (t, r)
  where b.t = p_type;
$$;

-- How long a 429 without a Retry-After hides a destination: 60 s at level 1,
-- doubling to a 900 s ceiling.
create function public.destination_throttle_seconds(p_level int)
returns int
language sql
immutable
set search_path = ''
as $$
  select least(900, 60 * (2 ^ greatest(0, least(p_level, 8) - 1)))::int;
$$;

-- How long a delivery may wait before it is dropped undelivered. A push alert
-- is worth sending only while the push service would still deliver it.
create function public.destination_max_age(p_type text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case when p_type = 'push' then interval '15 minutes' else interval '24 hours' end;
$$;

revoke all on function public.destination_budget(text) from public;
revoke all on function public.destination_throttle_seconds(int) from public;
revoke all on function public.destination_max_age(text) from public;

-- ---------------------------------------------------------------------------
-- The claim
-- ---------------------------------------------------------------------------

-- Same signature and result columns as 20261014000100. Body, one transaction:
--   0. expire: visible messages whose delivery is older than the type's max
--      age are dropped (status, dropped_at) and archived, at most 500 per
--      call, every call, whether or not anything is claimable;
--   1. ready: visible messages joined to their delivery, destination and
--      spot, leaving out paused and throttled destinations; messages with no
--      delivery row are archived as before;
--   2. budget: tokens per destination, refilled by rate * minutes since
--      claim_tokens_at and capped at burst;
--   3. ranked: newest spot first within each destination;
--   4. chosen: rank within budget, ordered by rank first and then spot time,
--      so every destination gets its newest spot before any gets its second;
--   5. claim: hide the chosen messages, re-checking vt on the latest row
--      version so an overlapping claimer cannot take the same message;
--   6. debit: tokens left = available - claimed, stamped now;
--   7. return the claimed rows with spot and destination JSON as before.
create or replace function public.claim_deliveries(p_limit int default 200, p_vt int default 60)
returns table (
  msg_id bigint, delivery_id bigint, subscription_id uuid, attempts int, created_at timestamptz,
  destination jsonb, spot jsonb
)
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  c_expire_batch constant int := 500;
  v_now     timestamptz := clock_timestamp();
  v_expired bigint[];
  v_orphans bigint[];
  v_claimed jsonb;
begin
  -- 0. Expire.
  with old as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and d.created_at < v_now - public.destination_max_age(dest.type)
    order by d.created_at
    limit c_expire_batch
  ),
  dropped as (
    update deliveries d
    set status = 'dropped', dropped_at = v_now
    from old
    where d.id = old.id and d.status in ('pending', 'failed')
    returning d.id
  )
  select array_agg(dropped.id) into v_expired from dropped;

  if v_expired is not null then
    perform pgmq.archive('deliveries_queue', array(
      select q.msg_id from pgmq.q_deliveries_queue q
      where (q.message ->> 'delivery_id')::bigint = any (v_expired)));
  end if;

  -- 1. Orphans: a visible message whose delivery row is gone.
  select array_agg(q.msg_id) into v_orphans
  from pgmq.q_deliveries_queue q
  where q.vt <= v_now
    and not exists (select 1 from deliveries d where d.id = (q.message ->> 'delivery_id')::bigint);
  if v_orphans is not null then
    perform pgmq.archive('deliveries_queue', v_orphans);
  end if;

  -- 1 to 5. Ready, budget, rank, choose, claim.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, r.spot_time
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    where q.vt <= v_now
      and dest.health <> 'paused'
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
  ),
  budget as (
    select dest.id as destination_id,
           least(b.burst,
                 dest.claim_tokens
                 + b.rate_per_minute * greatest(0, extract(epoch from v_now - dest.claim_tokens_at)) / 60) as available
    from destinations dest
    cross join lateral public.destination_budget(dest.type) b
    where dest.id in (select distinct ready.destination_id from ready)
  ),
  ranked as (
    select ready.msg_id, ready.delivery_id, ready.destination_id, ready.spot_time, budget.available,
           row_number() over (partition by ready.destination_id
                              order by ready.spot_time desc, ready.delivery_id desc) as rn
    from ready
    join budget on budget.destination_id = ready.destination_id
  ),
  chosen as (
    select ranked.msg_id, ranked.delivery_id, ranked.destination_id, ranked.spot_time, ranked.available, ranked.rn
    from ranked
    where ranked.rn <= floor(ranked.available)
    order by ranked.rn, ranked.spot_time desc, ranked.delivery_id desc
    limit p_limit
  ),
  claimed as (
    update pgmq.q_deliveries_queue q
    set vt = v_now + make_interval(secs => p_vt), read_ct = q.read_ct + 1
    from chosen
    where q.msg_id = chosen.msg_id and q.vt <= v_now
    returning q.msg_id, chosen.delivery_id, chosen.destination_id, chosen.available, chosen.rn, chosen.spot_time
  )
  select jsonb_agg(jsonb_build_object(
           'msg_id', claimed.msg_id, 'delivery_id', claimed.delivery_id,
           'destination_id', claimed.destination_id, 'available', claimed.available,
           'rn', claimed.rn, 'spot_time', claimed.spot_time))
    into v_claimed
  from claimed;

  if v_claimed is null then
    return;
  end if;

  -- 6. Debit.
  update destinations dest
  set claim_tokens = c.available - c.n, claim_tokens_at = v_now
  from (
    select (x ->> 'destination_id')::uuid as destination_id,
           max((x ->> 'available')::numeric) as available,
           count(*) as n
    from jsonb_array_elements(v_claimed) x
    group by 1
  ) c
  where dest.id = c.destination_id;

  -- 7. Return, in the order chosen: every destination's newest spot first.
  return query
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || case when dest.type = 'push' then jsonb_build_object('devices', dv.devices) else '{}'::jsonb end,
      jsonb_build_object(
        'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
        'base_callsign', r.base_callsign,
        'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
        'mode_family', r.mode_family,
        'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
        'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref
      )
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth)
                                order by p.created_at, p.id), '[]'::jsonb) as devices
      from push_devices p
      where dest.type = 'push' and p.user_id = dest.user_id
    ) dv
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------

-- Same as 20261006000010 plus the throttle: a successful cycle clears
-- throttled_until and steps throttle_level down by one (not to zero, so one
-- success after a 429 storm does not drop straight back to the base delay).
create or replace function public.mark_deliveries_sent(p_delivery_ids bigint[], p_msg_ids bigint[])
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  update deliveries d set status = 'sent', sent_at = now() where d.id = any (p_delivery_ids);
  update destinations dest
  set consecutive_failures = 0,
      last_success_at = now(),
      health = case when dest.health = 'paused' then 'paused' else 'ok' end,
      throttled_until = null,
      throttle_level = greatest(0, dest.throttle_level - 1)
  where dest.id in (select d.destination_id from deliveries d where d.id = any (p_delivery_ids));
  perform pgmq.archive('deliveries_queue', p_msg_ids);
end;
$$;

-- Same as 20261006000010 plus dropped_at, so delivery_queue_stats counts
-- these too while the Edge worker still runs.
create or replace function public.mark_deliveries_dropped(p_delivery_ids bigint[], p_msg_ids bigint[])
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  update deliveries d set status = 'dropped', dropped_at = now() where d.id = any (p_delivery_ids);
  perform pgmq.archive('deliveries_queue', p_msg_ids);
end;
$$;

-- Rate limited (a 429, or the Discord message cap): the destination is alive,
-- so nothing counts toward its health. Hides the destination and the given
-- messages for p_seconds (the response's Retry-After) or, when that is null,
-- for destination_throttle_seconds at the new level. Returns the seconds used.
create function public.throttle_destination(p_destination_id uuid, p_msg_ids bigint[], p_seconds int)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_seconds int;
begin
  update destinations dest
  set throttle_level = dest.throttle_level + 1,
      throttled_until = now() + make_interval(secs =>
        greatest(1, coalesce(p_seconds, public.destination_throttle_seconds(dest.throttle_level + 1))))
  where dest.id = p_destination_id
  returning extract(epoch from dest.throttled_until - now())::int into v_seconds;
  if v_seconds is null then
    raise exception 'Destination not found.';
  end if;
  perform pgmq.set_vt('deliveries_queue', m, v_seconds) from unnest(p_msg_ids) as m;
  return v_seconds;
end;
$$;

-- Queue depth and the deliveries expired undelivered in the last hour: the
-- sender's /healthz figures. Loss, never oldest-pending age.
create function public.delivery_queue_stats()
returns table (depth bigint, expired_last_hour bigint)
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return query
    select
      (select m.queue_length from pgmq.metrics('deliveries_queue') m),
      (select count(*) from deliveries d where d.dropped_at > now() - interval '1 hour');
end;
$$;

-- ---------------------------------------------------------------------------
-- Access. The sender role (20261015000200) may call the two new RPCs.
-- ---------------------------------------------------------------------------

revoke all on function public.throttle_destination(uuid, bigint[], int) from public;
revoke all on function public.delivery_queue_stats() from public;
grant execute on function public.throttle_destination(uuid, bigint[], int) to service_role, delivery_sender;
grant execute on function public.delivery_queue_stats() to service_role, delivery_sender;
