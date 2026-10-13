-- pgTAP: FCC license loads (20261012000050). Batches stage, finish checks the
-- counts, apply swaps the staged set into callsign_licenses in one go, and
-- clients can read none of it (20261012000070: licenses reach them only
-- through callsign_profile, which honors hidden_callsigns).
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

delete from callsign_licenses;
delete from license_loads;

-- Last week's set: one call that this load drops, one it replaces.
insert into callsign_licenses (callsign, authority, name, status, country, loaded_at) values
  ('W1OLDS', 'FCC', 'Gone Away', 'Active', 'US', now() - interval '7 days'),
  ('KK4XYS', 'FCC', 'Old Name', 'Expired', 'US', now() - interval '7 days');

select is(fcc_license_load_status(), null, 'no load yet');

select lives_ok($$select fcc_license_load_begin('Sun, 11 Oct 2026 13:18:48 GMT')$$, 'a load begins');
select is((select (status, version, counts)::text from license_loads),
  '(loading,"Sun, 11 Oct 2026 13:18:48 GMT","{""AM"": 0, ""EN"": 0, ""HD"": 0}")',
  'the load is recorded as loading with zero counts');
select is(fcc_license_load_status() ->> 'status', 'loading', 'status reports the newest load');

select throws_ok($$select fcc_license_load_begin(' ')$$, 'P0001',
  'fcc_license_load_begin: version is required', 'a version is required');

-- KK4XYS has a lapsed record (usi 1) and a current one (usi 2); KK4ZZS is a
-- club with no operator class whose older record has a blank status (usi 5);
-- N0CLS has only an expired record.
select is(fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":1,"callsign":"KK4XYS","status":"Expired","granted_on":"2001-01-01","expires_on":"2011-01-01"},
    {"usi":2,"callsign":"kk4xys","status":"Active","granted_on":"2019-03-14","expires_on":"2029-03-14"},
    {"usi":3,"callsign":"KK4ZZS","status":"Active","granted_on":"2020-05-01","expires_on":"2030-05-01"}]'),
  3, 'HD rows stage and the total comes back');
select is(fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":3,"callsign":"KK4ZZS","status":"Active"},
    {"usi":4,"callsign":"N0CLS","status":"Expired","granted_on":"1990-01-01","expires_on":"2000-01-01"},
    {"usi":5,"callsign":"KK4ZZS","status":null,"granted_on":"2010-01-01"}]'),
  5, 'a retried record is skipped and the total still counts every staged row');
select is(fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":4,"callsign":"N0CLS","status":"Expired"}]'),
  5, 'a batch retried after a lost reply reports the same total');
select is(fcc_license_load_rows((select max(id) from license_loads), 'EN',
  '[{"usi":1,"name":"Jane Roe","state":"VA"},
    {"usi":2,"name":"Jane Q Doe","state":"NC","street_address":"1 Main St","zip_code":"27601"},
    {"usi":3,"name":"Example Amateur Radio Club","state":"NC"}]'),
  3, 'EN rows stage');
select is(fcc_license_load_rows((select max(id) from license_loads), 'AM',
  '[{"usi":1,"operator_class":"General"},{"usi":2,"operator_class":"Amateur Extra"},
    {"usi":3,"operator_class":null},{"usi":4,"operator_class":"Novice"}]'),
  4, 'AM rows stage');
select is((select count(*) from information_schema.columns
           where table_name in ('fcc_uls_hd', 'fcc_uls_en', 'fcc_uls_am', 'callsign_licenses')
             and column_name ~ 'address|city|zip|po_box|phone|email|frn'),
  0::bigint, 'no table has a column for addresses or contact details');

select throws_ok($$select fcc_license_load_rows((select max(id) from license_loads), 'LA', '[]')$$,
  'P0001', 'fcc_license_load_rows: unknown record type LA', 'only HD, EN and AM stage');
select throws_ok($$select fcc_license_load_rows((select max(id) from license_loads), 'HD', '{}')$$,
  'P0001', 'fcc_license_load_rows: rows must be an array', 'rows must be an array');
select throws_like($$select fcc_license_load_rows(-1, 'HD', '[]')$$,
  '%load -1 is not loading', 'rows need a loading load');

select throws_like(
  $$select fcc_license_load_finish((select max(id) from license_loads), '{"HD":4,"EN":3,"AM":4}')$$,
  '%staged {"AM": 4, "EN": 3, "HD": 5} but the relay sent%', 'finish refuses a count mismatch');
select is((select status from license_loads), 'loading', 'a refused finish leaves the load loading');

-- Nothing is applied before finish.
select lives_ok($$select apply_license_loads()$$, 'apply with nothing ready is a no-op');
select is((select name from callsign_licenses where callsign = 'KK4XYS'), 'Old Name',
  'the old set stays until a load is ready');

select lives_ok(
  $$select fcc_license_load_finish((select max(id) from license_loads), '{"HD":5,"EN":3,"AM":4}')$$,
  'finish accepts matching counts');
select is((select (status, counts)::text from license_loads),
  '(ready,"{""AM"": 4, ""EN"": 3, ""HD"": 5}")', 'the load is ready with its counts');
select throws_like($$select fcc_license_load_rows((select max(id) from license_loads), 'HD', '[]')$$,
  '%is not loading', 'a ready load takes no more rows');

select lives_ok($$select apply_license_loads()$$, 'apply swaps the load in');
select is((select (status, licenses)::text from license_loads), '(applied,3)',
  'the load is applied with the license count');
select results_eq(
  $$select callsign, name, operator_class, status, granted_on::text, expires_on::text, state, country
    from callsign_licenses order by callsign$$,
  $$values ('KK4XYS', 'Jane Q Doe', 'Amateur Extra', 'Active', '2019-03-14', '2029-03-14', 'NC', 'US'),
           ('KK4ZZS', 'Example Amateur Radio Club', null, 'Active', '2020-05-01', '2030-05-01', 'NC', 'US'),
           ('N0CLS', null, 'Novice', 'Expired', '1990-01-01', '2000-01-01', null, 'US')$$,
  'the active record wins (over a blank status too), calls are uppercase, missing EN rows leave nulls, dropped calls go');
select is((select count(*) from fcc_uls_hd) + (select count(*) from fcc_uls_en)
          + (select count(*) from fcc_uls_am), 0::bigint, 'apply empties staging');

-- A ready load whose staging was lost (unlogged tables after a crash) fails
-- and leaves the licenses alone.
select fcc_license_load_begin('next week');
select fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":9,"callsign":"K1NEWS","status":"Active"}]');
select fcc_license_load_finish((select max(id) from license_loads), '{"HD":1,"EN":0,"AM":0}');
truncate fcc_uls_hd;
select lives_ok($$select apply_license_loads()$$, 'apply survives lost staging');
select is((select status from license_loads where id = (select max(id) from license_loads)),
  'failed', 'that load is failed');
select is((select count(*) from callsign_licenses), 3::bigint, 'the applied set is untouched');

-- A new load fails an unfinished one.
select fcc_license_load_begin('week after');
select fcc_license_load_begin('week after');
select is((select array_agg(status order by id)::text from license_loads),
  '{applied,failed,failed,loading}', 'begin supersedes an unfinished load');

-- The relay abandons a load: it fails with the reason and staging empties.
select fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":9,"callsign":"K1NEWS","status":"Active"}]');
select lives_ok($$select fcc_license_load_abandon((select max(id) from license_loads),
  'EN.dat has 3 records, expected at least 500000')$$, 'a load can be abandoned');
select is((select (status, error)::text from license_loads where id = (select max(id) from license_loads)),
  '(failed,"EN.dat has 3 records, expected at least 500000")', 'it fails with the relay''s reason');
select is((select count(*) from fcc_uls_hd), 0::bigint, 'abandon empties staging');
select fcc_license_load_begin('later');
select fcc_license_load_rows((select max(id) from license_loads), 'HD',
  '[{"usi":9,"callsign":"K1NEWS","status":"Active"}]');
select fcc_license_load_abandon((select max(id) - 1 from license_loads), 'stale');
select is((select count(*) from fcc_uls_hd), 1::bigint,
  'abandoning a load that is no longer loading leaves the current staging alone');

-- Clients read none of it, so a hidden call's license cannot be read around its profile.
set local role anon;
select throws_ok($$select * from callsign_licenses$$, '42501', null, 'anon cannot read licenses');
select throws_ok($$select * from license_loads$$, '42501', null, 'anon cannot read license_loads');
select throws_ok($$select * from fcc_uls_hd$$, '42501', null, 'anon cannot read staging');
select throws_ok($$select fcc_license_load_begin('x')$$, '42501', null,
  'anon cannot start a load');
reset role;

set local role authenticated;
select throws_ok($$select * from callsign_licenses$$, '42501', null, 'authenticated cannot read licenses');
reset role;

select * from finish();
rollback;
