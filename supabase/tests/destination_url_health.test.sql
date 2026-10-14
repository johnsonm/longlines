-- pgTAP: a new destination URL starts its health over (20261013000320).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(8);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as
  select id from create_destination('discord', 'Club', 'https://discord.com/api/webhooks/1/old');
create temp table p as
  select id from create_destination('discord', 'Paused', 'https://discord.com/api/webhooks/2/old');
grant all on d, p to authenticated;

-- Seven failures against the old URL; another destination is paused.
reset role;
update destinations set health = 'failing', consecutive_failures = 7, last_error = 'HTTP 404', last_error_at = now()
where id = (select id from d);
update destinations set health = 'paused', consecutive_failures = 2, last_error = 'HTTP 500', last_error_at = now()
where id = (select id from p);
-- update_destination is not granted to clients (api_call runs it), so call it
-- as the owner with user 1's claims still set.

-- A rename alone keeps the record.
select update_destination((select id from d), 'Club spots', null);
select is((select health from destinations where id = (select id from d)), 'failing', 'a rename keeps the health');

-- The same URL again changes nothing.
select update_destination((select id from d), null, 'https://discord.com/api/webhooks/1/old');
select is((select consecutive_failures from destinations where id = (select id from d)), 7,
  'resending the same URL keeps the failure count');

select update_destination((select id from d), null, 'https://discord.com/api/webhooks/1/new');
select is((select health from destinations where id = (select id from d)), 'ok', 'a new URL clears failing');
select is((select consecutive_failures from destinations where id = (select id from d)), 0, 'and the failure count');
select is((select last_error from destinations where id = (select id from d)), null, 'and the last error');
select is((select last_error_at from destinations where id = (select id from d)), null, 'and when it happened');

select update_destination((select id from p), null, 'https://discord.com/api/webhooks/2/new');
select is((select health from destinations where id = (select id from p)), 'paused', 'a paused destination stays paused');
select is((select consecutive_failures from destinations where id = (select id from p)), 0,
  'but its failure count starts over');

select * from finish();
rollback;
