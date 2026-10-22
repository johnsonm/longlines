-- A delivery claimed against a destination's old URL no longer lands its
-- outcome on the new URL's health (#145).
--
-- update_destination resets consecutive_failures, last_error and 'failing'
-- health when the URL changes, but a batch the sender claimed before the
-- change still reports after it: mark_deliveries_failed then wrote the old
-- URL's error (and a pause count) onto the new URL, and mark_deliveries_sent
-- marked the new URL healthy because the old one answered.
--
-- 1. destinations.url_generation counts URL changes; update_destination bumps
--    it whenever it changes the URL (the same v_new that resets health).
-- 2. deliveries.url_generation is the generation a row was last claimed at.
--    claim_deliveries stamps it right after the debit, which holds the
--    destination's row lock until the claim commits, so the stamp and the URL
--    the claim returns always agree. Null means never claimed since this
--    migration and is read as current.
-- 3. mark_deliveries_sent and mark_deliveries_failed update a destination
--    (health, counts, last error and success, throttle reset, pause count)
--    only when at least one of the given rows was claimed at its current
--    generation. The delivery rows, queue messages and retry delays are
--    marked exactly as before, and so is the drop of a paused webhook's queue.
--
-- throttle_destination and record_push_results are unchanged: a throttle is
-- not health (a stale one delays the new URL by at most its Retry-After), and
-- push destinations have no URL. No signature, result column or grant
-- changes; the sender needs no change. Both new columns are left out of the
-- client column grants.

alter table destinations add column url_generation int not null default 0;
alter table deliveries add column url_generation int;

-- As in 20261019000520, plus the url_generation bump on a URL change.
create or replace function public.update_destination(p_id uuid, p_name text, p_url text, p_enabled boolean default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_type text;
  v_url  text;
  v_new  boolean;
  v_resume boolean;
  v_constraint text;
  v_dropped bigint[];
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type, d.url, coalesce(p_enabled, false) and d.auto_disabled_at is not null
    into v_type, v_url, v_resume
  from destinations d where d.id = p_id and d.user_id = v_user for update;
  if v_type is null then
    raise exception 'Destination not found.';
  end if;
  if p_name is not null and trim(p_name) = '' then
    raise exception 'Give the destination a name.';
  end if;
  if p_url is not null then
    perform public.validate_destination_url(v_type, p_url);
  end if;
  v_new := p_url is not null and trim(p_url) is distinct from v_url;
  update destinations d
  set name                 = coalesce(trim(p_name), d.name),
      url                  = coalesce(trim(p_url), d.url),
      url_display          = coalesce(public.destination_url_display(v_type, p_url), d.url_display),
      url_generation       = case when v_new then d.url_generation + 1 else d.url_generation end,
      enabled              = coalesce(p_enabled, d.enabled),
      health               = case when v_new and d.health = 'failing' then 'ok' else d.health end,
      consecutive_failures = case when v_new or v_resume then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end,
      auto_disabled_at     = case when v_resume then null else d.auto_disabled_at end,
      pause_failures       = case when v_resume then 0 else d.pause_failures end,
      pause_failure_at     = case when v_resume then null else d.pause_failure_at end
  where d.id = p_id;

  -- The pause lost what was queued; the claim's unwanted sweep drops it the
  -- same way (status, dropped_at, archived message).
  if v_resume then
    with dropped as (
      update deliveries d
      set status = 'dropped', dropped_at = now()
      where d.destination_id = p_id and d.status in ('pending', 'failed')
      returning d.id
    )
    select array_agg(dropped.id) into v_dropped from dropped;
    if v_dropped is not null then
      perform pgmq.archive('deliveries_queue', array(
        select q.msg_id from pgmq.q_deliveries_queue q
        where (q.message ->> 'delivery_id')::bigint = any (v_dropped)));
    end if;
  end if;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'destinations_user_name_key' then
    raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
  end if;
  raise;
end;
$$;

-- As in 20261015000400, except that a destination is updated only when one
-- of the rows was claimed at its current URL generation.
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
  where dest.id in (select d.destination_id from deliveries d
                    where d.id = any (p_delivery_ids)
                      and (d.url_generation is null or d.url_generation = dest.url_generation));
  perform pgmq.archive('deliveries_queue', p_msg_ids);
end;
$$;

-- As in 20261018000300, except that the destination's failure count, last
-- error, health and pause count move only when one of the rows was claimed at
-- its current URL generation. The rows, their retry delays and the drop of a
-- paused webhook's queue are unchanged.
create or replace function public.mark_deliveries_failed(
  p_delivery_ids bigint[], p_msg_ids bigint[], p_error text, p_delay_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  update deliveries d
  set status = 'failed', attempts = d.attempts + 1, last_error = p_error
  where d.id = any (p_delivery_ids);

  with target as (
    select dest.id, ws.pause_after_failures as pause_after,
           case
             when ws.pause_after_failures is null or not dest.enabled then null
             when dest.pause_failure_at is null or dest.last_success_at > dest.pause_failure_at then 1
             when dest.pause_failure_at <= now() - public.webhook_pause_spacing() then dest.pause_failures + 1
           end as counted
    from destinations dest
    left join webhook_destination_settings ws on ws.destination_id = dest.id and dest.type = 'webhook'
    where dest.id in (select d.destination_id from deliveries d
                      where d.id = any (p_delivery_ids)
                        and (d.url_generation is null or d.url_generation = dest.url_generation))
  )
  update destinations dest
  set consecutive_failures = dest.consecutive_failures + 1,
      last_error = p_error,
      last_error_at = now(),
      health = case
        when dest.health = 'paused' then 'paused'
        when dest.consecutive_failures + 1 >= 5 then 'failing'
        else dest.health
      end,
      pause_failures = coalesce(t.counted, dest.pause_failures),
      pause_failure_at = case when t.counted is not null then now() else dest.pause_failure_at end,
      enabled = case when t.counted >= t.pause_after then false else dest.enabled end,
      auto_disabled_at = case when t.counted >= t.pause_after then now() else dest.auto_disabled_at end
  from target t
  where dest.id = t.id;

  perform pgmq.set_vt('deliveries_queue', u.msg_id,
    case
      when ws.destination_id is null then p_delay_seconds
      when public.webhook_retries_exhausted(ws.retry_policy, d.attempts) then 0
      else public.webhook_retry_delay(ws.retry_policy, d.attempts)
    end)
  from unnest(p_delivery_ids, p_msg_ids) as u(delivery_id, msg_id)
  left join deliveries d on d.id = u.delivery_id
  left join destinations dest on dest.id = d.destination_id and dest.type = 'webhook'
  left join webhook_destination_settings ws on ws.destination_id = dest.id
  where u.msg_id is not null;

  perform pgmq.set_vt('deliveries_queue', q.msg_id, 0)
  from pgmq.q_deliveries_queue q
  join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
  join destinations dest on dest.id = d.destination_id
  where dest.id in (select d2.destination_id from deliveries d2 where d2.id = any (p_delivery_ids))
    and dest.auto_disabled_at is not null
    and not dest.enabled
    and d.status in ('pending', 'failed');
end;
$$;

-- As in 20261018000300, plus step 6b: the claimed rows are stamped with their
-- destination's url_generation.
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
  -- loss, so dropped_at stays null, unless repeated failures turned the
  -- destination off (auto_disabled_at): then the spots are lost.
  with unwanted as (
    select d.id, dest.auto_disabled_at is not null as lost
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
    set status = 'dropped', dropped_at = case when unwanted.lost then v_now end
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

  -- 0b. Expire: a push destination's own TTL when it has one, else the type's;
  -- and a webhook row whose retry policy's attempts are used up.
  with old as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (d.created_at < v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
           or public.webhook_retries_exhausted(ws.retry_policy, d.attempts))
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

  -- 1 to 5. Ready, hold, budget, rank, choose, claim. Ready leaves out what
  -- 0b would expire, with the same predicates, for rows past its 500.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, dest.type, r.spot_time, d.created_at,
           coalesce(ds.batch_seconds, ws.batch_seconds, 0) as batch_seconds
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join discord_destination_settings ds on ds.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where q.vt <= v_now
      and d.created_at >= v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and not public.webhook_retries_exhausted(ws.retry_policy, d.attempts)
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
  ),
  -- A Discord or webhook destination with a window waits until its oldest
  -- ready row is that old or destination_batch_full(type) are ready.
  held as (
    select ready.destination_id
    from ready
    where ready.batch_seconds > 0
    group by ready.destination_id, ready.type, ready.batch_seconds
    having min(ready.created_at) > v_now - make_interval(secs => ready.batch_seconds)
       and count(*) < public.destination_batch_full(ready.type)
  ),
  budget as (
    select dest.id as destination_id,
           least(b.burst,
                 dest.claim_tokens
                 + b.rate_per_minute * greatest(0, extract(epoch from v_now - dest.claim_tokens_at)) / 60) as available,
           case when dest.type = 'webhook' then public.webhook_claim_max(coalesce(ws.batch_seconds, 0))
                else public.destination_claim_max(dest.type) end as claim_max
    from destinations dest
    cross join lateral public.destination_budget(dest.type) b
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where dest.id in (select distinct ready.destination_id from ready)
      and dest.id not in (select held.destination_id from held)
      and dest.claim_due_at <= v_now + public.destination_claim_interval(dest.type) / 2
  ),
  ranked as (
    select ready.msg_id, ready.delivery_id, ready.destination_id, ready.spot_time, budget.available, budget.claim_max,
           row_number() over (partition by ready.destination_id
                              order by ready.spot_time desc, ready.delivery_id desc) as rn
    from ready
    join budget on budget.destination_id = ready.destination_id
  ),
  chosen as (
    select ranked.msg_id, ranked.delivery_id, ranked.destination_id, ranked.spot_time, ranked.available, ranked.rn
    from ranked
    where ranked.rn <= floor(ranked.available)
      and (ranked.claim_max is null or ranked.rn <= ranked.claim_max)
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
  set claim_tokens = c.available - c.n, claim_tokens_at = v_now,
      claim_due_at = greatest(dest.claim_due_at, v_now) + public.destination_claim_interval(dest.type)
  from (
    select (x ->> 'destination_id')::uuid as destination_id,
           max((x ->> 'available')::numeric) as available,
           count(*) as n
    from jsonb_array_elements(v_claimed) x
    group by 1
  ) c
  where dest.id = c.destination_id;

  -- 6b. Stamp the URL generation the rows go out at. The debit holds each
  -- destination's row lock until this claim commits, so update_destination
  -- cannot change the URL between this stamp and the return below.
  update deliveries d
  set url_generation = dest.url_generation
  from destinations dest
  where d.id in (select (x ->> 'delivery_id')::bigint from jsonb_array_elements(v_claimed) x)
    and dest.id = d.destination_id;

  -- 7. Return, in the order chosen: every destination's newest spot first.
  -- A push destination's members, settings and quiet flag, a Discord
  -- destination's settings, and a webhook destination's window and headers,
  -- are built once per destination; their spots carry what is rendered from
  -- their fields. A destination somehow without a settings row (the triggers
  -- make one for every insert) is handed the defaults rather than left
  -- undeliverable.
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
    ),
    discord_dests as (
      select dest.id as d_id, ds.s as d_settings,
             jsonb_build_object('discord', to_jsonb(ds.s) - 'destination_id') as d_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from discord_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::discord_destination_settings,
                                public.discord_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ds
      where dest.type = 'discord'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    ),
    webhook_dests as (
      select dest.id as w_id, ws.s as w_settings,
             jsonb_build_object('webhook', jsonb_build_object(
               'batch_seconds', (ws.s).batch_seconds,
               'headers', public.webhook_header_values(dest.id))) as w_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from webhook_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::webhook_destination_settings,
                                public.webhook_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ws
      where dest.type = 'webhook'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, dd.d_extra, wd.w_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is not null then public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r))
                when dd.d_id is not null then public.discord_spot_fields(dd.d_settings, public.delivery_spot_json(r))
                when wd.w_id is not null then jsonb_build_object(
                  'webhook_fields', public.webhook_spot_fields(wd.w_settings, public.delivery_spot_json(r)),
                  'webhook_connection', s.name)
                else '{}'::jsonb end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    left join discord_dests dd on dd.d_id = dest.id
    left join webhook_dests wd on wd.w_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;
