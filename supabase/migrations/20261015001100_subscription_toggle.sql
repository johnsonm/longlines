-- The web's on/off switch updates subscriptions.enabled directly, so the RBN
-- trigger runs as the client. Since 20261014000500 it calls rules_name_stations,
-- which clients may not execute, and every switch failed with "permission denied
-- for function rules_name_stations" (PL/pgSQL checks the grant whether or not the
-- row is RBN-only). Running the trigger as its owner keeps the helper ungranted.
-- Its search_path is already pinned to '' and clients have no execute on it.
alter function public.subscriptions_rbn_needs_callsign() security definer;
