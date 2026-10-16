-- pgTAP: the web's on/off switch is a direct update of subscriptions.enabled,
-- so the RBN trigger runs as the client. PL/pgSQL checks a trigger's function
-- grants once per transaction, the first time it fires, so the client must be
-- the first to fire it here: the setup insert skips triggers.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(3);

set local session_replication_role = replica;
create temp table sub as
with ins as (
  insert into subscriptions (user_id, name, enabled, sources, rules, quiet_minutes)
  values ('11111111-1111-1111-1111-111111111111', 'toggle', true, '{}', '[]', 0)
  returning id
)
select id from ins;
grant select on sub to authenticated;
set local session_replication_role = origin;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok($$ update subscriptions set enabled = false where id = (select id from sub) $$,
  'a client can switch its subscription off');
select is((select enabled from subscriptions where id = (select id from sub)), false,
  'the switch turned it off');
reset role;

select ok((select prosecdef from pg_proc where oid = 'public.subscriptions_rbn_needs_callsign'::regproc),
  'the RBN trigger runs as its owner, so clients need no grant on its helpers');

select * from finish();
rollback;
