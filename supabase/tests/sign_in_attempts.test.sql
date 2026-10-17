-- pgTAP: sign-in rate limiting per (identifier, client), failures only
-- (begin_sign_in_attempt / forget_sign_in_attempt). Grants are checked in
-- readmodels_auth.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

delete from sign_in_attempts;

-- Ten attempts by one client are allowed; the eleventh is refused and not logged.
select ok((select bool_and(begin_sign_in_attempt(' KK4PWJ ', 'attacker') is not null)
           from generate_series(1, 10)), 'ten attempts per client are logged');
select is(begin_sign_in_attempt('kk4pwj', 'attacker'), null,
  'the eleventh attempt by that client is refused, case-insensitively');
select is((select count(*)::int from sign_in_attempts where identifier = 'kk4pwj'), 10,
  'a refused attempt is not logged');

-- Another client is not locked out by the first.
select isnt(begin_sign_in_attempt('KK4PWJ', 'owner'), null,
  'another client can still try the same identifier');

-- A forgotten attempt (right password) does not count.
delete from sign_in_attempts where client = 'owner';
select ok((select bool_and(f is not null) from (
  select begin_sign_in_attempt('W1AW', 'owner') as f from generate_series(1, 10)) s),
  'setup: ten attempts by the owner');
do $$
begin
  perform forget_sign_in_attempt(id) from sign_in_attempts where identifier = 'w1aw';
end;
$$;
select is((select count(*)::int from sign_in_attempts where identifier = 'w1aw'), 0,
  'forget_sign_in_attempt removes the row');
select isnt(begin_sign_in_attempt('W1AW', 'owner'), null,
  'forgotten attempts leave the client under its limit');

-- Attempts older than 15 minutes fall out of the window.
update sign_in_attempts set attempted_at = now() - interval '16 minutes' where client = 'attacker';
select isnt(begin_sign_in_attempt('KK4PWJ', 'attacker'), null, 'old attempts do not count');

-- The identifier ceiling: 100 from all clients in the window.
delete from sign_in_attempts;
insert into sign_in_attempts (identifier, client)
select 'n0call', 'c' || g from generate_series(1, 99) g;
select isnt(begin_sign_in_attempt('N0CALL', 'fresh'), null, 'the hundredth attempt is logged');
select is(begin_sign_in_attempt('N0CALL', 'another'), null,
  'past 100 attempts on an identifier every client is refused');
select isnt(begin_sign_in_attempt('K1ABC', 'another'), null, 'other identifiers are unaffected');

select * from finish();
rollback;
