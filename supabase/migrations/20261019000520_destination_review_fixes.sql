-- Review fixes for destinations (REVIEW.md, "Database: destinations, ...").
--
-- 1. validate_destination_url refuses a webhook host with any non-ASCII
--    character. WHATWG URL parsing (the sender's `new URL()`) applies UTS 46
--    first, so fullwidth digits, ideographic full stops and fullwidth names
--    (`１２７.０.０.１`, `127。0。0。1`, `ｌｏｃａｌｈｏｓｔ`, `foo.ｉｎｔｅｒｎａｌ`) become
--    loopback or denied names that the ASCII checks here never saw. An IDN
--    host must be entered as punycode (xn--...). The sender still checks the
--    parsed hostname (urlsafety.ts), so this restores the save-time layer.
-- 2. update_destination's resume (enabled on while auto_disabled_at is set)
--    drops what is still queued for the destination, in the same
--    transaction, as the claim's unwanted sweep would have: status dropped,
--    dropped_at now (the pause lost those spots) and the queue messages
--    archived. Before, rows the sweep had not reached yet (it takes 500 per
--    claim across all destinations) went out as a burst after the resume.

-- As in 20261017001000, plus the non-ASCII host check.
create or replace function public.validate_destination_url(p_type text, p_url text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[];
  v_host text;
begin
  if p_type not in ('discord', 'webhook', 'push') then
    raise exception 'Unknown destination type.';
  end if;
  if p_type = 'push' then
    if p_url is not null then
      raise exception 'Push notifications don''t use a URL.';
    end if;
    return;
  end if;
  v_parts := public.parse_https_url(p_url);
  if v_parts is null then
    raise exception 'Use an https URL.';
  end if;
  if p_type = 'discord' then
    if v_parts[1] not in ('discord.com', 'discordapp.com') or v_parts[3] not like '/api/webhooks/%' then
      raise exception 'Use a Discord webhook URL.';
    end if;
  else
    v_host := rtrim(v_parts[1], '.');
    if v_host ~ '[@\\%[:space:][:cntrl:]]'
       or v_host ~ '[^\x01-\x7f]'
       or public.is_private_host(v_host)
       or v_host like any (array['%.internal', '%.flycast', '%.local', '%.localdomain', '%.home.arpa', '%.arpa'])
    then
      raise exception 'That address is not allowed.';
    end if;
  end if;
end;
$$;

-- As in 20261018000300, plus the drop of the queue on resume.
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
      enabled              = coalesce(p_enabled, d.enabled),
      health               = case when v_new and d.health = 'failing' then 'ok' else d.health end,
      consecutive_failures = case when v_new or v_resume then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end,
      auto_disabled_at     = case when v_resume then null else d.auto_disabled_at end,
      pause_failures       = case when v_resume then 0 else d.pause_failures end,
      pause_failure_at     = case when v_resume then null else d.pause_failure_at end
  where d.id = p_id;

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
