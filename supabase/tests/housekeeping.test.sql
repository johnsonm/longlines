-- pgTAP: run_housekeeping (20261006000009, 20261017004010, 20261019000540)
-- prunes ingest_failures 30 days after they were last seen and
-- subscription_quiet after an hour (cron.job_run_details and Send test
-- windows: review_fixes.test.sql).
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

\ir helpers/users.psql

delete from ingest_failures;
insert into ingest_failures (source, occurred_at, error, raw_payload) values
  ('pota', now() - interval '31 days', 'old', '{"id": 1}'),
  ('pota', now() - interval '29 days', 'recent', '{"id": 2}');

insert into subscriptions (id, user_id, name)
values ('00000000-0000-0000-0000-00000000a5e1', '11111111-1111-1111-1111-111111111111', 'hk');
insert into subscription_quiet (subscription_id, callsign, last_sent_at) values
  ('00000000-0000-0000-0000-00000000a5e1', 'W1OLD', now() - interval '61 minutes'),
  ('00000000-0000-0000-0000-00000000a5e1', 'W1NEW', now() - interval '59 minutes');

select lives_ok('select run_housekeeping()', 'run_housekeeping runs');
select results_eq('select error from ingest_failures', array['recent'],
  'ingest_failures older than 30 days are deleted');
select results_eq(
  $$select callsign from subscription_quiet where subscription_id = '00000000-0000-0000-0000-00000000a5e1'$$,
  array['W1NEW'], 'subscription_quiet rows sent more than an hour ago are deleted');
select ok(not has_function_privilege('authenticated', 'public.run_housekeeping()', 'execute'),
  'clients cannot call run_housekeeping');

select * from finish();
rollback;
