-- The web app's address is the apex domain, https://longlines.io; there is no
-- app subdomain. Links that leave the app (Discord profile links) go through this knob, so
-- this is the only change; nothing stores its result. Otherwise app_site_url is
-- unchanged from 20261018000100; create or replace keeps its grants (none
-- beyond the owner and service_role).
create or replace function public.app_site_url()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'https://longlines.io';
$$;
