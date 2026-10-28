-- Logged contacts as a source (Long Lines Relay, phase 1).
-- Spec: docs/superpowers/specs/2026-10-28-logged-contacts-design.md. The wire contract is
-- docs/contract.md in sonyccd/longlines-relay.
--
-- Long Lines Relay catches the contact broadcasts a logging program sends (N1MM Logger+ format)
-- and posts each logged contact; the relay-api function (a later migration) normalizes the batch
-- and calls apply_logged_contacts, which stores each contact as a raw_spots row with source
-- 'logged': spotter = the station call as logged, callsign = the worked call as logged.
--
-- raw_spots stays append-only. A contact edited in the logger retracts its old spot and stores a
-- new one; a contact deleted in the logger retracts its spot. A retraction is a marker
-- (raw_spots.retracted_at), set and cleared only by apply_logged_contacts and never a delete; every
-- reader below leaves a retracted row out. Only logged spots are ever retracted, so for every other
-- source each reader is unchanged.
--
-- Logged contacts are opt-in for matching, like DX Cluster, WWFF and WWBOTA: an "any source"
-- connection does not get them. They have no ingest cron job and no Health page entry (they
-- arrive when someone logs); profiles count them through spot_stream, the Stats snapshot gains
-- only daily[].logged and hourly[].logged, and the archive writes them hourly with retracted_at.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

alter table raw_spots add column retracted_at timestamptz;

comment on column raw_spots.retracted_at is
  'When a logged contact''s spot was retracted (edited or deleted in the logger); null otherwise and for every other source. Set and cleared only by apply_logged_contacts; the row is never deleted.';

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'wwff', 'wwbota', 'logged'));

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff', 'wwbota', 'logged'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('logged') on conflict do nothing;

alter table archive_log drop constraint archive_log_source_check;
alter table archive_log add constraint archive_log_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff', 'wwbota', 'logged'));

-- One row per contact an account has posted, keyed by the logger's id for it (external_id, per
-- account). spot_id is the contact's current spot: the live one, or the last one retracted.
-- content_hash is that spot's, for telling an unchanged resend from an edit.
create table logged_contacts (
  user_id       uuid        not null references auth.users (id) on delete cascade,
  external_id   text        not null check (char_length(external_id) between 1 and 256),
  spot_id       bigint      not null references raw_spots (id),
  content_hash  text        not null,
  state         text        not null check (state in ('live', 'retracted')),
  logger_app    text        check (char_length(logger_app) <= 64),
  relay_version text        check (char_length(relay_version) <= 32),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  retracted_at  timestamptz,
  primary key (user_id, external_id),
  check ((state = 'retracted') = (retracted_at is not null))
);

create index logged_contacts_spot_id_idx on logged_contacts (spot_id);

comment on table logged_contacts is
  'Contacts posted by Long Lines Relay, one per (account, logger contact id). Written only by apply_logged_contacts; service role only.';

alter table logged_contacts enable row level security;
revoke all on logged_contacts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Applying a batch
-- ---------------------------------------------------------------------------

-- Applies one request's contacts in order, in the caller's transaction, and returns one result
-- per item, in input order: [{external_id, status}] with status created, updated, unchanged,
-- retracted or unknown, or rejected with reason mycall_mismatch. The relay-api function has
-- already checked each item's shape, clock skew and age (_shared/logged.ts) and sends only the
-- items that passed; it merges its own rejections back in by position.
--
-- An item is {op, external_id, logger_app, relay_version, spot}: spot is the NormalizedSpot for an
-- upsert (source 'logged', source_spot_id '<user_id>|<external_id>') and null for a delete.
--
-- upsert, no contact             store the spot                                   created
-- upsert, live, same hash        nothing                                          unchanged
-- upsert, live, other hash       retract the old spot, store the new one          updated
-- upsert, retracted              store the spot; the contact is live again        created
-- delete, live                   retract its spot                                 retracted
-- delete, none or retracted      nothing                                          unknown
--
-- An upsert whose spotter's base call is not the account callsign's (base_callsign()) is
-- rejected with mycall_mismatch and changes nothing; so is any upsert for an account without a
-- profile. Deletes are not checked: a contact can only be deleted by the account that posted it.
--
-- Batches for one account are serialized by a transaction-level advisory lock, so concurrent
-- requests for one contact apply one after the other.
--
-- "Store" goes through ingest_spots, which queues the spot for matching. raw_spots dedups on
-- (source, source_spot_id, content_hash), so content this contact had before (an edit undone, a
-- contact deleted and logged again) already has a retracted row: storing it clears that row's
-- retracted_at and queues it again instead of inserting a copy. The matcher never creates a
-- second delivery of one spot to a destination.
create function public.apply_logged_contacts(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_base    text;
  v_item    jsonb;
  v_op      text;
  v_ext     text;
  v_spot    jsonb;
  v_hash    text;
  v_row     logged_contacts%rowtype;
  v_found   boolean;
  v_spot_id bigint;
  v_status  text;
  v_stored  int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if p_user_id is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'apply_logged_contacts needs a user and a list of items.' using errcode = '22023';
  end if;

  -- One account's batches apply one at a time. The row lock below cannot cover a contact that has
  -- no row yet, so two requests storing different content for one new contact at once (a retry
  -- racing the request it retries) would each store a live spot and leave one never retracted.
  perform pg_advisory_xact_lock(hashtextextended('logged_contacts:' || p_user_id::text, 0));

  select public.base_callsign(p.callsign) into v_base from profiles p where p.id = p_user_id;

  for v_item in
    select e.value from jsonb_array_elements(p_items) with ordinality as e(value, n) order by e.n
  loop
    v_op := v_item ->> 'op';
    v_ext := v_item ->> 'external_id';
    if v_op is null or v_op not in ('upsert', 'delete')
       or v_ext is null or char_length(v_ext) not between 1 and 256 then
      raise exception 'Not a logged contact item.' using errcode = '22023';
    end if;

    select * into v_row
    from logged_contacts c
    where c.user_id = p_user_id and c.external_id = v_ext
    for update;
    v_found := found;

    if v_op = 'delete' then
      if v_found and v_row.state = 'live' then
        update raw_spots set retracted_at = now() where id = v_row.spot_id;
        update logged_contacts
        set state = 'retracted', retracted_at = now(), updated_at = now()
        where user_id = p_user_id and external_id = v_ext;
        v_status := 'retracted';
      else
        v_status := 'unknown';
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
      continue;
    end if;

    v_spot := v_item -> 'spot';
    v_hash := v_spot ->> 'content_hash';
    if jsonb_typeof(v_spot) is distinct from 'object'
       or v_spot ->> 'source' is distinct from 'logged'
       or v_spot ->> 'source_spot_id' is distinct from p_user_id::text || '|' || v_ext
       or coalesce(v_hash, '') = '' then
      raise exception 'Not a logged contact spot.' using errcode = '22023';
    end if;

    if v_base is null or public.base_callsign(v_spot ->> 'spotter') is distinct from v_base then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'external_id', v_ext, 'status', 'rejected', 'reason', 'mycall_mismatch'));
      continue;
    end if;

    if v_found and v_row.state = 'live' and v_row.content_hash = v_hash then
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', 'unchanged'));
      continue;
    end if;

    if v_found and v_row.state = 'live' then
      update raw_spots set retracted_at = now() where id = v_row.spot_id;
      v_status := 'updated';
    else
      v_status := 'created';
    end if;

    v_spot_id := null;
    select i.id into v_spot_id from public.ingest_spots(jsonb_build_array(v_spot)) as i;
    if v_spot_id is null then
      update raw_spots r
      set retracted_at = null
      where r.source = 'logged' and r.source_spot_id = v_spot ->> 'source_spot_id' and r.content_hash = v_hash
      returning r.id into v_spot_id;
      if v_spot_id is null then
        raise exception 'Logged contact spot neither stored nor found.';
      end if;
      perform pgmq.send('spot_events', jsonb_build_object('spot_id', v_spot_id, 'source', 'logged'));
    end if;
    v_stored := v_stored + 1;

    insert into logged_contacts (user_id, external_id, spot_id, content_hash, state, logger_app, relay_version)
    values (p_user_id, v_ext, v_spot_id, v_hash, 'live', v_item ->> 'logger_app', v_item ->> 'relay_version')
    on conflict (user_id, external_id) do update
      set spot_id = excluded.spot_id, content_hash = excluded.content_hash, state = 'live',
          logger_app = excluded.logger_app, relay_version = excluded.relay_version,
          updated_at = now(), retracted_at = null;

    v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
  end loop;

  -- Every applied request counts as a run; the count is the spots stored. The catalog reads
  -- last_success_at as "last contact".
  perform public.record_ingest_success('logged', v_stored);
  return v_results;
end;
$$;

revoke all on function public.apply_logged_contacts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_logged_contacts(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Matching
-- ---------------------------------------------------------------------------

-- source_matches: as in 20261026001000, with logged opt-in: logged contacts are one operator's
-- own log, so an "any source" connection does not get them.
create or replace function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select case when cardinality(p_sources) = 0 then p_source not in ('dxcluster', 'wwff', 'wwbota', 'logged')
              else p_source = any (p_sources) end;
$$;

-- normalize_subscription_sources: as in 20261026001000, accepting logged.
create or replace function public.normalize_subscription_sources(p_sources jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out     text[];
  v_unknown text;
begin
  if p_sources is null or jsonb_typeof(p_sources) = 'null' then
    return '{}'::text[];
  end if;
  if jsonb_typeof(p_sources) <> 'array' then
    raise exception 'sources must be a list.';
  end if;
  v_out := public.jsonb_text_array(p_sources, 'lower');
  -- raw_spots_source_check without aprs, which never reaches matching.
  select s into v_unknown
  from unnest(v_out) as s
  where s not in ('pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster', 'logged')
  order by s
  limit 1;
  if v_unknown is not null then
    raise exception 'Unknown source: %.', v_unknown;
  end if;
  return v_out;
end;
$$;

-- match_pending_spots: as in 20261016000400, skipping a retracted spot. A contact deleted before
-- the minute's run creates no deliveries; deliveries already created are left alone (a sent spot
-- cannot be unsent).
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
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id)
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

-- preview_subscription: as in 20261027001000, leaving out retracted spots like the matcher. Same
-- return type, so the grants carry over.
create or replace function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb, station_count bigint, window_size bigint)
language sql
stable
security definer
set search_path = public
as $$
  with sub as (
    select jsonb_populate_record(null::subscriptions, jsonb_build_object(
      'id', gen_random_uuid(), 'user_id', auth.uid(), 'name', '', 'enabled', true,
      'sources', to_jsonb(public.normalize_subscription_sources(filter -> 'sources')),
      'rules', public.normalize_subscription_rules(filter -> 'rules', auth.uid(), false),
      'quiet_minutes', 0, 'created_at', now(), 'updated_at', now(), 'group_ids', '[]'::jsonb
    )) as s
  ),
  positive as (
    select r ->> 'field' as field, v.value
    from sub
    cross join lateral jsonb_array_elements((sub.s).rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where r ->> 'op' = 'is' and r ->> 'field' in ('callsign', 'group')
  ),
  stations as (
    select count(distinct t.b) as n
    from (
      select public.base_callsign(p.value) as b from positive p where p.field = 'callsign'
      union all
      select m.callsign
      from positive p
      join callsign_group_members m on m.group_id::text = p.value
      where p.field = 'group'
    ) t
  ),
  recent as (
    select r.* from raw_spots r, sub
    where r.spot_time > now() - interval '24 hours'
      and r.retracted_at is null
      and public.source_matches((sub.s).sources, r.source)
    order by r.spot_time desc
    limit 200
  ),
  matched as (
    select r.* from recent r, sub where public.spot_matches(sub.s, r)
  )
  select
    (select count(*) from matched),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'spot_time', m.spot_time, 'callsign', m.callsign, 'spotter', m.spotter,
        'frequency_khz', m.frequency_khz, 'band', m.band, 'mode', m.mode, 'mode_family', m.mode_family,
        'comment', m.comment,
        'pota_reference', m.pota_reference, 'pota_park_name', m.pota_park_name,
        'pota_location', m.pota_location, 'sota_summit_ref', m.sota_summit_ref,
        'wwff_reference', m.wwff_reference, 'wwff_reference_name', m.wwff_reference_name,
        'wwbota_references', m.wwbota_references, 'wwbota_reference_name', m.wwbota_reference_name,
        'iota_reference', m.iota_reference, 'iota_reference_name', m.iota_reference_name,
        'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent)
  where auth.uid() is not null;
$$;

-- home_flow: as in 20261027001400, with logged among the sources a connection can take.
create or replace function public.home_flow()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select d.subscription_id, d.destination_id, d.spot_id, d.created_at, d.sent_at
    from destinations dd
    join deliveries d on d.destination_id = dd.id
    where dd.user_id = auth.uid()
      and (d.created_at > now() - interval '24 hours' or d.sent_at > now() - interval '24 hours')
  ),
  matched as (
    select m.subscription_id, r.source, m.spot_id
    from mine m
    join raw_spots r on r.id = m.spot_id
    where m.created_at > now() - interval '24 hours'
  ),
  sent as (
    select m.subscription_id, m.destination_id from mine m where m.sent_at > now() - interval '24 hours'
  )
  select jsonb_build_object(
    'matched', (select count(distinct spot_id) from matched),
    'delivered', (select count(*) from sent),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', s.source, 'matched', s.n) order by s.source)
      from (select source, count(distinct spot_id) as n from matched group by source) s
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.subscription_id, 'source', s.source, 'matched', s.n)
                       order by s.subscription_id, s.source)
      from (select subscription_id, source, count(distinct spot_id) as n from matched group by subscription_id, source) s
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.subscription_id, 'destination_id', s.destination_id, 'delivered', s.n)
                       order by s.subscription_id, s.destination_id)
      from (select subscription_id, destination_id, count(*) as n from sent group by subscription_id, destination_id) s
    ), '[]'::jsonb),
    'subscription_sources', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.id, 'source', src.source) order by s.id, src.source)
      from subscriptions s
      cross join unnest(array['pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster', 'logged']) as src(source)
      where s.user_id = auth.uid()
        and public.source_matches(s.sources, src.source)
        and (src.source <> 'rbn' or exists (
              select 1 from jsonb_array_elements(s.rules) as g
              where public.rules_name_stations(jsonb_build_array(g))))
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

revoke all on function public.home_flow() from public;
grant execute on function public.home_flow() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Delivery
-- ---------------------------------------------------------------------------

-- push_source_label: as in 20261026001000, with logged contacts.
create or replace function public.push_source_label(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 'POTA'
    when 'sotawatch' then 'SOTAwatch'
    when 'rbn' then 'RBN'
    when 'dxcluster' then 'DX Cluster'
    when 'wwff' then 'WWFF'
    when 'wwbota' then 'WWBOTA'
    when 'logged' then 'Logged contacts'
    else p_source
  end;
$$;

-- discord_source_color: as in 20261026001000, with logged contacts magenta (discord.py's magenta).
create or replace function public.discord_source_color(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 3066993
    when 'sotawatch' then 10181046
    when 'wwff' then 1752220
    when 'wwbota' then 15844367
    when 'logged' then 15277667
    when 'dxcluster' then 3447003
    when 'rbn' then 15105570
    else 9807270
  end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Read models
-- ---------------------------------------------------------------------------

-- recent_spots: as in 20261027001000, without retracted spots. Same columns, so
-- list_recent_spots (which returns its row type) and the grants carry over.
create or replace view recent_spots with (security_invoker = true) as
select
  id, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment,
  pota_reference, pota_park_name, pota_location, sota_summit_ref,
  wwff_reference, wwff_reference_name, wwbota_references, wwbota_reference_name,
  iota_reference, iota_reference_name, source
from raw_spots
where spot_time > now() - interval '24 hours'
  and retracted_at is null;

revoke all on recent_spots from anon, authenticated;

-- callsign_group_rows: as in 20261027001000, with a retracted spot never on the air.
create or replace function public.callsign_group_rows(p_id uuid)
returns table (id uuid, name text, callsigns text[], member_count bigint, subscription_count bigint,
               updated_at timestamptz, on_air jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  return query
  select
    g.id,
    g.name,
    m.calls,
    cardinality(m.calls)::bigint,
    (select count(*) from subscriptions s where s.user_id = v_user and g.id = any (s.group_ids)),
    g.updated_at,
    jsonb_build_object('count', a.n, 'latest', a.latest)
  from callsign_groups g
  cross join lateral (
    select coalesce(array_agg(cm.callsign order by cm.callsign), '{}') as calls
    from callsign_group_members cm
    where cm.group_id = g.id
  ) m
  cross join lateral (
    select count(distinct r.base_callsign) as n,
           (array_agg(jsonb_build_object(
              'callsign', r.callsign, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                                                 r.iota_reference),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
                    and r.retracted_at is null
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user and (p_id is null or g.id = p_id)
  order by lower(g.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Archive
-- ---------------------------------------------------------------------------

-- archive_slice_minutes: as in 20261026001000, with logged contacts hourly.
create or replace function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
           when 'rbn' then 10
           when 'pota' then 60
           when 'sotawatch' then 60
           when 'dxcluster' then 60
           when 'wwff' then 60
           when 'wwbota' then 60
           when 'logged' then 60
           when 'aprs' then 5
         end;
$$;

-- As in 20261026001000, with logged.
create or replace view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn'), ('dxcluster'), ('aprs'), ('wwff'), ('wwbota'), ('logged')) as s(source);

-- archive_columns: as in 20261027001000, with a logged branch: the raw_spots layout plus
-- retracted_at (epoch milliseconds or null). ARCHIVE_SCHEMAS.logged in _shared/archive.ts matches it.
create or replace function public.archive_columns(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, columns json)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'snr', json_agg(r.snr order by r.o),
               'speed', json_agg(r.speed order by r.o),
               'speed_unit', json_agg(r.speed_unit order by r.o),
               'spot_type', json_agg(r.spot_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.spotter, x.callsign, x.frequency_khz) as o
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source = 'aprs' then
    -- Every column but line_md5, which only orders packets received in the same instant.
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'source_call', json_agg(r.source_call order by r.o),
               'destination', json_agg(r.destination order by r.o),
               'path', json_agg(r.path order by r.o),
               'q_construct', json_agg(r.q_construct order by r.o),
               'igate', json_agg(r.igate order by r.o),
               'packet_type', json_agg(r.packet_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*, row_number() over (order by x.received_at, x.line_md5) as o
        from aprs_packets x
        where x.received_at >= p_from and x.received_at < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch', 'dxcluster', 'wwff', 'wwbota') then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'source', json_agg(r.source order by r.o),
               'source_spot_id', json_agg(r.source_spot_id order by r.o),
               'content_hash', json_agg(r.content_hash order by r.o),
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'ingested_at', json_agg((extract(epoch from r.ingested_at) * 1000)::bigint order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'comment', json_agg(r.comment order by r.o),
               'pota_reference', json_agg(r.pota_reference order by r.o),
               'pota_park_name', json_agg(r.pota_park_name order by r.o),
               'pota_location', json_agg(r.pota_location order by r.o),
               'sota_summit_ref', json_agg(r.sota_summit_ref order by r.o),
               'wwff_reference', json_agg(r.wwff_reference order by r.o),
               'wwff_reference_name', json_agg(r.wwff_reference_name order by r.o),
               'wwbota_references', json_agg(array_to_string(r.wwbota_references, ',') order by r.o),
               'wwbota_reference_name', json_agg(r.wwbota_reference_name order by r.o),
               'iota_reference', json_agg(r.iota_reference order by r.o),
               'iota_reference_name', json_agg(r.iota_reference_name order by r.o),
               'raw_payload', json_agg(r.raw_payload::text order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.source_spot_id, x.content_hash) as o
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source = 'logged' then
    -- The raw_spots layout plus retracted_at: a retraction after the slice is
    -- archived is not in the file (raw_spots keeps it).
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'source', json_agg(r.source order by r.o),
               'source_spot_id', json_agg(r.source_spot_id order by r.o),
               'content_hash', json_agg(r.content_hash order by r.o),
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'ingested_at', json_agg((extract(epoch from r.ingested_at) * 1000)::bigint order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'comment', json_agg(r.comment order by r.o),
               'pota_reference', json_agg(r.pota_reference order by r.o),
               'pota_park_name', json_agg(r.pota_park_name order by r.o),
               'pota_location', json_agg(r.pota_location order by r.o),
               'sota_summit_ref', json_agg(r.sota_summit_ref order by r.o),
               'wwff_reference', json_agg(r.wwff_reference order by r.o),
               'wwff_reference_name', json_agg(r.wwff_reference_name order by r.o),
               'wwbota_references', json_agg(array_to_string(r.wwbota_references, ',') order by r.o),
               'wwbota_reference_name', json_agg(r.wwbota_reference_name order by r.o),
               'iota_reference', json_agg(r.iota_reference order by r.o),
               'iota_reference_name', json_agg(r.iota_reference_name order by r.o),
               'raw_payload', json_agg(r.raw_payload::text order by r.o),
               'retracted_at', json_agg((extract(epoch from r.retracted_at) * 1000)::bigint order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.source_spot_id, x.content_hash) as o
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Profiles
-- ---------------------------------------------------------------------------

-- spot_stream: as in 20261027001200, without retracted spots. Logged contacts need no arm of
-- their own: they are raw_spots rows, so profiles, the rollups and group statistics count them
-- as source logged (the operator under spotter, the worked call under heard). A day already rolled
-- up keeps a contact retracted after it.
create or replace view spot_stream with (security_invoker = true) as
select r.source,
       r.spot_time,
       r.callsign,
       r.base_callsign,
       r.spotter,
       public.base_callsign(r.spotter)          as spotter_base,
       r.frequency_khz,
       r.band,
       r.mode,
       public.mode_bucket(r.mode, r.mode_family) as mode_bucket,
       null::smallint                            as snr,
       case when r.pota_reference is not null then 'POTA'
            when r.sota_summit_ref is not null then 'SOTA'
            when r.wwff_reference is not null then 'WWFF'
            when r.wwbota_references[1] is not null then 'WWBOTA'
            when r.iota_reference is not null then 'IOTA' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                r.iota_reference) as reference,
       case when r.pota_reference is not null then r.pota_park_name
            when r.sota_summit_ref is not null then null
            when r.wwff_reference is not null then r.wwff_reference_name
            when r.wwbota_references[1] is not null then r.wwbota_reference_name
            else r.iota_reference_name end as reference_name,
       case when r.pota_reference is not null then r.pota_location end  as reference_location,
       r.comment
from raw_spots r
where r.source <> 'rbn'
  and r.retracted_at is null
union all
select 'rbn',
       s.spot_time,
       s.callsign,
       public.base_callsign(s.callsign),
       s.spotter,
       public.base_callsign(s.spotter),
       s.frequency_khz,
       s.band,
       s.mode,
       public.mode_bucket(s.mode, s.mode_family),
       s.snr,
       null, null, null, null,
       null
from rbn_spots s;

revoke all on spot_stream from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Stats: daily and hourly counts only
-- ---------------------------------------------------------------------------

-- build_stats_snapshot_at: as in 20261027001000, with daily[].logged and hourly[].logged (live
-- logged contacts), for the catalog's rates, from their own CTEs like wwbota. Logged contacts
-- stay out of in_window, so every other figure is unchanged. Same signature, so the grants carry
-- over.
create or replace function public.build_stats_snapshot_at(p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_end   timestamptz := date_trunc('day', p_now at time zone 'utc') at time zone 'utc';
  v_window_start timestamptz := (date_trunc('day', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_first_day    date        := (p_now at time zone 'utc')::date - 7;
  v_end_day      date        := (p_now at time zone 'utc')::date;
  v_hour_end     timestamptz := date_trunc('hour', p_now at time zone 'utc') at time zone 'utc';
  v_hour_start   timestamptz := (date_trunc('hour', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_from         timestamptz;
begin
  -- RBN hours of today for the hourly series: every complete hour without a
  -- count, and any hour counted within an hour of its end, recounted from the
  -- oldest such hour up to now in one range scan (see the header). Hours of
  -- earlier days belong to the day rollups.
  select min(h) into v_from
  from generate_series(v_window_end, v_hour_end - interval '1 hour', interval '1 hour') as h
  left join rbn_rollup_hours l on l.hour = h
  where l.hour is null or l.rolled_at < h + interval '2 hours';
  if v_from is not null then
    perform public.rollup_rbn_hours(v_from, v_hour_end);
  end if;
  delete from rbn_rollup_hours where hour < v_window_end;

  insert into stats_snapshots (window_start, window_end, payload)
  with
  -- Every in-window row.
  in_window as (
    select r.*
    from raw_spots r
    where r.spot_time >= v_window_start
      and r.spot_time <  v_window_end
      -- The page describes POTA, SOTA and WWFF activity. Any other source (RBN
      -- skimmer reports of watched callsigns, DX Cluster) is not an activation
      -- and stays out.
      and r.source in ('pota', 'sotawatch', 'wwff')
  ),
  -- base_callsign() once per distinct spotter, not per row (see the header).
  spotter_bases as materialized (
    select d.spotter, public.base_callsign(d.spotter) as base
    from (select distinct spotter from in_window where spotter is not null) as d
  ),
  -- Every in-window row with its UTC day and hour.
  spots as (
    select r.id, r.source, r.spot_time, r.callsign, r.spotter, r.band, r.mode, r.mode_family,
           r.pota_reference, r.pota_park_name, r.pota_location, r.sota_summit_ref,
           r.wwff_reference, r.wwff_reference_name,
           to_char(r.spot_time at time zone 'utc', 'YYYY-MM-DD') as day,
           extract(hour from r.spot_time at time zone 'utc')::int as hour,
           -- A chaser spot has a spotter who is not the activator: is_self_spot's
           -- rule, on base calls already resolved.
           (r.spotter is not null and not coalesce(sb.base = r.base_callsign, false)) as chased
    from in_window r
    left join spotter_bases sb on sb.spotter = r.spotter
  ),
  totals as (
    select count(*)                                                         as spots,
           count(*) filter (where source = 'pota')                          as pota_spots,
           count(*) filter (where source = 'sotawatch')                     as sota_spots,
           count(*) filter (where source = 'wwff')                          as wwff_spots,
           count(distinct callsign)                                         as activators,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference)                               as references,
           -- Activations: distinct (callsign, reference, UTC day) per program.
           count(distinct (callsign, pota_reference, day)) filter (where pota_reference is not null)  as pota_activations,
           count(distinct (callsign, sota_summit_ref, day)) filter (where sota_summit_ref is not null) as sota_activations,
           count(distinct (callsign, wwff_reference, day)) filter (where wwff_reference is not null)   as wwff_activations,
           -- Chasers: distinct spotters on chased spots, overall and per source.
           count(distinct spotter) filter (where chased)                            as chasers,
           count(distinct spotter) filter (where chased and source = 'pota')        as pota_chasers,
           count(distinct spotter) filter (where chased and source = 'sotawatch')   as sota_chasers,
           count(distinct spotter) filter (where chased and source = 'wwff')        as wwff_chasers
    from spots
  ),
  -- Hour of day with the most spots summed over all seven days.
  peak_hour as (
    select hour from spots
    group by hour
    order by count(*) desc, hour asc
    limit 1
  ),
  -- The single busiest (day, hour) bucket.
  busiest_slot as (
    select day, hour from spots
    group by day, hour
    order by count(*) desc, day asc, hour asc
    limit 1
  ),
  -- daily: exactly seven days, oldest first, zero-filled. Day arithmetic is
  -- done on a date so a DST change in the session zone cannot skip a day.
  days as (
    select to_char((v_window_start at time zone 'utc')::date + i, 'YYYY-MM-DD') as day
    from generate_series(0, 6) as i
  ),
  daily_counts as (
    select day,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    group by day
  ),
  daily_rbn as (
    select to_char(hour at time zone 'utc', 'YYYY-MM-DD') as day, sum(spots) as rbn
    from rbn_hourly
    where hour >= v_window_start and hour < v_window_end
    group by 1
  ),
  daily_aprs as (
    select to_char(hour_start at time zone 'utc', 'YYYY-MM-DD') as day, sum(packets) as aprs
    from aprs_packet_hours
    where hour_start >= v_window_start and hour_start < v_window_end
    group by 1
  ),
  daily_dx as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as dx
    from raw_spots
    where source = 'dxcluster'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily_wwbota as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as wwbota
    from raw_spots
    where source = 'wwbota'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily_iota as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as iota
    from raw_spots
    where source = 'dxcluster' and iota_reference is not null
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  -- Logged contacts that are still live: a retracted one counts nowhere.
  daily_logged as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as logged
    from raw_spots
    where source = 'logged' and retracted_at is null
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0), 'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0), 'dx', coalesce(x.dx, 0),
                                'wwbota', coalesce(w.wwbota, 0), 'iota', coalesce(io.iota, 0),
                                'logged', coalesce(lg.logged, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
    left join daily_aprs a using (day)
    left join daily_dx x using (day)
    left join daily_wwbota w using (day)
    left join daily_iota io using (day)
    left join daily_logged lg using (day)
  ),
  -- hourly: exactly 168 hours, oldest first, zero-filled, ending at the last
  -- complete hour rather than at window_end (see the header). POTA,
  -- SOTAwatch and WWFF come from raw_spots over those hours, RBN from the rollups.
  slots as (
    select generate_series(v_hour_start, v_hour_end - interval '1 hour', interval '1 hour') as slot
  ),
  slot_counts as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) filter (where r.source = 'pota')      as pota,
           count(*) filter (where r.source = 'sotawatch') as sota,
           count(*) filter (where r.source = 'wwff')      as wwff
    from raw_spots r
    where r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
      and r.source in ('pota', 'sotawatch', 'wwff')
    group by 1
  ),
  slot_dx as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as dx
    from raw_spots r
    where r.source = 'dxcluster'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  slot_wwbota as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as wwbota
    from raw_spots r
    where r.source = 'wwbota'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  slot_iota as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as iota
    from raw_spots r
    where r.source = 'dxcluster' and r.iota_reference is not null
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  slot_logged as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as logged
    from raw_spots r
    where r.source = 'logged' and r.retracted_at is null
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  hourly as (
    select jsonb_agg(
             jsonb_build_object(
               'hour', to_char(s.slot at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
               'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'wwff', coalesce(c.wwff, 0),
               'rbn', coalesce(h.spots, 0),
               'aprs', coalesce(ah.packets, 0), 'dx', coalesce(sx.dx, 0),
               'wwbota', coalesce(sw.wwbota, 0), 'iota', coalesce(si.iota, 0),
               'logged', coalesce(sl.logged, 0)
             )
             order by s.slot
           ) as v
    from slots s
    left join slot_counts c using (slot)
    left join rbn_hourly h on h.hour = s.slot
    left join aprs_packet_hours ah on ah.hour_start = s.slot
    left join slot_dx sx on sx.slot = s.slot
    left join slot_wwbota sw on sw.slot = s.slot
    left join slot_iota si on si.slot = s.slot
    left join slot_logged sl on sl.slot = s.slot
  ),
  -- potaByState: 50 states + DC, zero-filled. pota_location is a raw
  -- comma-separated list ("US-NC,US-VA"); a park spanning two states counts
  -- once in each. Entries are trimmed because upstream sometimes pads after
  -- the comma. Non-US entries and US territories (US-PR, US-GU, ...) fall out
  -- of the join and are ignored.
  states as (
    select unnest(array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
      'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
      'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ]) as code
  ),
  state_counts as (
    select substr(trim(x), 4, 2) as code, count(*) as n
    from spots s, regexp_split_to_table(s.pota_location, ',') as x
    where trim(x) ~ '^US-[A-Z]{2}$'
    group by 1
  ),
  pota_by_state as (
    select jsonb_object_agg(st.code, coalesce(sc.n, 0)) as v
    from states st
    left join state_counts sc using (code)
  ),
  -- countries: every country with a spot in the window, from the day rollups,
  -- busiest first. A country is ISO 3166-1 alpha-2 through
  -- cty_entity_countries, so England and Scotland are both GB and Alaska is
  -- US; an entity with no country (Spratly Islands) is left out.
  country_counts as (
    select c.country as code,
           coalesce(sum(d.spots) filter (where d.source = 'pota'), 0)      as pota,
           coalesce(sum(d.spots) filter (where d.source = 'sotawatch'), 0) as sota,
           coalesce(sum(d.spots) filter (where d.source = 'wwff'), 0)      as wwff,
           coalesce(sum(d.spots) filter (where d.source = 'dxcluster'), 0) as dx,
           coalesce(sum(d.spots) filter (where d.source = 'rbn'), 0)       as rbn
    from country_daily_spots d
    join cty_entity_countries c using (entity)
    where d.day >= v_first_day and d.day < v_end_day
    group by c.country
  ),
  countries as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'pota', pota, 'sota', sota, 'wwff', wwff,
                                          'dx', dx, 'rbn', rbn)
                       order by pota + sota + wwff + dx + rbn desc, code asc),
             '[]'::jsonb
           ) as v
    from country_counts
  ),
  -- sotaAssociations: top 10 by spots; the association is the part before
  -- the first '/', so refs without a '/' are skipped.
  sota_association_counts as (
    select split_part(sota_summit_ref, '/', 1) as code, count(*) as n
    from spots
    where sota_summit_ref like '%/%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  sota_associations as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from sota_association_counts
  ),
  -- wwffPrograms: top 10 by spots; the national program is the part before
  -- the first '-' (KFF-5268 is KFF), so refs without a '-' are skipped.
  wwff_program_counts as (
    select split_part(wwff_reference, '-', 1) as code, count(*) as n
    from spots
    where wwff_reference like '%-%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  wwff_programs as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from wwff_program_counts
  ),
  -- bands: fixed order, zero-filled; other bands and null are excluded here
  -- but still counted in totals.
  band_order as (
    select * from (values
      ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
      ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)
    ) as b(band, ord)
  ),
  band_counts as (
    select band,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    where band is not null
    group by band
  ),
  bands as (
    select jsonb_agg(
             jsonb_build_object('band', bo.band, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0))
             order by bo.ord
           ) as v
    from band_order bo
    left join band_counts c using (band)
  ),
  -- modes: five fixed labels, integer percents that sum to exactly 100.
  -- The labels are mode_bucket() (20261012000040), which profiles use too;
  -- a null mode is Other.
  -- Each share is rounded (round() is half away from zero), then whatever is
  -- left over after rounding (100 - sum, possibly negative) is added to the
  -- bucket with the most spots. With no spots every percent is 0.
  mode_labels as (
    select * from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as l(label, ord)
  ),
  mode_counts as (
    select public.mode_bucket(mode, mode_family) as label, count(*) as n
    from spots
    group by 1
  ),
  mode_rounded as (
    select l.label, l.ord, coalesce(c.n, 0) as n,
           case when t.spots = 0 then 0
                else round(100.0 * coalesce(c.n, 0) / t.spots)::int
           end as pct
    from mode_labels l
    left join mode_counts c using (label)
    cross join totals t
  ),
  mode_fixed as (
    select label, ord,
           case when sum(pct) over () = 0 then 0
                when row_number() over (order by n desc, ord asc) = 1
                  then pct + (100 - sum(pct) over ())::int
                else pct
           end as percent
    from mode_rounded
  ),
  modes as (
    select jsonb_agg(jsonb_build_object('label', label, 'percent', percent) order by ord) as v
    from mode_fixed
  ),
  -- topActivators: top 8 by distinct references, then spots, then callsign.
  -- activations is per (reference, UTC day) within the callsign; base is the
  -- profile the Stats page links to.
  activators as (
    select callsign,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference) as refs,
           count(distinct (pota_reference, day)) filter (where pota_reference is not null)
             + count(distinct (sota_summit_ref, day)) filter (where sota_summit_ref is not null)
             + count(distinct (wwff_reference, day)) filter (where wwff_reference is not null) as activations,
           count(*) as n
    from spots
    group by callsign
    order by refs desc, n desc, callsign asc
    limit 8
  ),
  activator_bands as (
    select callsign, band,
           row_number() over (partition by callsign order by count(*) desc, band asc) as rn
    from spots
    where band is not null
      and callsign in (select callsign from activators)
    group by callsign, band
  ),
  top_activators as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('callsign', a.callsign, 'base', public.base_callsign(a.callsign),
                                  'references', a.refs, 'activations', a.activations,
                                  'spots', a.n, 'topBand', ab.band)
               order by a.refs desc, a.n desc, a.callsign asc
             ),
             '[]'::jsonb
           ) as v
    from activators a
    left join activator_bands ab on ab.callsign = a.callsign and ab.rn = 1
  ),
  -- topReferences: top 8 across the three programs by spots.
  -- activations is per (callsign, UTC day) within the reference.
  reference_counts as (
    select pota_reference as reference, 'POTA' as program, count(*) as n,
           count(distinct (callsign, day)) as activations
    from spots
    where pota_reference is not null
    group by pota_reference
    union all
    select sota_summit_ref, 'SOTA', count(*), count(distinct (callsign, day))
    from spots
    where sota_summit_ref is not null
    group by sota_summit_ref
    union all
    select wwff_reference, 'WWFF', count(*), count(distinct (callsign, day))
    from spots
    where wwff_reference is not null
    group by wwff_reference
  ),
  top_reference_rows as (
    select * from reference_counts
    order by n desc, reference asc
    limit 8
  ),
  -- The name is looked up only for the eight kept rows: the most recent
  -- non-null pota_park_name or wwff_reference_name by spot_time; SOTA has no name.
  top_reference_names as (
    select r.reference, r.program, r.n, r.activations,
           case when r.program = 'POTA' then (
             select s.pota_park_name
             from spots s
             where s.pota_reference = r.reference and s.pota_park_name is not null
             order by s.spot_time desc
             limit 1
           ) when r.program = 'WWFF' then (
             select s.wwff_reference_name
             from spots s
             where s.wwff_reference = r.reference and s.wwff_reference_name is not null
             order by s.spot_time desc
             limit 1
           ) end as name
    from top_reference_rows r
  ),
  top_references as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('reference', reference, 'name', name, 'program', program,
                                  'activations', activations, 'spots', n)
               order by n desc, reference asc
             ),
             '[]'::jsonb
           ) as v
    from top_reference_names
  ),
  -- rbn: everything below reads the rollup tables, never rbn_spots. Skimmers
  -- are distinct callsigns over the whole week, counted as stored.
  rbn_skimmer_rows as (
    select spotter, band, spots from rbn_daily_skimmers
    where day >= v_first_day and day < v_end_day
  ),
  rbn_totals as (
    select (select coalesce(sum(spots), 0) from rbn_hourly
             where hour >= v_window_start and hour < v_window_end) as spots,
           (select count(distinct spotter) from rbn_skimmer_rows)  as skimmers
  ),
  -- RBN bands: the same fixed order as bands, zero-filled, so the three band
  -- charts share an axis. Other bands and null are counted in spots only.
  rbn_band_counts as (
    select band, sum(spots) as n from rbn_skimmer_rows where band is not null group by band
  ),
  rbn_bands as (
    select jsonb_agg(jsonb_build_object('band', bo.band, 'spots', coalesce(c.n, 0)) order by bo.ord) as v
    from band_order bo
    left join rbn_band_counts c using (band)
  ),
  rbn as (
    select jsonb_build_object(
             'spots', t.spots, 'skimmers', t.skimmers,
             'bands', b.v,
             'topStations', coalesce(
               (select jsonb_agg(
                         jsonb_build_object('callsign', callsign, 'spots', spots, 'skimmers', skimmers)
                         order by spots desc, callsign asc
                       )
                from rbn_top_stations
                where window_start = v_window_start),
               '[]'::jsonb
             )
           ) as v
    from rbn_totals t
    cross join rbn_bands b
  ),
  -- aprs: packets from aprs_packet_hours, the rest from the day rollups; never
  -- aprs_packets. Stations and igates are distinct over the whole week.
  aprs_type_order as (
    select unnest(array[
      'position', 'mic_e', 'object', 'item', 'message', 'status', 'weather',
      'telemetry', 'nmea', 'third_party', 'capabilities', 'query', 'user_defined', 'other'
    ]) as type
  ),
  aprs_type_counts as (
    select packet_type as type, sum(packets) as n
    from aprs_daily_types
    where day >= v_first_day and day < v_end_day
    group by 1
  ),
  aprs as (
    select jsonb_build_object(
             'packets', (select coalesce(sum(packets), 0) from aprs_packet_hours
                         where hour_start >= v_window_start and hour_start < v_window_end),
             'stations', (select count(distinct base) from aprs_daily_stations
                          where day >= v_first_day and day < v_end_day),
             'igates', (select count(distinct igate) from aprs_daily_igates
                        where day >= v_first_day and day < v_end_day),
             'types', (select jsonb_agg(jsonb_build_object('type', o.type, 'packets', coalesce(c.n, 0))
                                        order by coalesce(c.n, 0) desc, o.type asc)
                       from aprs_type_order o
                       left join aprs_type_counts c using (type))
           ) as v
  )
  -- Every CTE above is a single-row aggregate, so the cross joins yield one row.
  select
    v_window_start,
    v_window_end,
    jsonb_build_object(
      'totals', jsonb_build_object(
        'spots', t.spots, 'potaSpots', t.pota_spots, 'sotaSpots', t.sota_spots, 'wwffSpots', t.wwff_spots,
        'activators', t.activators, 'references', t.references,
        'activations', t.pota_activations + t.sota_activations + t.wwff_activations,
        'potaActivations', t.pota_activations, 'sotaActivations', t.sota_activations,
        'wwffActivations', t.wwff_activations,
        'chasers', t.chasers, 'potaChasers', t.pota_chasers, 'sotaChasers', t.sota_chasers,
        'wwffChasers', t.wwff_chasers
      ),
      'peakHour', coalesce((select hour from peak_hour), 0),
      'busiestSlot', coalesce(
        (select jsonb_build_object('day', day, 'hour', hour) from busiest_slot),
        jsonb_build_object('day', to_char(v_window_start at time zone 'utc', 'YYYY-MM-DD'), 'hour', 0)
      ),
      'daily',            d.v,
      'hourly',           h.v,
      'potaByState',      ps.v,
      'countries',        co.v,
      'sotaAssociations', sa.v,
      'wwffPrograms',     wp.v,
      'bands',            b.v,
      'modes',            m.v,
      'topActivators',    ta.v,
      'topReferences',    tr.v,
      'rbn',              r.v,
      'aprs',             ap.v
    )
  from totals t
  cross join daily d
  cross join hourly h
  cross join pota_by_state ps
  cross join countries co
  cross join sota_associations sa
  cross join wwff_programs wp
  cross join bands b
  cross join modes m
  cross join top_activators ta
  cross join top_references tr
  cross join rbn r
  cross join aprs ap;

  -- Keep the 48 most recent snapshots (two days at one per hour).
  delete from stats_snapshots
  where id not in (
    select id from stats_snapshots
    order by generated_at desc, id desc
    limit 48
  );
end;
$$;
