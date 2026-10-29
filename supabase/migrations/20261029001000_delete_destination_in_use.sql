-- A destination can be deleted while connections send to it. Its links go with it, and a
-- connection left with none stays saved and waits for a destination, as one saved with none does
-- (match_pending_spots and watched_among skip it). The web asks first and names those connections.
alter table subscription_destinations
  drop constraint subscription_destinations_destination_id_fkey,
  add constraint subscription_destinations_destination_id_fkey
    foreign key (destination_id) references destinations (id) on delete cascade;

-- delete_destination: 20261021000500's without the foreign_key_violation handler, which can no
-- longer fire. The API's LL409 stays for groups.
create or replace function public.delete_destination(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from destinations d where d.id = p_id and d.user_id = auth.uid();
  if not found then
    raise exception 'Destination not found.';
  end if;
end;
$$;
