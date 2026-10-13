-- The Stats snapshot never names a call in hidden_callsigns. stats_snapshots
-- is public (anon reads it), and its top lists would otherwise show a busy
-- station whose profile returns the not-heard shape, which tells anyone the
-- call is hidden. The lookup page's "Busy this week" chips come from the same
-- list.
--
-- A trigger rather than a change to refresh_stats_snapshot(), so it holds for
-- every later version of that function. It drops hidden calls from
-- topActivators and rbn.topStations (matched on base_callsign), so a list can
-- hold fewer than eight. On update too: after hiding a call, the operator can
-- run `update stats_snapshots set payload = payload` instead of waiting for the
-- next hourly refresh.

create function public.stats_payload_without_hidden(p_payload jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with visible_activators as (
    select coalesce(jsonb_agg(e order by o), '[]'::jsonb) as v
    from jsonb_array_elements(coalesce(p_payload -> 'topActivators', '[]'::jsonb)) with ordinality as t(e, o)
    where not exists (select 1 from hidden_callsigns h where h.callsign = public.base_callsign(e ->> 'callsign'))
  ),
  visible_stations as (
    select coalesce(jsonb_agg(e order by o), '[]'::jsonb) as v
    from jsonb_array_elements(coalesce(p_payload #> '{rbn,topStations}', '[]'::jsonb)) with ordinality as t(e, o)
    where not exists (select 1 from hidden_callsigns h where h.callsign = public.base_callsign(e ->> 'callsign'))
  )
  select case when p_payload #> '{rbn,topStations}' is null then x.p
              else jsonb_set(x.p, '{rbn,topStations}', s.v) end
  from (select case when p_payload ? 'topActivators' then jsonb_set(p_payload, '{topActivators}', a.v)
                    else p_payload end as p
        from visible_activators a) as x
  cross join visible_stations s;
$$;

create function public.stats_snapshots_drop_hidden()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.payload := public.stats_payload_without_hidden(new.payload);
  return new;
end;
$$;

create trigger stats_snapshots_drop_hidden
  before insert or update of payload on stats_snapshots
  for each row execute function public.stats_snapshots_drop_hidden();

revoke all on function public.stats_payload_without_hidden(jsonb) from public, anon, authenticated;
revoke all on function public.stats_snapshots_drop_hidden() from public, anon, authenticated;

-- Snapshots written before this migration.
update stats_snapshots set payload = payload;
