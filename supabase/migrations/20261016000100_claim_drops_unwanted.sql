-- claim_deliveries drops what the user no longer wants.
--
-- Until now the claim joined deliveries to destinations and spots only, so a
-- delivery queued for a subscription that was then disabled, or for a
-- destination that save_subscription then unlinked, was still sent: a failing
-- or throttled endpoint that recovered got up to destination_max_age of
-- backlog the user had switched off.
--
-- Same signature and result columns as 20261015001000, so the grants
-- (service_role, delivery_sender) carry over. The body gains one step ahead of
-- the expiry sweep:
--   0a. unwanted: a visible message whose delivery is pending or failed and
--       whose subscription is disabled, or whose (subscription, destination)
--       link is gone from subscription_destinations, is dropped and its
--       message archived, at most 500 per call, every call;
-- and `ready` requires the same two conditions, so a row past the 500 cap is
-- never claimed before a later call sweeps it.
--
-- An unwanted drop sets status = 'dropped' and leaves dropped_at null.
-- dropped_at means "expired undelivered": delivery_queue_stats counts it as
-- the sender's loss signal (expired_last_hour), and a delivery the user
-- turned off is not a loss. status = 'dropped' keeps the row out of both
-- sweeps and the archived message keeps it out of the queue. Rows dropped
-- before 20261015000400 have the same shape.
--
-- Re-enabling a subscription or re-linking a destination does not bring a
-- dropped delivery back; only spots matched afterwards are delivered.
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
  v_now       timestamptz := clock_timestamp();
  v_unwanted  bigint[];
  v_expired   bigint[];
  v_orphans   bigint[];
  v_claimed   jsonb;
begin
  -- 0a. Unwanted: the subscription is disabled or no longer sends to this
  -- destination. Not a loss, so dropped_at stays null.
  with unwanted as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join subscriptions s on s.id = d.subscription_id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (not s.enabled
           or not exists (select 1 from subscription_destinations sd
                          where sd.subscription_id = d.subscription_id
                            and sd.destination_id = d.destination_id))
    order by d.created_at
    limit c_expire_batch
  ),
  dropped as (
    update deliveries d
    set status = 'dropped'
    from unwanted
    where d.id = unwanted.id and d.status in ('pending', 'failed')
    returning d.id
  )
  select array_agg(dropped.id) into v_unwanted from dropped;

  if v_unwanted is not null then
    perform pgmq.archive('deliveries_queue', array(
      select q.msg_id from pgmq.q_deliveries_queue q
      where (q.message ->> 'delivery_id')::bigint = any (v_unwanted)));
  end if;

  -- 0b. Expire.
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
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    where q.vt <= v_now
      and dest.health <> 'paused'
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
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
        'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref,
        'wwff_reference', r.wwff_reference, 'wwff_reference_name', r.wwff_reference_name
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
