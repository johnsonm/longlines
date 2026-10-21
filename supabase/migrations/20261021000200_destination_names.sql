-- First name and Last name as fields of every destination type: push
-- notifications, Discord messages and webhook bodies can show the licensee's
-- name for the spotted call when the license records have one.
--
-- callsign_licenses kept only the joined name ("Jane Q Doe Jr", or a club's
-- entity name), which cannot be split back reliably, so the FCC load now
-- stages the first and last names as the EN record has them and the swap
-- keeps them in their own columns. Rows loaded before this stay without them
-- until the next weekly load replaces every FCC row. A club has neither, so
-- its spots carry no name. The relay and this migration ship in either order:
-- jsonb_to_recordset drops keys a table has no column for, and leaves columns
-- the relay does not send null.
--
-- The name is the spotted call's (by base call), never the spotter's, and a
-- call in hidden_callsigns has none, as its profile shows no license. Every
-- renderer reads it through spot_license_name, so the preview, the test and
-- the delivery agree.

-- ---------------------------------------------------------------------------
-- 1. License records: first and last names
-- ---------------------------------------------------------------------------

alter table callsign_licenses add column first_name text, add column last_name text;
alter table fcc_uls_en add column first_name text, add column last_name text;

-- Same as 20261012000050 except EN rows stage first_name and last_name.
create or replace function public.fcc_license_load_rows(p_load bigint, p_kind text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_staged integer;
begin
  perform 1 from license_loads where id = p_load and authority = 'FCC' and status = 'loading'
  for update;
  if not found then
    raise exception 'fcc_license_load_rows: load % is not loading', p_load;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'fcc_license_load_rows: rows must be an array';
  end if;

  case p_kind
    when 'HD' then
      insert into fcc_uls_hd (usi, callsign, status, granted_on, expires_on)
      select x.usi, upper(x.callsign), x.status, x.granted_on, x.expires_on
      from jsonb_to_recordset(p_rows) as x(
        usi bigint, callsign text, status text, granted_on date, expires_on date)
      on conflict (usi) do nothing;
    when 'EN' then
      insert into fcc_uls_en (usi, name, first_name, last_name, state)
      select x.usi, x.name, x.first_name, x.last_name, x.state
      from jsonb_to_recordset(p_rows) as x(usi bigint, name text, first_name text, last_name text, state text)
      on conflict (usi) do nothing;
    when 'AM' then
      insert into fcc_uls_am (usi, operator_class)
      select x.usi, x.operator_class
      from jsonb_to_recordset(p_rows) as x(usi bigint, operator_class text)
      on conflict (usi) do nothing;
    else
      raise exception 'fcc_license_load_rows: unknown record type %', p_kind;
  end case;
  get diagnostics v_inserted = row_count;

  update license_loads
     set counts = jsonb_set(counts, array[p_kind], to_jsonb((counts ->> p_kind)::integer + v_inserted))
   where id = p_load
  returning (counts ->> p_kind)::integer into v_staged;
  return v_staged;
end;
$$;

-- Same as 20261012000050 except the first and last names go in too.
create or replace function public.apply_license_loads()
returns void
language plpgsql
set search_path = public
as $$
declare
  v_load license_loads;
  v_licenses integer;
begin
  select * into v_load from license_loads
  where authority = 'FCC' and status = 'ready'
  order by id desc
  limit 1
  for update;
  if not found then
    return;
  end if;

  begin
    if fcc_license_staged_counts() is distinct from v_load.counts then
      raise exception 'staging no longer matches load % (%)', v_load.id, fcc_license_staged_counts();
    end if;

    delete from callsign_licenses where authority = 'FCC';
    insert into callsign_licenses (callsign, authority, name, first_name, last_name, operator_class, status,
                                   granted_on, expires_on, country, state, grid, loaded_at)
    select h.callsign, 'FCC', e.name, e.first_name, e.last_name, a.operator_class, h.status,
           h.granted_on, h.expires_on, 'US', e.state, null, now()
    from (select distinct on (callsign) *
          from fcc_uls_hd
          order by callsign, (status = 'Active') desc nulls last, granted_on desc nulls last,
                   usi desc) h
    left join fcc_uls_en e on e.usi = h.usi
    left join fcc_uls_am a on a.usi = h.usi;
    get diagnostics v_licenses = row_count;

    update license_loads set status = 'applied', applied_at = now(), licenses = v_licenses
     where id = v_load.id;
  exception when others then
    update license_loads set status = 'failed', error = sqlerrm where id = v_load.id;
  end;

  truncate fcc_uls_hd, fcc_uls_en, fcc_uls_am;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The name of a spot's call
-- ---------------------------------------------------------------------------

-- The licensee's first ('first') or last ('last') name for the spot's base
-- call (delivery_spot_json shape), or null when there is no license, the
-- record has no such name (a club) or the call is hidden. One primary-key
-- read per call; the renderers run inside definer RPCs, so callers need no
-- grant on callsign_licenses.
create function public.spot_license_name(p_spot jsonb, p_part text)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(case p_part when 'first' then c.first_name when 'last' then c.last_name end, '')
  from public.callsign_licenses c
  where c.callsign = coalesce(nullif(p_spot ->> 'base_callsign', ''), public.base_callsign(p_spot ->> 'callsign'))
    and not exists (select 1 from public.hidden_callsigns h where h.callsign = c.callsign);
$$;

revoke all on function public.spot_license_name(jsonb, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Push and Discord: two more fields
-- ---------------------------------------------------------------------------

-- Same as 20261016000400 with first_name and last_name after the callsign.
-- discord_fields() is push's minus comment, so Discord gets both too.
create or replace function public.push_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['callsign', 'first_name', 'last_name', 'frequency', 'band', 'mode', 'source', 'reference',
               'place_name', 'state', 'spotter', 'comment', 'time'];
$$;

create or replace function public.push_field_label(p_field text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_field
    when 'callsign' then 'Callsign'
    when 'first_name' then 'First name'
    when 'last_name' then 'Last name'
    when 'frequency' then 'Frequency'
    when 'band' then 'Band'
    when 'mode' then 'Mode'
    when 'source' then 'Source'
    when 'reference' then 'Reference'
    when 'place_name' then 'Place name'
    when 'state' then 'State'
    when 'spotter' then 'Spotter'
    when 'comment' then 'Comment'
    when 'time' then 'Time'
  end;
$$;

-- Same as 20261016000400 plus first_name and last_name as the license has
-- them (spot_license_name). Stable, not immutable, since those read
-- callsign_licenses.
create or replace function public.render_push_field(p_field text, p_spot jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(case p_field
    when 'callsign' then p_spot ->> 'callsign'
    when 'first_name' then public.spot_license_name(p_spot, 'first')
    when 'last_name' then public.spot_license_name(p_spot, 'last')
    when 'frequency' then to_char((p_spot ->> 'frequency_khz')::numeric / 1000, 'FM9999990.000') || ' MHz'
    when 'band' then p_spot ->> 'band'
    when 'mode' then upper(p_spot ->> 'mode')
    when 'source' then public.push_source_label(p_spot ->> 'source')
    when 'reference' then coalesce(nullif(p_spot ->> 'pota_reference', ''), nullif(p_spot ->> 'sota_summit_ref', ''),
                                   p_spot ->> 'wwff_reference')
    when 'place_name' then coalesce(nullif(p_spot ->> 'pota_park_name', ''), p_spot ->> 'wwff_reference_name')
    when 'state' then (
      select string_agg(coalesce(nullif(split_part(trim(x), '-', 2), ''), trim(x)), '/')
      from regexp_split_to_table(p_spot ->> 'pota_location', ',') x
      where trim(x) <> '')
    when 'spotter' then p_spot ->> 'spotter'
    when 'comment' then p_spot ->> 'comment'
    when 'time' then to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24:MI') || 'Z'
  end, '');
$$;

-- They call render_push_field, which now reads a table.
alter function public.render_push_fields(text[], jsonb, text, boolean) stable;
alter function public.push_spot_fields(push_destination_settings, jsonb) stable;

-- ---------------------------------------------------------------------------
-- 4. Webhooks: two more fields
-- ---------------------------------------------------------------------------

-- Same as 20261018000300 with first_name and last_name after the callsign.
create or replace function public.webhook_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['id', 'time', 'callsign', 'first_name', 'last_name', 'frequency', 'mode', 'band', 'source',
               'reference', 'place_name', 'state', 'spotter', 'country', 'url', 'comment'];
$$;

-- Same as 20261018000300 with room for every field (16).
create or replace function public.webhook_fields_valid(p_fields text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_fields is not null
     and cardinality(p_fields) between 1 and 16
     and p_fields <@ public.webhook_fields()
     and (select count(distinct f) from unnest(p_fields) f) = cardinality(p_fields);
$$;

-- Same as 20261018000300 plus firstName and lastName in camelCase.
create or replace function public.webhook_field_key(p_field text, p_key_style text, p_frequency_unit text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_field = 'frequency' and p_key_style = 'camel' then 'frequency' || initcap(p_frequency_unit)
    when p_field = 'frequency' then 'frequency_' || p_frequency_unit
    when p_field = 'place_name' and p_key_style = 'camel' then 'placeName'
    when p_field = 'first_name' and p_key_style = 'camel' then 'firstName'
    when p_field = 'last_name' and p_key_style = 'camel' then 'lastName'
    else p_field
  end;
$$;

-- Same as 20261018000300 plus first_name and last_name (spot_license_name).
create or replace function public.webhook_field_value(p_field text, p_spot jsonb, p_time_format text, p_frequency_unit text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select nullif(case p_field
    when 'id' then p_spot -> 'id'
    when 'time' then case p_time_format
      when 'unix_seconds' then to_jsonb(floor(extract(epoch from (p_spot ->> 'spot_time')::timestamptz))::bigint)
      else to_jsonb(to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    end
    when 'callsign' then to_jsonb(nullif(p_spot ->> 'callsign', ''))
    when 'first_name' then to_jsonb(public.spot_license_name(p_spot, 'first'))
    when 'last_name' then to_jsonb(public.spot_license_name(p_spot, 'last'))
    when 'frequency' then case p_frequency_unit
      when 'mhz' then to_jsonb(trim_scale(round((p_spot ->> 'frequency_khz')::numeric / 1000, 6)))
      when 'hz' then to_jsonb(((p_spot ->> 'frequency_khz')::numeric * 1000)::bigint)
      else to_jsonb(trim_scale((p_spot ->> 'frequency_khz')::numeric))
    end
    when 'mode' then to_jsonb(nullif(lower(p_spot ->> 'mode'), ''))
    when 'band' then to_jsonb(nullif(p_spot ->> 'band', ''))
    when 'source' then to_jsonb(nullif(p_spot ->> 'source', ''))
    when 'reference' then to_jsonb(public.render_push_field('reference', p_spot))
    when 'place_name' then to_jsonb(public.render_push_field('place_name', p_spot))
    when 'state' then to_jsonb(public.render_push_field('state', p_spot))
    when 'spotter' then to_jsonb(nullif(p_spot ->> 'spotter', ''))
    when 'country' then to_jsonb(nullif((select c.name from public.cty_lookup(p_spot ->> 'callsign') c), ''))
    when 'url' then to_jsonb(public.spot_source_url(p_spot))
    when 'comment' then to_jsonb(nullif(p_spot ->> 'comment', ''))
  end, 'null'::jsonb);
$$;
