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
