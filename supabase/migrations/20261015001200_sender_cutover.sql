-- Cutover to the outbound sender (docs/superpowers/specs/2026-10-15-outbound-sender-design.md,
-- section 6, session 5). The sender process on Fly (sender/) polls claim_deliveries every few
-- seconds as the delivery_sender role, so the Edge `deliver` function no longer needs its cron
-- job or the matcher's pg_net kick. Both ran the same claim during the overlap; from here only
-- the sender claims. The function itself stays deployed until the cleanup migration (session 6)
-- so a rollback is a new migration that re-schedules the job and restores the kick, with the
-- bodies copied from 20261006000009_delivery_cron.sql and
-- 20261015000500_subscription_needs_destination.sql (applied migrations are never edited).

-- 1. The `deliver` cron job (20261006000009). cron.unschedule(name) raises when the job is
--    missing, so look it up: a database that never had the job (a fresh branch that is somehow
--    ahead of 20261006000009) is left alone.
select cron.unschedule(jobid) from cron.job where jobname = 'deliver';

-- 2. match_pending_spots: the body of 20261015000500 minus the net.http_post block, plus a
--    pg_notify('deliveries', '') when deliveries were created. Nothing listens yet (the sender
--    polls; LISTEN is Phase 2 F) and a notify with no listener costs nothing. The function no
--    longer reads Vault or touches `net`.

create or replace function public.match_pending_spots(batch_size int default 500)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_ids      bigint[];
  v_spot_ids     bigint[];
  v_delivery_ids bigint[];
begin
  select array_agg(m.msg_id), array_agg((m.message ->> 'spot_id')::bigint)
    into v_msg_ids, v_spot_ids
  from pgmq.read('spot_events', 60, batch_size) m;

  if v_msg_ids is null then
    return 0;
  end if;

  with candidates as (
    select s.id as subscription_id, s.quiet_minutes, r.id as spot_id, r.callsign, r.spot_time
    from raw_spots r
    join subscriptions s on s.enabled and public.spot_matches(s, r)
      and exists (select 1 from subscription_destinations sd where sd.subscription_id = s.id)
    where r.id = any (v_spot_ids)
  ),
  -- With a quiet window, only the earliest spot per callsign in this batch is eligible.
  eligible as (
    (
      select distinct on (c.subscription_id, c.callsign) c.*
      from candidates c
      where c.quiet_minutes > 0
      order by c.subscription_id, c.callsign, c.spot_time, c.spot_id
    )
    union all
    select c.* from candidates c where c.quiet_minutes = 0
  ),
  allowed as (
    select e.*
    from eligible e
    left join subscription_quiet q
      on q.subscription_id = e.subscription_id and q.callsign = e.callsign
    where e.quiet_minutes = 0
       or q.last_sent_at is null
       or q.last_sent_at <= now() - make_interval(mins => e.quiet_minutes)
  ),
  stamp_quiet as (
    insert into subscription_quiet (subscription_id, callsign, last_sent_at)
    select distinct a.subscription_id, a.callsign, now()
    from allowed a
    where a.quiet_minutes > 0
    on conflict (subscription_id, callsign) do update set last_sent_at = excluded.last_sent_at
  ),
  ins as (
    insert into deliveries (subscription_id, destination_id, spot_id)
    select distinct on (sd.destination_id, a.spot_id) a.subscription_id, sd.destination_id, a.spot_id
    from allowed a
    join subscription_destinations sd on sd.subscription_id = a.subscription_id
    order by sd.destination_id, a.spot_id, a.subscription_id
    on conflict (destination_id, spot_id) do nothing
    returning id
  )
  select array_agg(ins.id) into v_delivery_ids from ins;

  if v_delivery_ids is not null then
    perform pgmq.send_batch(
      'deliveries_queue',
      (select array_agg(jsonb_build_object('delivery_id', d)) from unnest(v_delivery_ids) as d)
    );
  end if;

  perform pgmq.archive('spot_events', v_msg_ids);

  -- Tell a listening sender there is work (delivered on commit). The sender polls today and
  -- will LISTEN on this channel later; until then the notify has no subscriber.
  if v_delivery_ids is not null then
    perform pg_notify('deliveries', '');
  end if;

  return coalesce(cardinality(v_delivery_ids), 0);
end;
$$;
