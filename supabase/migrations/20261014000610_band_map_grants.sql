-- 20261014000600 left the band map functions to the default privileges for
-- service_role. Those hold where postgres creates the function (a fresh local
-- database) but not on a preview branch, where the band-map function got
-- "permission denied for function cached_band_map". Grant them outright, as
-- the other service-role RPCs do.
grant execute on function public.cached_band_map() to service_role;
grant execute on function public.band_map_snapshot() to service_role;
