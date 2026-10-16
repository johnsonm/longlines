-- throttle_destination caps the hold at a day.
--
-- p_seconds is the response's Retry-After, which a destination chooses: a huge
-- value would hide the destination and its messages for years. The hold is
-- now at most 86400 seconds (a day, the longest destination_max_age, so a
-- longer hold could only end in the expiry sweep). Null still means
-- destination_throttle_seconds at the new level, which is far below the cap.
--
-- As in 20261015000400 otherwise. Same signature, so create or replace keeps
-- the grants (service_role, delivery_sender).
create or replace function public.throttle_destination(p_destination_id uuid, p_msg_ids bigint[], p_seconds int)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  c_max_seconds constant int := 86400;
  v_seconds int;
begin
  update destinations dest
  set throttle_level = dest.throttle_level + 1,
      throttled_until = now() + make_interval(secs =>
        least(c_max_seconds,
              greatest(1, coalesce(p_seconds, public.destination_throttle_seconds(dest.throttle_level + 1)))))
  where dest.id = p_destination_id
  returning extract(epoch from dest.throttled_until - now())::int into v_seconds;
  if v_seconds is null then
    raise exception 'Destination not found.';
  end if;
  perform pgmq.set_vt('deliveries_queue', m, v_seconds) from unnest(p_msg_ids) as m;
  return v_seconds;
end;
$$;
