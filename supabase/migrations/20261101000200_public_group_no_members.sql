-- The public group page never carries the members table: a club may not want
-- its whole roster on a link anyone can open. The top lists and who activated
-- each place still show when the owner shows callsigns; without them the page
-- is redacted as before (group_stats_redact). The owner's page is unchanged.
create or replace function public.public_group_statistics(p_slug text, p_period text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_name    text;
  v_show    boolean;
  v_payload jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z2-7]{10}$' then
    return null;
  end if;
  if p_period is null or p_period not in ('7d', '30d') then
    raise exception 'Not a valid period.';
  end if;
  select g.id, g.name, g.show_callsigns into v_id, v_name, v_show
  from callsign_groups g
  where g.public_slug = p_slug and g.public;
  if v_id is null then
    return null;
  end if;
  v_payload := public.cached_group_statistics(v_id, p_period) - 'members';
  if not v_show then
    v_payload := public.group_stats_redact(v_payload);
  end if;
  return v_payload || jsonb_build_object('group', jsonb_build_object(
    'name', v_name, 'member_count', (v_payload ->> 'memberCount')::int, 'show_callsigns', v_show));
end;
$$;

revoke all on function public.public_group_statistics(text, text) from public;
grant execute on function public.public_group_statistics(text, text) to service_role;
