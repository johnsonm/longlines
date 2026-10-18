-- A plain line links the callsign to its profile only when the escaped call
-- has no '[' or ']'. Discord's masked-link text ignores backslash escapes, so
-- an unbalanced '\[' (DX Cluster takes any run without spaces as a call, such
-- as 'K1ABC/[') makes Discord show the whole '[..](..)' as literal text. Such
-- a call is written as plain (bold) text, as when it is not safe in a URL.
-- Otherwise discord_plain_line is unchanged from 20261018000100.
create or replace function public.discord_plain_line(p_settings discord_destination_settings, p_values jsonb, p_spot jsonb,
                                          p_max int default 190)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out    text := '';
  v_url    text := public.discord_profile_url(p_spot);
  v_field  text;
  v_value  text;
  v_prefix text;
  v_link   text;
  v_bold   text;
  v_lead   text;
  v_room   int;
  v_cut    boolean := false;
begin
  foreach v_field in array coalesce(p_settings.line_fields, '{}') loop
    v_value := p_values ->> v_field;
    continue when v_value is null;
    v_prefix := case when p_settings.show_field_names then public.push_field_label(v_field) || ': ' else '' end;
    v_link := case when v_field = 'callsign' and v_value !~ '[][]' then v_url end;
    v_bold := case when v_out = '' and p_settings.bold_first then '**' else '' end;
    v_lead := case when v_out = '' then '' else public.push_separator(p_settings.separator) end;
    -- Room for the value once the separator, bold, label and link are counted.
    v_room := p_max - length(v_out) - length(v_lead) - 2 * length(v_bold) - length(v_prefix)
              - coalesce(length(v_link) + 4, 0);
    if v_room < 2 and v_link is not null then
      v_room := v_room + length(v_link) + 4;
      v_link := null;
    end if;
    if v_room < 2 then
      -- Not even a clipped value fits: mark the cut after the last whole item.
      if v_out <> '' and length(v_out) < p_max then
        v_out := v_out || '…';
      end if;
      exit;
    end if;
    if length(v_value) > v_room then
      v_value := public.discord_clip(v_value, v_room);
      v_cut := true;
    end if;
    v_out := v_out || v_lead || v_bold || v_prefix
             || case when v_link is null then v_value else '[' || v_value || '](' || v_link || ')' end
             || v_bold;
    exit when v_cut;
  end loop;
  if v_out = '' then
    return public.discord_clip(public.discord_escape(p_spot ->> 'callsign'), p_max);
  end if;
  return v_out;
end;
$$;

revoke all on function public.discord_plain_line(discord_destination_settings, jsonb, jsonb, int) from public;
