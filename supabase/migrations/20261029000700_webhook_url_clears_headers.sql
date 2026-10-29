-- A webhook's new URL clears its extra headers.
--
-- Header values never leave Vault toward a client (the editor and the API get
-- names only), but update_destination changed the URL and kept the headers,
-- so the next delivery or Send test carried the stored values (often a bearer
-- token for the user's own receiver) to whatever host the URL now named. A
-- leaked write-scope API token or a hijacked session could read them that way.
--
-- update_destination now deletes a webhook's headers when its URL changes (the
-- same v_new that resets health); the drop trigger deletes their Vault
-- secrets. save_webhook_destination calls set_webhook_headers after
-- update_destination, so the editor re-enters values in the same save, and an
-- item without a value is refused ("Give the {name} header a value.") and rolls
-- the URL change back. The API's PATCH with a url clears them for good; it never
-- sets headers. No signature, result column or grant changes.

-- As in 20261021000600, plus the header delete on a webhook's URL change.
create or replace function public.update_destination(p_id uuid, p_name text, p_url text, p_enabled boolean default null)
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
  v_resume boolean;
  v_constraint text;
  v_dropped bigint[];
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type, d.url, coalesce(p_enabled, false) and d.auto_disabled_at is not null
    into v_type, v_url, v_resume
  from destinations d where d.id = p_id and d.user_id = v_user for update;
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
      url_generation       = case when v_new then d.url_generation + 1 else d.url_generation end,
      enabled              = coalesce(p_enabled, d.enabled),
      health               = case when v_new and d.health = 'failing' then 'ok' else d.health end,
      consecutive_failures = case when v_new or v_resume then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end,
      auto_disabled_at     = case when v_resume then null else d.auto_disabled_at end,
      pause_failures       = case when v_resume then 0 else d.pause_failures end,
      pause_failure_at     = case when v_resume then null else d.pause_failure_at end
  where d.id = p_id;

  -- Stored header values were meant for the old host.
  if v_new and v_type = 'webhook' then
    delete from webhook_destination_headers h where h.destination_id = p_id;
  end if;

  -- The pause lost what was queued; the claim's unwanted sweep drops it the
  -- same way (status, dropped_at, archived message).
  if v_resume then
    with dropped as (
      update deliveries d
      set status = 'dropped', dropped_at = now()
      where d.destination_id = p_id and d.status in ('pending', 'failed')
      returning d.id
    )
    select array_agg(dropped.id) into v_dropped from dropped;
    if v_dropped is not null then
      perform pgmq.archive('deliveries_queue', array(
        select q.msg_id from pgmq.q_deliveries_queue q
        where (q.message ->> 'delivery_id')::bigint = any (v_dropped)));
    end if;
  end if;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'destinations_user_name_key' then
    raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
  end if;
  raise;
end;
$$;
