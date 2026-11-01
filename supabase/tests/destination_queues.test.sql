-- pgTAP: per-destination queue figures and Clear queue (20261031000400):
-- destination_queue_status (the operator's view), list_destination_queues
-- (backed_up decided by the two knobs) and clear_destination_queue (drops
-- only visible waiting rows, with dropped_at null, and archives their
-- messages).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(23);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table busy as select id from create_destination('webhook', 'Busy', 'https://busy.example.com/spots');
create temp table old as select id from create_destination('webhook', 'Old', 'https://old.example.com/spots');
create temp table off as select id from create_destination('webhook', 'Off', 'https://off.example.com/spots');
create temp table empty as select id from create_destination('webhook', 'Empty', 'https://empty.example.com/spots');
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from busy), (select id from old), (select id from off)]));
reset role;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table theirs as select id from create_destination('webhook', 'Theirs', 'https://theirs.example.com/spots');
select save_subscription(jsonb_build_object('name', 'mine', 'quiet_minutes', 0,
  'destinations', array[(select id from theirs)]));
reset role;

select count(*) from ingest_spots((
  select jsonb_agg(jsonb_build_object('source', 'pota', 'source_spot_id', 'q' || i, 'content_hash', 'h' || i,
    'spot_time', now(), 'callsign', 'KK4PWJ', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '',
    'pota_reference', 'US-2763', 'pota_location', 'US-NC', 'raw_payload', '{}'::jsonb))
  from generate_series(1, 100) i));
select pgmq.purge_queue('spot_events');
create temp table spots as select id, row_number() over (order by id) as n from raw_spots;

-- Inserts deliveries for a destination and queues a message for each.
create function pg_temp.queue(p_dest uuid, p_from int, p_to int, p_status text, p_created timestamptz,
                              p_dropped timestamptz)
returns void language sql as $$
  with ins as (
    insert into deliveries (subscription_id, destination_id, spot_id, status, created_at, dropped_at)
    select (select sd.subscription_id from subscription_destinations sd where sd.destination_id = p_dest),
           p_dest, s.id, p_status, p_created, p_dropped
    from spots s where s.n between p_from and p_to
    returning id
  )
  select pgmq.send_batch('deliveries_queue', array_agg(jsonb_build_object('delivery_id', ins.id) order by ins.id))
  from ins where p_status in ('pending', 'failed');
$$;

-- Busy: 98 pending and one failed row, fresh. Old: one waiting row 11 minutes
-- old, plus rows dropped an hour ago (loss), two days ago and as unwanted, and
-- a sent one. Off: one 11-minute-old row, disabled. Theirs: user 2's.
select pg_temp.queue((select id from busy), 1, 98, 'pending', now(), null);
select pg_temp.queue((select id from busy), 99, 99, 'failed', now(), null);
select pg_temp.queue((select id from old), 1, 1, 'pending', now() - interval '11 minutes', null);
select pg_temp.queue((select id from old), 2, 2, 'dropped', now() - interval '2 hours', now() - interval '1 hour');
select pg_temp.queue((select id from old), 3, 3, 'dropped', now() - interval '3 days', now() - interval '2 days');
select pg_temp.queue((select id from old), 4, 4, 'dropped', now() - interval '2 hours', null);
select pg_temp.queue((select id from old), 5, 5, 'sent', now() - interval '2 hours', null);
select pg_temp.queue((select id from off), 1, 1, 'pending', now() - interval '11 minutes', null);
select pg_temp.queue((select id from theirs), 1, 1, 'pending', now(), null);
update destinations set enabled = false where id = (select id from off);

-- ---------------------------------------------------------------------------
-- destination_queue_status
-- ---------------------------------------------------------------------------

select results_eq($$ select name, enabled, waiting, oldest_waiting_seconds, dropped_24h
                     from destination_queue_status
                     where user_id = '11111111-1111-1111-1111-111111111111'
                     order by name $$,
  $$ values ('Busy'::text, true, 99, 0, 0), ('Empty', true, 0, null, 0), ('Off', false, 1, 660, 0),
            ('Old', true, 1, 660, 1) $$,
  'the view counts waiting rows, the oldest one''s age and the rows lost in 24 hours');
select ok(not has_table_privilege('anon', 'destination_queue_status', 'select')
          and not has_table_privilege('authenticated', 'destination_queue_status', 'select'),
  'clients cannot read the view');
select ok(has_table_privilege('service_role', 'destination_queue_status', 'select'),
  'the service role reads the view');

-- ---------------------------------------------------------------------------
-- list_destination_queues
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '', true);
select throws_ok($$ select * from list_destination_queues() $$, 'Not signed in.');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select results_eq($$ select q.waiting, q.oldest_waiting_seconds, q.dropped_24h, q.backed_up
                     from list_destination_queues() q join destinations d on d.id = q.destination_id
                     order by d.name $$,
  $$ values (99, 0, 0, false), (0, null, 0, false), (1, 660, 0, false), (1, 660, 1, true) $$,
  'the owner gets each destination''s figures: 99 waiting is not backed up, an 11-minute-old row is, a disabled destination never is');
reset role;
select pg_temp.queue((select id from busy), 100, 100, 'pending', now(), null);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select backed_up from list_destination_queues() where destination_id = (select id from busy)), true,
  '100 waiting is backed up');
select is((select count(*) from list_destination_queues() where destination_id = (select id from theirs)), 0::bigint,
  'another user''s destination is not listed');
reset role;
-- An operator's pause (health = 'paused') leaves enabled on; the claim drops its rows as unwanted.
update destinations set health = 'paused' where id = (select id from busy);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select backed_up from list_destination_queues() where destination_id = (select id from busy)), false,
  'a destination an operator paused is never backed up');
reset role;
update destinations set health = 'ok' where id = (select id from busy);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select results_eq($$ select destination_id, waiting from list_destination_queues() $$,
  $$ select (select id from theirs), 1 $$, 'each user sees only their own destinations');
reset role;
select is(public.destination_backlog_waiting(), 100, 'the waiting knob is 100 rows');
select is(public.destination_backlog_age(), interval '10 minutes', 'the age knob is 10 minutes');

-- ---------------------------------------------------------------------------
-- clear_destination_queue
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '', true);
select throws_ok(format($$ select clear_destination_queue('%s') $$, (select id from busy)), 'Not signed in.');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select clear_destination_queue('%s') $$, (select id from busy)), 'Destination not found.');
select throws_ok($$ select clear_destination_queue('0e7db3d0-52fa-4690-8f4a-79e468d6cf67') $$, 'Destination not found.');
reset role;

-- One of Busy's 100 rows is in flight: its message is hidden for 50 s more.
create temp table in_flight as
  select d.id, q.msg_id from deliveries d
  join pgmq.q_deliveries_queue q on (q.message ->> 'delivery_id')::bigint = d.id
  where d.destination_id = (select id from busy) and d.spot_id = (select id from spots where n = 50);
update pgmq.q_deliveries_queue set vt = clock_timestamp() + interval '50 seconds'
  where msg_id = (select msg_id from in_flight);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(clear_destination_queue((select id from busy)), 99, 'clear drops the 99 visible rows and returns the count');
reset role;
select results_eq($$ select status, dropped_at, count(*) from deliveries
                     where destination_id = (select id from busy) and id <> (select id from in_flight)
                     group by 1, 2 $$,
  $$ values ('dropped'::text, null::timestamptz, 99::bigint) $$,
  'the cleared rows are dropped with dropped_at null, the failed one included');
select is((select count(*) from pgmq.a_deliveries_queue a
           join deliveries d on d.id = (a.message ->> 'delivery_id')::bigint
           where d.destination_id = (select id from busy)), 99::bigint, 'their messages are archived');
select is((select status from deliveries where id = (select id from in_flight)), 'pending',
  'a row whose message is hidden stays waiting');
select results_eq($$ select (q.message ->> 'delivery_id')::bigint from pgmq.q_deliveries_queue q
                     join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
                     where d.destination_id = (select id from busy) $$,
  $$ select id from in_flight $$, 'and keeps its message');
select results_eq($$ select status, count(*) from deliveries where destination_id <> (select id from busy)
                     and status in ('pending', 'failed') group by 1 $$,
  $$ values ('pending'::text, 3::bigint) $$, 'other destinations'' rows are untouched');
select is((select dropped_24h from destination_queue_status where destination_id = (select id from busy)), 0,
  'cleared rows do not count as lost');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(clear_destination_queue((select id from busy)), 0, 'a second clear finds nothing to drop');
select is((select waiting from list_destination_queues() where destination_id = (select id from busy)), 1,
  'the in-flight row is still waiting');
reset role;

select * from finish();
rollback;
