-- A new URL starts the destination's health over. Failures counted against the
-- old URL said nothing about the new one, yet a failing destination stayed
-- "Failing" (and skipped by Get alerts) until a spot was delivered, and the
-- next failure counted on from where the old URL left off. A paused
-- destination stays paused; only a delivery or the user un-pauses it.
-- Same signature as 20261013000300, so its grants carry over.
create or replace function public.update_destination(p_id uuid, p_name text, p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_type text;
  v_url  text;
  v_new  boolean;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type, d.url into v_type, v_url from destinations d where d.id = p_id and d.user_id = v_user for update;
  if v_type is null then
    raise exception 'Destination not found.';
  end if;
  if p_name is not null and trim(p_name) = '' then
    raise exception 'Give the destination a name.';
  end if;
  if p_url is not null then
    perform public.validate_destination_url(v_type, p_url);
  end if;
  v_new := p_url is not null and trim(p_url) is distinct from v_url;
  update destinations d
  set name                 = coalesce(trim(p_name), d.name),
      url                  = coalesce(trim(p_url), d.url),
      url_display          = coalesce(public.destination_url_display(v_type, p_url), d.url_display),
      health               = case when v_new and d.health = 'failing' then 'ok' else d.health end,
      consecutive_failures = case when v_new then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end
  where d.id = p_id;
end;
$$;
