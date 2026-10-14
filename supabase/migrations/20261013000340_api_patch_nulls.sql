-- A null in a PATCH counts as left out, as docs/API.md and the api function's
-- shape checks say. The patch was merged with ||, so {"reference": null} replaced
-- the stored reference (save_subscription read it as '') and {"name": null}
-- failed with "Give the ... a name.". jsonb_strip_nulls drops the patch's null
-- keys before the merge. A null list never gets here: the api function refuses it.
-- Same signatures as 20261013000300, so the grants carry over.

create or replace function public.patch_subscription(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Send the fields to change as a JSON object.';
  end if;
  select to_jsonb(s) - 'user_id' - 'created_at' - 'updated_at'
         || jsonb_build_object('destinations', coalesce(
              (select jsonb_agg(sd.destination_id) from subscription_destinations sd
               where sd.subscription_id = s.id), '[]'::jsonb))
  into v_current
  from subscriptions s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if v_current is null then
    raise exception 'Subscription not found.';
  end if;
  perform public.save_subscription(v_current || (jsonb_strip_nulls(p_patch) - 'id'));
end;
$$;

create or replace function public.patch_callsign_group(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Send the fields to change as a JSON object.';
  end if;
  select jsonb_build_object('id', g.id, 'name', g.name, 'callsigns', coalesce(
           (select jsonb_agg(m.callsign) from callsign_group_members m where m.group_id = g.id), '[]'::jsonb))
  into v_current
  from callsign_groups g
  where g.id = p_id and g.user_id = auth.uid()
  for update;
  if v_current is null then
    raise exception 'Group not found.';
  end if;
  perform public.save_callsign_group(v_current || jsonb_strip_nulls(p_patch));
end;
$$;
