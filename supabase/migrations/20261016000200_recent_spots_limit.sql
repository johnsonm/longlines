-- list_recent_spots clamps max_rows.
--
-- `limit max_rows` with a null max_rows is no limit, so any signed-in user
-- could make the RBN arm sort and format a whole day of rbn_spots (~1.5M
-- rows). max_rows is now clamped to 0..200, and null means the default of 50.
-- The web asks for 100 (loadRecentSpots in web/src/lib/api.ts).
--
-- As in 20261015001000 otherwise. Same signature and return type, so create or
-- replace keeps the grant (authenticated only); it is restated below anyway.
create or replace function public.list_recent_spots(p_source text, max_rows int)
returns setof recent_spots
language sql
stable
security definer
set search_path = public
as $$
  (select * from recent_spots
   where p_source <> 'rbn' and source = p_source
   order by spot_time desc
   limit least(greatest(coalesce(max_rows, 50), 0), 200))
  union all
  (select null::bigint, r.spot_time, r.callsign, r.spotter, r.frequency_khz, r.band, r.mode, r.mode_family,
          format('%s dB %s %s %s', r.snr, r.speed, r.speed_unit, r.spot_type),
          null, null, null, null, null, null, 'rbn'
   from rbn_spots r
   where p_source = 'rbn' and r.spot_time > now() - interval '24 hours'
   order by r.spot_time desc
   limit least(greatest(coalesce(max_rows, 50), 0), 200));
$$;

revoke all on function public.list_recent_spots(text, int) from public, anon, authenticated;
grant execute on function public.list_recent_spots(text, int) to authenticated;
