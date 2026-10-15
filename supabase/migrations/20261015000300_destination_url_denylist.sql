-- SSRF: refuse webhook hostnames under suffixes that only resolve inside a
-- private network (spec section 7). The sender will run on Fly, where
-- *.internal and *.flycast name other Fly apps; .local, .localdomain and
-- .home.arpa are mDNS and home-network names; the rest of .arpa is reverse
-- DNS. The same list is DENIED_HOST_SUFFIXES in
-- supabase/functions/_shared/delivery/urlsafety.ts; change both together.
--
-- Same as 20261014000100 plus the suffix list and a trailing-dot strip, so
-- `api.internal.` cannot slip past the suffix match.
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
    if public.is_private_host(v_host)
       or v_host like any (array['%.internal', '%.flycast', '%.local', '%.localdomain', '%.home.arpa', '%.arpa'])
    then
      raise exception 'That address is not allowed.';
    end if;
  end if;
end;
$$;

revoke all on function public.validate_destination_url(text, text) from public, anon, authenticated;
