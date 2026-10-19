-- Group statistics and public group pages (docs/superpowers/specs/
-- 2026-10-19-group-statistics-design.md, canvas page 10).
--
-- 1. Sharing columns on callsign_groups, the public code, the statistics
--    cache table, and save_callsign_group taking the two sharing keys.
-- 2. group_statistics: the whole payload for one group and period, built from
--    callsign_days, day-grain callsign_activity, callsign_seen and spot_stream.
-- 3. The hour's cache, the owner's RPCs, the service-role public RPC and the
--    redaction for a page without callsigns.
--
-- No cron job: a group's statistics are built when someone opens them, at most
-- once an hour per period.

-- ---------------------------------------------------------------------------
-- 1. Sharing
-- ---------------------------------------------------------------------------

-- public_slug is made the first time the page goes public and never changes,
-- so a printed link works again when sharing is turned back on.
alter table callsign_groups
  add column public         boolean not null default false,
  add column show_callsigns boolean not null default false,
  add column public_slug    text unique check (public_slug ~ '^[a-z2-7]{10}$');

-- One row per group and period; dropped with the group (and so with the
-- account). Service-role only: clients read it through the RPCs below.
create table group_stats_cache (
  group_id     uuid        not null references callsign_groups (id) on delete cascade,
  period       text        not null check (period in ('7d', '30d')),
  payload      jsonb       not null,
  generated_at timestamptz not null default now(),
  primary key (group_id, period)
);

alter table group_stats_cache enable row level security;
revoke all on group_stats_cache from anon, authenticated;

-- Ten characters of a-z2-7, five random bits each (new_api_token()'s masking:
-- a 32-letter alphabet, so masking a byte to five bits is unbiased). 50 bits,
-- so a collision is all but impossible; the loop makes it impossible.
create function public.new_group_slug()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  v_slug text;
begin
  loop
    select string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(r.b, i) & 31) + 1, 1), '' order by i)
    into v_slug
    from (select gen_random_bytes(10) as b) r, generate_series(0, 9) as i;
    exit when not exists (select 1 from callsign_groups g where g.public_slug = v_slug);
  end loop;
  return v_slug;
end;
$$;

revoke all on function public.new_group_slug() from public;

-- 20261013000210's save, plus the sharing keys. "public" and "show_callsigns"
-- are optional booleans: a key left out (or null) keeps the stored value, so
-- patch_callsign_group, edit_group_callsigns and the API, which never send
-- them, change nothing. Turning the page public the first time makes its code.
-- A change to the member list drops the group's cached statistics.
create or replace function public.save_callsign_group(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_id      uuid := (payload ->> 'id')::uuid;
  v_name    text := trim(coalesce(payload ->> 'name', ''));
  v_public  boolean;
  v_show    boolean;
  v_norm    jsonb;
  v_calls   text[];
  v_removed int;
  v_added   int;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the group a name.';
  end if;
  if jsonb_typeof(payload -> 'public') not in ('boolean', 'null')
     or jsonb_typeof(payload -> 'show_callsigns') not in ('boolean', 'null') then
    raise exception 'Not a valid setting.';
  end if;
  v_public := (payload ->> 'public')::boolean;
  v_show := (payload ->> 'show_callsigns')::boolean;

  v_norm := public.normalize_group_callsigns(
    array(select jsonb_array_elements_text(coalesce(payload -> 'callsigns', '[]'::jsonb))));
  if jsonb_array_length(v_norm -> 'rejected') > 0 then
    raise exception 'Not a callsign: %.', v_norm -> 'rejected' ->> 0;
  end if;
  v_calls := array(select jsonb_array_elements_text(v_norm -> 'callsigns'));
  if cardinality(v_calls) > 1000 then
    raise exception 'A group can hold up to 1,000 callsigns.';
  end if;

  if v_id is null then
    insert into callsign_groups (user_id, name, public, show_callsigns, public_slug)
    values (v_user, v_name, coalesce(v_public, false), coalesce(v_show, false),
            case when v_public then public.new_group_slug() end)
    returning id into v_id;
  else
    -- set_updated_at bumps updated_at even when only members change.
    update callsign_groups g
    set name = v_name,
        public = coalesce(v_public, g.public),
        show_callsigns = coalesce(v_show, g.show_callsigns),
        public_slug = case when coalesce(v_public, g.public) and g.public_slug is null
                           then public.new_group_slug() else g.public_slug end
    where g.id = v_id and g.user_id = v_user;
    if not found then
      raise exception 'Group not found.';
    end if;
  end if;

  delete from callsign_group_members m where m.group_id = v_id and m.callsign <> all (v_calls);
  get diagnostics v_removed = row_count;
  insert into callsign_group_members (group_id, callsign)
  select v_id, c from unnest(v_calls) as c
  on conflict do nothing;
  get diagnostics v_added = row_count;

  if v_removed + v_added > 0 then
    delete from group_stats_cache c where c.group_id = v_id;
  end if;

  return v_id;
exception
  when unique_violation then
    raise exception 'You already have a group with that name.';
end;
$$;

-- The management API does not share pages (spec, decision 8): api_call drops
-- the two sharing keys before a group create or update, since routeArgs passes
-- a body's other keys through. The body is 20261016000600's otherwise.
create or replace function public.api_call(p_token_id uuid, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_user   uuid;
  v_scope  text;
  v_needs  text;
  v_id     uuid;
  v_result jsonb;
begin
  select t.user_id, t.scope into v_user, v_scope from api_tokens t
  where t.id = p_token_id and (t.expires_at is null or t.expires_at > now());
  if v_user is null then
    raise exception 'Token not found.';
  end if;

  v_needs := case
    when p_op in ('list_destinations', 'get_destination', 'list_subscriptions',
                  'get_subscription', 'list_groups', 'get_group')
      then 'read'
    when p_op in ('create_destination', 'update_destination', 'delete_destination',
                  'rotate_signing_secret', 'create_subscription', 'replace_subscription',
                  'patch_subscription', 'delete_subscription', 'create_group', 'update_group',
                  'delete_group', 'add_group_members', 'remove_group_members')
      then 'write'
  end;
  if v_needs is null then
    raise exception 'Unknown operation.';
  end if;
  if v_needs = 'write' and v_scope <> 'write' then
    raise exception 'This token is read only.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  v_id := nullif(p_args ->> 'id', '')::uuid;

  case p_op
    -- Destinations
    when 'list_destinations' then
      select coalesce(jsonb_agg(public.api_destination_json(d) order by d.created_at), '[]')
      into v_result from destinations d where d.user_id = v_user;
    when 'get_destination' then
      select public.api_destination_json(d) into v_result
      from destinations d where d.id = v_id and d.user_id = v_user;
      if v_result is null then
        raise exception 'Destination not found.';
      end if;
    when 'create_destination' then
      select to_jsonb(c) into v_result
      from public.create_destination(p_args ->> 'type', p_args ->> 'name', p_args ->> 'url') c;
    when 'update_destination' then
      perform public.update_destination(v_id, p_args ->> 'name', p_args ->> 'url',
                                        (p_args ->> 'enabled')::boolean);
      select public.api_destination_json(d) into v_result from destinations d where d.id = v_id;
    when 'delete_destination' then
      perform public.delete_destination(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'rotate_signing_secret' then
      v_result := jsonb_build_object('signing_secret', public.rotate_signing_secret(v_id));

    -- Subscriptions
    when 'list_subscriptions' then
      select coalesce(jsonb_agg(public.api_subscription_json(s) order by s.created_at), '[]')
      into v_result from subscriptions s where s.user_id = v_user;
    when 'get_subscription' then
      select public.api_subscription_json(s) into v_result
      from subscriptions s where s.id = v_id and s.user_id = v_user;
      if v_result is null then
        raise exception 'Connection not found.';
      end if;
    when 'create_subscription' then
      v_id := public.save_subscription(coalesce(p_args -> 'body', '{}') - 'id');
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'replace_subscription' then
      perform public.save_subscription(
        coalesce(p_args -> 'body', '{}') || jsonb_build_object('id', v_id));
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'patch_subscription' then
      perform public.patch_subscription(v_id, p_args -> 'body');
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'delete_subscription' then
      perform public.delete_subscription(v_id);
      v_result := jsonb_build_object('deleted', true);

    -- Callsign groups
    when 'list_groups' then
      select coalesce(jsonb_agg(public.api_group_json(to_jsonb(g))), '[]') into v_result
      from public.list_callsign_groups() g;
    when 'get_group' then
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
      if v_result is null then
        raise exception 'Group not found.';
      end if;
    when 'create_group' then
      v_id := public.save_callsign_group(p_args - 'id' - 'public' - 'show_callsigns');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'update_group' then
      perform public.patch_callsign_group(v_id, p_args - 'id' - 'public' - 'show_callsigns');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'delete_group' then
      perform public.delete_callsign_group(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_group_members' then
      perform public.edit_group_callsigns(v_id, p_args -> 'callsigns', null);
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'remove_group_members' then
      perform public.edit_group_callsigns(v_id, null, p_args -> 'callsigns');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
  end case;

  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The payload builder
-- ---------------------------------------------------------------------------

-- The whole statistics payload for one group and period (GroupStatistics in
-- web/src/groups/stats/types.ts, pinned by group_statistics.test.sql). The
-- clock is an argument so the test can pin it; group_statistics passes now().
--
-- Members are the group's base calls minus hidden_callsigns: a hidden call
-- counts nowhere, not even in totals or "of N members". A period is the last 7
-- or 30 UTC days ending today; "previous" is the same number of days before.
--
-- Each store is read once, filtered on the member bases (callsign_days,
-- callsign_activity and callsign_seen lead with base; spot_stream through the
-- base-callsign indexes):
--   day_spots  spots per member per day, a year back: callsign_days for
--              rolled-up days plus the live days, as callsign_profile's
--              calendar does. Totals, days, the heat map and the sparkline.
--   mix        spots per member, band and mode bucket in the period:
--              day-grain callsign_activity (kept 35 days) plus the live days.
--   refs       the period's spots with a reference (raw_spots' arm only), for
--              activations, places and the parks list. An activation is one
--              (member, program, reference, UTC day), as
--              callsign_references.days counts them.
create function public.group_statistics_at(p_group_id uuid, p_period text, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days      int := case p_period when '7d' then 7 when '30d' then 30 end;
  v_today     date := (p_now at time zone 'utc')::date;
  v_year      date := (p_now at time zone 'utc')::date - 364;
  v_from      date;
  v_prev      date;
  v_live_from date;
  v_bases     text[];
begin
  if v_days is null then
    raise exception 'Not a valid period.';
  end if;
  if not exists (select 1 from callsign_groups g where g.id = p_group_id) then
    return null;
  end if;
  v_from := v_today - (v_days - 1);
  v_prev := v_from - v_days;

  select coalesce(array_agg(m.callsign order by m.callsign), '{}') into v_bases
  from callsign_group_members m
  where m.group_id = p_group_id
    and not exists (select 1 from hidden_callsigns h where h.callsign = m.callsign);

  -- callsign_profile's live window: the oldest of the last 14 days without a
  -- marker, never before the first marker. Today never has one.
  select min(g.d)::date into v_live_from
  from generate_series(greatest(v_today - 14, (select min(day) from callsign_rollup_days)), v_today,
                       interval '1 day') as g(d)
  where not exists (select 1 from callsign_rollup_days r where r.day = g.d::date);

  return (
    with live as materialized (
      select s.base_callsign as base, (s.spot_time at time zone 'utc')::date as day, s.spot_time,
             s.band, s.mode_bucket
      from spot_stream s
      where s.base_callsign = any (v_bases)
        and s.spot_time >= v_live_from::timestamp at time zone 'utc'
        and s.spot_time < (v_today + 1)::timestamp at time zone 'utc'
        and not exists (select 1 from callsign_rollup_days d
                        where d.day = (s.spot_time at time zone 'utc')::date)
    ),
    day_spots as (
      select base, day, sum(n)::bigint as spots
      from (
        select d.base, d.day, d.spots::bigint as n
        from callsign_days d
        where d.base = any (v_bases) and d.day >= v_year and d.day <= v_today
        union all
        select l.base, l.day, count(*) from live l group by l.base, l.day
      ) x
      group by base, day
    ),
    mix as (
      select base, band, mode_bucket, sum(n)::bigint as n
      from (
        select a.base, a.band, a.mode_bucket, a.spots::bigint as n
        from callsign_activity a
        where a.base = any (v_bases) and a.role = 'heard' and a.grain = 'day'
          and a.period >= v_from and a.period <= v_today
        union all
        select l.base, l.band, l.mode_bucket, count(*) from live l where l.day >= v_from group by 1, 2, 3
      ) x
      group by base, band, mode_bucket
    ),
    refs as materialized (
      select s.base_callsign as base, s.program, s.reference, (s.spot_time at time zone 'utc')::date as day,
             s.reference_name, s.spot_time
      from spot_stream s
      where s.base_callsign = any (v_bases) and s.program is not null
        and s.spot_time >= v_from::timestamp at time zone 'utc'
        and s.spot_time < (v_today + 1)::timestamp at time zone 'utc'
    ),
    activations as (
      select distinct base, program, reference, day from refs
    ),
    per_member as (
      select b.base,
             coalesce(sum(d.spots), 0)::bigint as spots,
             count(d.day) filter (where d.spots > 0) as days
      from unnest(v_bases) as b(base)
      left join day_spots d on d.base = b.base and d.day >= v_from
      group by b.base
    ),
    main_mode as (
      select distinct on (base) base, mode_bucket
      from (select base, mode_bucket, sum(n) as n from mix group by base, mode_bucket) x
      order by base, n desc, array_position(array['CW', 'SSB', 'FT8/FT4', 'FM', 'Other'], mode_bucket)
    ),
    last_heard as (
      select b.base, greatest(s.last_spot, (select max(l.spot_time) from live l where l.base = b.base)) as t
      from unnest(v_bases) as b(base)
      left join callsign_seen s on s.base = b.base
    ),
    kpis as (
      select jsonb_build_object(
        'spots', (select coalesce(sum(spots), 0)::bigint from day_spots where day >= v_from),
        'previousSpots', (select coalesce(sum(spots), 0)::bigint from day_spots where day >= v_prev and day < v_from),
        'membersHeard', (select count(*) from per_member where spots > 0),
        'activations', (select jsonb_build_object(
                          'pota', count(*) filter (where program = 'POTA'),
                          'sota', count(*) filter (where program = 'SOTA'),
                          'wwff', count(*) filter (where program = 'WWFF'))
                        from activations),
        'places', (select jsonb_build_object(
                     'parks', count(distinct program || ':' || reference) filter (where program in ('POTA', 'WWFF')),
                     'summits', count(distinct reference) filter (where program = 'SOTA'))
                   from activations)) as v
    ),
    daily as (
      select jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'spots', coalesce(x.n, 0))
                       order by g.d) as v
      from generate_series(v_from, v_today, interval '1 day') as g(d)
      left join (select day, sum(spots)::bigint as n from day_spots group by day) x on x.day = g.d::date
    ),
    calendar as (
      select coalesce(jsonb_agg(jsonb_build_object('day', to_char(c.day, 'YYYY-MM-DD'), 'spots', c.n,
                                                   'members', c.m) order by c.day), '[]') as v
      from (select day, sum(spots)::bigint as n, count(*) filter (where spots > 0) as m
            from day_spots group by day having sum(spots) > 0) c
    ),
    top_rows as (
      select 'spots' as list, base, spots as value from per_member
      union all select 'days', base, days from per_member
      union all select 'cw', base, sum(n)::bigint from mix where mode_bucket = 'CW' group by base
      union all select 'ssb', base, sum(n)::bigint from mix where mode_bucket = 'SSB' group by base
      union all select 'digital', base, sum(n)::bigint from mix where mode_bucket = 'FT8/FT4' group by base
      union all select 'parks', base, count(distinct reference) from activations where program = 'POTA' group by base
    ),
    top_ranked as (
      select list, base, value, row_number() over (partition by list order by value desc, base) as r
      from top_rows
      where value > 0
    ),
    top_json as (
      select jsonb_object_agg(l.list, coalesce(
               (select jsonb_agg(jsonb_build_object('callsign', t.base, 'value', t.value) order by t.r)
                from top_ranked t where t.list = l.list and t.r <= 3), '[]')) as v
      from unnest(array['spots', 'days', 'cw', 'ssb', 'digital', 'parks']) as l(list)
    ),
    members_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'callsign', p.base, 'spots', p.spots, 'days', p.days, 'mainMode', mm.mode_bucket,
               'lastHeard', to_char(lh.t at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
             order by p.spots desc, p.days desc, p.base), '[]') as v
      from per_member p
      left join main_mode mm on mm.base = p.base
      left join last_heard lh on lh.base = p.base
    ),
    -- callsign_profile's bands: fixed order, zero-filled, other bands left out.
    bands as (
      select jsonb_agg(jsonb_build_object(
               'band', bo.band, 'spots', coalesce((select sum(m.n) from mix m where m.band = bo.band), 0)::bigint)
             order by bo.ord) as v
      from (values ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
                   ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)) as bo(band, ord)
    ),
    modes as (
      select coalesce(jsonb_agg(jsonb_build_object('label', ml.label, 'spots', c.n) order by ml.ord), '[]') as v
      from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as ml(label, ord)
      join (select mode_bucket, sum(n)::bigint as n from mix group by mode_bucket) c on c.mode_bucket = ml.label
      where c.n > 0
    ),
    places as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'reference', p.reference, 'name', p.name, 'program', p.program, 'times', p.times,
               'by', to_jsonb(p.by_calls))
             order by p.times desc, p.reference), '[]') as v
      from (
        select a.program, a.reference, count(*) as times,
               array_agg(distinct a.base order by a.base) as by_calls,
               (select r.reference_name from refs r
                where r.program = a.program and r.reference = a.reference and r.reference_name is not null
                order by r.spot_time desc limit 1) as name
        from activations a
        group by a.program, a.reference
        order by times desc, a.reference
        limit 10
      ) p
    )
    select jsonb_build_object(
             'period', p_period,
             'generatedAt', to_char(p_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'memberCount', cardinality(v_bases),
             'kpis', kpis.v,
             'daily', daily.v,
             'calendar', calendar.v,
             'top', top_json.v,
             'members', members_json.v,
             'bands', bands.v,
             'modes', modes.v,
             'places', places.v)
    from kpis, daily, calendar, top_json, members_json, bands, modes, places
  );
end;
$$;

create function public.group_statistics(p_group_id uuid, p_period text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.group_statistics_at(p_group_id, p_period, now());
$$;

revoke all on function public.group_statistics_at(uuid, text, timestamptz) from public;
revoke all on function public.group_statistics(uuid, text) from public;
