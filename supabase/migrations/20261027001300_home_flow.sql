-- The Home page's diagram (the "Long Lines home" canvas) draws the caller's configuration, and
-- this gives it the two things the web app can't read itself: the counts for the caller's last 24
-- hours of deliveries (the only record of a match), and which sources each connection takes spots
-- from. Names, types and destination links come from the tables the web app already reads. It
-- returns no spot data and stays out of api_call (the management API is configuration only).
--
-- subscription_sources is every (connection, source) pair the matcher would let through, decided
-- by its own predicates: source_matches (an empty list is "any" of POTA, SOTAwatch and RBN) and,
-- for RBN, an AND group that names stations, as in spot_matches. The source list is
-- normalize_subscription_sources'; a new source goes in both.
--
-- What the numbers can and cannot say:
--   * A connection with no enabled destination, or a disabled one, makes no deliveries
--     (match_pending_spots skips it), so it has no count here; the page shows an en dash.
--   * deliveries is unique on (destination_id, spot_id): a spot two connections match for one
--     destination counts once, for the connection the matcher credited.
--   * Spots a quiet window held back are not counted.
--
-- matched is distinct spots by created_at, delivered is sent rows by sent_at, both within 24
-- hours, so one spot sent to two destinations is one matched and two delivered. The shape is
-- HomeFlow in web/src/home/types.ts, pinned by supabase/tests/home_flow.test.sql.

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
      cross join unnest(array['pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster']) as src(source)
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
