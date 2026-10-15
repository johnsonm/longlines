-- The outbound sender's database role (docs/superpowers/specs/2026-10-15-outbound-sender-design.md,
-- section 1). The sender process on Fly connects as delivery_sender through
-- the pooler and may call exactly the RPCs below, all security definer, so the
-- role needs nothing on tables or on pgmq.
--
-- Roles are cluster-wide and survive `supabase db reset`, hence the guard.
-- The role cannot log in until the hosted one-time step sets a password
-- (`alter role delivery_sender with login password ...`, session 5's
-- scripts/setup-sender-role.sql); local dev uses the stack's postgres URL.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'delivery_sender') then
    create role delivery_sender nologin;
  end if;
end;
$$;

alter role delivery_sender with nologin connection limit 4;
alter role delivery_sender set statement_timeout = '30s';
alter role delivery_sender set idle_in_transaction_session_timeout = '30s';
alter role delivery_sender set search_path = public;

grant usage on schema public to delivery_sender;

-- Sender RPC allowlist: the sender's whole database surface. Session 2 adds
-- throttle_destination(uuid, bigint[], int) and delivery_queue_stats() here
-- when it creates them. mark_deliveries_dropped and delay_deliveries stay
-- service_role only.
grant execute on function public.claim_deliveries(int, int) to delivery_sender;
grant execute on function public.mark_deliveries_sent(bigint[], bigint[]) to delivery_sender;
grant execute on function public.mark_deliveries_failed(bigint[], bigint[], text, int) to delivery_sender;
grant execute on function public.prune_push_devices(text[]) to delivery_sender;
grant execute on function public.record_push_results(text[], jsonb) to delivery_sender;
