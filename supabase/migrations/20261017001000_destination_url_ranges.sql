-- Webhook URL checks catch up with what the sender's URL parser and
-- urlsafety.ts see (code review, 2026-10-17). The sender still refuses these
-- at send time; this is the first layer, so a user is told at save time.
--
-- 1. A host whose last label is a number is an IPv4 address to a WHATWG URL
--    parser: 2130706433, 127.1, 0x7f000001 and 017700000001 are all
--    127.0.0.1. Only a canonical dotted quad is judged; any other numeric
--    form is refused rather than guessed at.
-- 2. Userinfo (user@host), and a backslash, percent sign, space or control
--    character in the host, which the parser reads differently than
--    parse_https_url does (it treats \ as /, percent-decodes and strips
--    tabs), are refused.
-- 3. The same special ranges as PRIVATE_IPV4 and isPrivateIp in
--    _shared/delivery/urlsafety.ts: 192.0.0.0/24, 198.18.0.0/15 and
--    224.0.0.0/3 (multicast, 240/4 and broadcast); IPv6 site-local
--    fec0::/10, multicast ff00::/8, discard 100::/64 and local-use NAT64
--    64:ff9b:1::/48; and the IPv4 inside IPv4-compatible ::/96, NAT64
--    64:ff9b::/96 and 6to4 2002::/16 is judged like the mapped ::ffff:0:0/96.
--    Change both lists together.
--
-- Only create_destination, update_destination and the API run these, so
-- stored destinations are untouched. Same signatures as before, so grants
-- carry over.

create or replace function public.is_private_host(p_host text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ip inet;
  v_b  bytea;
begin
  if p_host = 'localhost' or p_host like '%.localhost' then
    return true;
  end if;
  if p_host ~ '(^|\.)([0-9]+|0x[0-9a-f]*)\.?$' then
    -- Ends in a number, so a URL parser reads it as IPv4.
    if p_host !~ '^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$' then
      return true; -- not a canonical dotted quad: refuse rather than guess
    end if;
    v_ip := p_host::inet;
  elsif p_host like '%:%' then
    begin
      v_ip := p_host::inet;
    exception when others then
      return true; -- unparseable literal: refuse rather than guess
    end;
    if v_ip <<= any (array['64:ff9b:1::/48', '100::/64', 'fc00::/7', 'fe80::/10', 'fec0::/10',
                           'ff00::/8']::inet[]) then
      return true;
    end if;
    -- inet_send: family, bits, is_cidr, length, then the 16 address bytes.
    v_b := inet_send(v_ip);
    if v_ip <<= any (array['::/96', '::ffff:0.0.0.0/96', '64:ff9b::/96']::inet[]) then
      v_ip := (get_byte(v_b, 16)::text || '.' || get_byte(v_b, 17)::text || '.' || get_byte(v_b, 18)::text || '.' || get_byte(v_b, 19)::text)::inet;
    elsif v_ip <<= '2002::/16'::inet then
      v_ip := (get_byte(v_b, 6)::text || '.' || get_byte(v_b, 7)::text || '.' || get_byte(v_b, 8)::text || '.' || get_byte(v_b, 9)::text)::inet;
    else
      return false;
    end if;
  else
    return false;
  end if;
  return v_ip <<= any (array[
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3'
  ]::inet[]);
end;
$$;

revoke all on function public.is_private_host(text) from public, anon, authenticated;

-- Same as 20261015000300 plus the userinfo and host-character refusal.
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
       or public.is_private_host(v_host)
       or v_host like any (array['%.internal', '%.flycast', '%.local', '%.localdomain', '%.home.arpa', '%.arpa'])
    then
      raise exception 'That address is not allowed.';
    end if;
  end if;
end;
$$;

revoke all on function public.validate_destination_url(text, text) from public, anon, authenticated;
