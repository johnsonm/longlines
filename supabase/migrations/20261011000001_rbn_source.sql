-- Reverse Beacon Network as a third source.
--
-- RBN spots arrive by push: the relay (relay/, on Fly.io) holds the telnet
-- stream and POSTs batches to the ingest-rbn Edge Function. Only stations named
-- in a subscription are forwarded, so the relay asks for that list through
-- watched_callsigns().

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn'));

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('rbn') on conflict do nothing;

-- Callsigns named by enabled subscriptions that accept p_source (an empty
-- sources list accepts every source). The relay forwards only these.
create function public.watched_callsigns(p_source text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct c
  from subscriptions s, unnest(s.callsigns) as c
  where s.enabled
    and (cardinality(s.sources) = 0 or p_source = any (s.sources))
  order by c;
$$;

revoke all on function public.watched_callsigns(text) from public, anon, authenticated;
grant execute on function public.watched_callsigns(text) to service_role;

-- spot_matches: as in 0014, plus an RBN spot only matches a subscription that
-- names callsigns. RBN spots exist because someone's subscription named that
-- station; an "any source, 20m CW" subscription must not receive them.
create or replace function public.spot_matches(sub subscriptions, spot raw_spots)
returns boolean
language sql
immutable
as $$
  select coalesce(
        (cardinality(sub.sources)   = 0 or spot.source   = any (sub.sources))
    and (spot.source <> 'rbn' or cardinality(sub.callsigns) > 0)
    and (cardinality(sub.bands)     = 0 or spot.band     = any (sub.bands))
    and (cardinality(sub.modes)     = 0 or spot.mode     = any (sub.modes)
                                        or spot.mode_family = any (sub.modes))
    and (cardinality(sub.callsigns) = 0 or spot.callsign = any (sub.callsigns))
    and (sub.reference = '' or position(lower(sub.reference) in
           lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref))) > 0),
    false);
$$;

revoke all on function public.spot_matches(subscriptions, raw_spots) from public;

-- A subscription limited to RBN with no callsigns could never match anything.
-- A trigger rather than a check in save_subscription so the rule also covers
-- rows written any other way, and the RPC stays as it is.
create function public.subscriptions_rbn_needs_callsign()
returns trigger
language plpgsql
as $$
begin
  if new.sources = array['rbn'] and cardinality(new.callsigns) = 0 then
    raise exception 'RBN reports stations by callsign. Add at least one callsign.';
  end if;
  return new;
end;
$$;

revoke all on function public.subscriptions_rbn_needs_callsign() from public;

create trigger subscriptions_rbn_needs_callsign
  before insert or update on subscriptions
  for each row execute function public.subscriptions_rbn_needs_callsign();
