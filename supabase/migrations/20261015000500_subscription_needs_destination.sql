-- A subscription with no destinations stays off. It can be saved (20261014000300) and keeps
-- its enabled switch, but it is live only while enabled and linked to at least one destination,
-- so it starts by itself once one is added. Until then the matcher skips it, which also keeps
-- its quiet window from running ahead of its first delivery, and watched_among leaves its calls
-- out, so RBN lines for them stay in rbn_spots instead of reaching the matcher. Both bodies are
-- otherwise unchanged from 20261006000008 and 20261014000500.

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
  v_url          text;
  v_key          text;
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

  -- Kick the delivery worker so matches go out within seconds. Skipped when
  -- the Vault secrets are absent (local development, tests); cron covers it.
  if v_delivery_ids is not null then
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'longlines_supabase_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'longlines_service_role_key';
    if v_url is not null and v_key is not null then
      perform net.http_post(
        url := v_url || '/functions/v1/deliver',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    end if;
  end if;

  return coalesce(cardinality(v_delivery_ids), 0);
end;
$$;

create or replace function public.watched_among(p_source text, p_callsigns text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with batch as (
    select distinct c, public.base_callsign(c) as b from unnest(p_callsigns) as c
  ),
  watch as materialized (
    select distinct r ->> 'field' as field, v.value
    from subscriptions s
    cross join lateral jsonb_array_elements(s.rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where s.enabled
      and exists (select 1 from subscription_destinations sd where sd.subscription_id = s.id)
      and public.source_matches(s.sources, p_source)
      and r ->> 'op' = 'is'
      and r ->> 'field' in ('callsign', 'group')
  ),
  members as materialized (
    select m.callsign, m.group_id
    from callsign_group_members m
    where m.callsign in (select x.b from batch x)
  )
  select x.c
  from batch x
  where x.c in (select w.value from watch w where w.field = 'callsign')
     or x.b in (select w.value from watch w where w.field = 'callsign')
     or x.b in (
          select mm.callsign from members mm
          where mm.group_id::text in (select w.value from watch w where w.field = 'group'))
  order by x.c;
$$;
