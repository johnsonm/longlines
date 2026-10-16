-- Sender cleanup (outbound sender, session 6). The Edge `deliver` function is
-- deleted in the same PR (`supabase functions delete deliver` by hand), and
-- these two RPCs were its alone: the sender throttles a 429 with
-- throttle_destination, and the expiry sweep inside claim_deliveries is the
-- only thing that drops a delivery. Their service_role grants go with them.
drop function if exists public.delay_deliveries(bigint[], int);
drop function if exists public.mark_deliveries_dropped(bigint[], bigint[]);
