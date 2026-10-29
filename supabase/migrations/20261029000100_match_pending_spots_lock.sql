-- Serialise match_pending_spots runs (review 4, database: connections, finding 1).
--
-- The quiet window was enforced only inside one run: two runs at once (the minute's cron, every
-- ingest after it stores, the inbound worker's pushes every 10 s) read disjoint messages under
-- pgmq.read's SKIP LOCKED, neither saw the other's uncommitted subscription_quiet stamp, and both
-- delivered the same callsign inside a connection's quiet window.
--
-- match_pending_spots: as in 20261028000500, taking a transaction-level advisory lock as its first
-- statement. The function is plpgsql, so under READ COMMITTED every later statement (pgmq.read,
-- the candidates/allowed statement) takes its snapshot after the lock is granted, and the lock is
-- released only when the previous run's transaction commits: each run sees the stamps of the run
-- before it. A run takes well under a second, so a caller waits at most about that long.
-- Signature, result and grants unchanged.
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
  -- One run at a time (see the header). Keyed by a fixed name; pgTAP looks for this key.
  perform pg_advisory_xact_lock(hashtextextended('match_pending_spots', 0));

  select array_agg(m.msg_id), array_agg((m.message ->> 'spot_id')::bigint)
    into v_msg_ids, v_spot_ids
  from pgmq.read('spot_events', 60, batch_size) m;

  if v_msg_ids is null then
    return 0;
  end if;

  with candidates as (
    select s.id as subscription_id, s.quiet_minutes, r.id as spot_id, r.callsign, r.spot_time,
           r.source, r.frequency_khz
    from raw_spots r
    join subscriptions s on s.enabled and public.spot_matches(s, r)
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id
                    and not (dd.type = 'local_cluster'
                             and (r.frequency_khz <= 0
                                  or (r.source = 'logged'
                                      and exists (select 1 from logged_contacts lc
                                                  where lc.spot_id = r.id and lc.user_id = dd.user_id)))))
    where r.id = any (v_spot_ids)
      and r.retracted_at is null
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
    join destinations dd on dd.id = sd.destination_id and dd.enabled
    where not (dd.type = 'local_cluster'
               and (a.frequency_khz <= 0
                    or (a.source = 'logged'
                        and exists (select 1 from logged_contacts lc
                                    where lc.spot_id = a.spot_id and lc.user_id = dd.user_id))))
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

