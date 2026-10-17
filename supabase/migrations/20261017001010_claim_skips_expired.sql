-- Two fixes to claim_deliveries (code review, 2026-10-17).
--
-- 1. The expiry sweep drops at most 500 rows a call, oldest first, and
--    `ready` had no age check, so when more than 500 rows expire together
--    (after a sender outage, or when a long throttle lifts) the newest-first
--    claim handed out stale ones in the same call. `ready` now applies the
--    sweep's own predicate (the push destination's ttl_seconds, else
--    destination_max_age(type)) the other way round, so an expired row is
--    never claimed; the sweeps of later calls drop what is left.
-- 2. Nothing sets destinations.health = 'paused' any more (pausing is
--    destinations.enabled), but an operator still can by hand, and its queued
--    rows then sat until they expired. The unwanted sweep now drops them like
--    a disabled destination's. The state stays in the check constraint, the
--    mark functions, the sender and the web, which all handle it already;
--    removing it would touch all of them for no behaviour change.
--
-- Same signature, result columns, order and grants as 20261016000400, whose
-- body is otherwise unchanged.
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
  -- 0a. Unwanted: the subscription is disabled, no longer sends to this
  -- destination, or the destination is disabled or paused by hand. Not a
  -- loss, so dropped_at stays null.
  with unwanted as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join subscriptions s on s.id = d.subscription_id
    join destinations dest on dest.id = d.destination_id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (not s.enabled
           or not dest.enabled
           or dest.health = 'paused'
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

  -- 0b. Expire: a push destination's own TTL when it has one, else the type's.
  with old as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and d.created_at < v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                          public.destination_max_age(dest.type))
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

  -- 1 to 5. Ready, budget, rank, choose, claim. Ready leaves out what 0b
  -- would expire, with the same limit, for rows past its 500.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, r.spot_time
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    where q.vt <= v_now
      and d.created_at >= v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and dest.health <> 'paused'
      and dest.enabled
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
  -- A push destination's members, settings and quiet flag are built once
  -- per destination; its spots carry the text built from its fields. A push
  -- destination somehow without a settings row (the trigger makes one for
  -- every insert) is handed the defaults rather than left undeliverable.
  return query
    with push_dests as (
      select dest.id as p_id, ps.s as p_settings,
             jsonb_build_object(
               'devices', public.push_member_devices(dest.id),
               'push', to_jsonb(ps.s) - 'destination_id',
               'quiet_now', public.push_quiet_now(ps.s, pr.timezone, v_now)) as p_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from push_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::push_destination_settings,
                                public.push_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ps
      left join profiles pr on pr.id = dest.user_id
      where dest.type = 'push'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is null then '{}'::jsonb
                else public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r)) end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;
