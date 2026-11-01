-- pgTAP: ISED amateur license and special callsign loads (20261126000100).

begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

delete from callsign_licenses;
delete from ised_special_callsigns;
delete from license_loads;
delete from hidden_callsigns;

-- 1. Operator class mapping (order and precedence)
select is(ised_operator_class('A'), 'Basic', 'qual A is Basic');
select is(ised_operator_class('B'), '5 WPM', 'qual B is 5 WPM');
select is(ised_operator_class('C'), '12 WPM', 'qual C is 12 WPM');
select is(ised_operator_class('D'), 'Advanced', 'qual D is Advanced');
select is(ised_operator_class('E'), 'Basic with Honours', 'qual E is Basic with Honours');
select is(ised_operator_class('ACD'), 'Advanced, Basic, 12 WPM', 'multiple quals mapped in precedence order');
select is(ised_operator_class('ABCDE'), 'Advanced, Basic with Honours, 12 WPM', 'honours and 12 WPM override lower tiers');
select is(ised_operator_class('AE'), 'Basic with Honours', 'E overrides A');
select is(ised_operator_class('BC'), '12 WPM', 'C overrides B');
select is(ised_operator_class('DE'), 'Advanced, Basic with Honours', 'Advanced precedes Basic with Honours');
select is(ised_operator_class(''), null, 'empty quals return null');

-- 2. Privacy check: exact staging columns and no address/contact columns
select is(
  (select array_agg(column_name::text order by column_name)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'ised_amateur_stage'),
  array['callsign', 'club_name', 'first_name', 'last_name', 'province', 'qualifications'],
  'ised_amateur_stage has exactly the six expected columns');

select is(
  (select count(*) from information_schema.columns
   where table_schema = 'public'
     and table_name in ('ised_amateur_stage', 'ised_special_stage', 'ised_special_callsigns')
     and column_name ~ 'address|city|zip|postal|po_box|phone|email|frn'),
  0::bigint, 'ISED tables have no address or contact columns');

-- 3. Amateur lifecycle: empty status, floor, begin, overlapping rows, finish, apply
select is(ised_license_load_status() ->> 'load', null, 'no ISED load yet');
select is(ised_license_floor(), 80000, 'first-load ISED floor is 80,000');
select throws_ok($$select ised_license_load_begin(' ')$$, 'P0001',
  'ised_license_load_begin: version is required', 'a version is required');

-- Seed 10 existing ISED rows (floor becomes 9) plus 1 FCC row to verify non-interference.
insert into callsign_licenses (callsign, authority, name, status, country, loaded_at)
select format('VE3S%sS', lpad(i::text, 2, '0')), 'ISED', 'Seed', null, 'CA', now() - interval '7 days'
from generate_series(1, 10) as i;
insert into callsign_licenses (callsign, authority, name, status, country, loaded_at)
values ('W1OLDS', 'FCC', 'Old FCC', 'Active', 'US', now() - interval '7 days');

select is(ised_license_floor(), 9, 'with 10 ISED rows present the floor is 9');
select lives_ok($$select ised_license_load_begin('2026-10-29')$$, 'ised load begins');

select is(ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  '[{"callsign":"VE3TSS","first_name":"Hélène","last_name":"McFadden","club_name":null,"province":"ON","qualifications":"ACD","address_line":"188 Millwood Dr"},
    {"callsign":"VA7QSS","first_name":"Françoise","last_name":"\"Frank\"","club_name":null,"province":"BC","qualifications":"A"},
    {"callsign":"VE1CSS","first_name":"DAVID","last_name":"LEWIS","club_name":null,"province":"NS","qualifications":"DE"},
    {"callsign":"VE2RSS","first_name":"John","last_name":"Smith","club_name":null,"province":"QC","qualifications":"B"},
    {"callsign":"VE5CSS","first_name":"Trustee","last_name":"Person","club_name":"Example Radio Club HQ","province":"SK","qualifications":"A"}]'),
  5, 'first amateur batch stages and drops unknown keys like address_line');

select throws_like(
  $$select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 5)$$,
  '%staged only 5 rows (floor 9)%', 'finish refuses a load below the floor');

-- Overlapping batch: VE5CSS repeated + 5 new calls = 10 total staged rows.
select is(ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  '[{"callsign":"VE5CSS","first_name":"Trustee","last_name":"Person","club_name":"Example Radio Club HQ","province":"SK","qualifications":"A"},
    {"callsign":"VE4SSS","first_name":"Jane","last_name":"Doe","club_name":null,"province":"MB","qualifications":"ABCDE"},
    {"callsign":"VE6ESS","first_name":null,"last_name":null,"club_name":null,"province":null,"qualifications":"E"},
    {"callsign":"VE7ASS","first_name":"Pat","last_name":"Lee","club_name":null,"province":"BC","qualifications":"AB"},
    {"callsign":"VO1BSS","first_name":"Alex","last_name":"Roy","club_name":null,"province":"NL","qualifications":"BC"},
    {"callsign":"VY0CSS","first_name":"Sam","last_name":"Kim","club_name":null,"province":"NU","qualifications":"D"}]'),
  10, 'overlapping batch skips duplicates and reports cumulative staged count');

select throws_like(
  $$select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 9)$$,
  '%staged 10 but the worker sent 9%', 'finish refuses a count mismatch');

select lives_ok(
  $$select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 10)$$,
  'finish accepts matching count at or above floor');

select lives_ok($$select apply_license_loads()$$, 'apply swaps the ISED load in');
select is(
  (select (status, licenses)::text from license_loads where authority = 'ISED' order by id desc limit 1),
  '(applied,10)', 'ISED load is applied with 10 licenses');

select is(
  (select (authority, country, name, first_name, last_name, operator_class, status, granted_on, expires_on, state)::text
   from callsign_licenses where callsign = 'VE3TSS'),
  '(ISED,CA,"Hélène McFadden",Hélène,McFadden,"Advanced, Basic, 12 WPM",,,,ON)',
  'person row lands with authority, country, names, operator_class, province, and null status/dates');

select is(
  (select (authority, country, name, first_name, last_name, operator_class, state)::text
   from callsign_licenses where callsign = 'VE5CSS'),
  '(ISED,CA,"Example Radio Club HQ",,,,SK)',
  'club row keeps club name and nulls first_name, last_name, and operator_class');

select is((select name from callsign_licenses where callsign = 'W1OLDS'), 'Old FCC',
  'ISED apply never touches FCC rows');
select is((select count(*) from ised_amateur_stage), 0::bigint, 'apply empties ised_amateur_stage');
select ok(ised_license_load_status() ->> 'newestAppliedStartedAt' is not null,
  'status reports newestAppliedStartedAt');

-- 4. Lost staging survival (unlogged table cleared after finish)
select ised_license_load_begin('2026-11-05');
select ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  (select jsonb_agg(jsonb_build_object('callsign', format('VA3L%sS', lpad(i::text, 2, '0')),
                                       'first_name', 'A', 'last_name', 'B', 'club_name', null,
                                       'province', 'ON', 'qualifications', 'A'))
   from generate_series(1, 10) as i));
select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 10);
truncate ised_amateur_stage;
select lives_ok($$select apply_license_loads()$$, 'ISED apply survives lost staging');
select is(
  (select status from license_loads where authority = 'ISED' order by id desc limit 1),
  'failed', 'lost-staging ISED load is marked failed');
select is((select count(*) from callsign_licenses where authority = 'ISED'), 10::bigint,
  'existing ISED licenses stay untouched on lost staging');

-- 5. Abandon empties staging and records error
select ised_license_load_begin('2026-11-06');
select ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  '[{"callsign":"VE3ABS","first_name":"A","last_name":"B","club_name":null,"province":"ON","qualifications":"A"}]');
select lives_ok(
  $$select ised_license_load_abandon((select max(id) from license_loads where authority = 'ISED'), 'bad zip')$$,
  'ised load can be abandoned');
select is(
  (select (status, error, (select count(*) from ised_amateur_stage))::text
   from license_loads where authority = 'ISED' order by id desc limit 1),
  '(failed,"bad zip",0)', 'abandon marks load failed with reason and empties staging');

-- 6. Fault isolation between FCC and ISED applies
-- Failing ISED apply (lost staging) still lets a ready FCC load apply cleanly.
select fcc_license_load_begin('fcc-v1');
select fcc_license_load_rows((select max(id) from license_loads where authority = 'FCC'), 'HD',
  '[{"usi":101,"callsign":"K1NEWS","status":"Active","granted_on":"2020-01-01","expires_on":"2030-01-01"}]');
select fcc_license_load_finish((select max(id) from license_loads where authority = 'FCC'), '{"HD":1,"EN":0,"AM":0}');
select ised_license_load_begin('ised-bad');
select ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  (select jsonb_agg(jsonb_build_object('callsign', format('VA3F%sS', lpad(i::text, 2, '0')),
                                       'first_name', 'A', 'last_name', 'B', 'club_name', null,
                                       'province', 'ON', 'qualifications', 'A'))
   from generate_series(1, 10) as i));
select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 10);
truncate ised_amateur_stage;
select lives_ok($$select apply_license_loads()$$, 'apply completes when ISED fails and FCC succeeds');
select is(
  (select ((select status from license_loads where authority = 'FCC' order by id desc limit 1),
           (select count(*) from callsign_licenses where callsign = 'K1NEWS'),
           (select count(*) from callsign_licenses where authority = 'ISED'))::text),
  '(applied,1,10)', 'FCC applies and leaves existing ISED rows untouched when ISED fails');

-- Failing FCC apply (lost staging) still lets a ready ISED load apply cleanly.
select fcc_license_load_begin('fcc-bad');
select fcc_license_load_rows((select max(id) from license_loads where authority = 'FCC'), 'HD',
  '[{"usi":102,"callsign":"K1DROP","status":"Active"}]');
select fcc_license_load_finish((select max(id) from license_loads where authority = 'FCC'), '{"HD":1,"EN":0,"AM":0}');
truncate fcc_uls_hd;
select ised_license_load_begin('ised-good');
select ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  '[{"callsign":"VE3TSS","first_name":"Hélène","last_name":"McFadden","club_name":null,"province":"ON","qualifications":"ACD"},
    {"callsign":"VE5CSS","first_name":"Trustee","last_name":"Person","club_name":"Example Radio Club HQ","province":"SK","qualifications":"A"},
    {"callsign":"VE3N01S","first_name":"N","last_name":"One","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N02S","first_name":"N","last_name":"Two","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N03S","first_name":"N","last_name":"Three","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N04S","first_name":"N","last_name":"Four","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N05S","first_name":"N","last_name":"Five","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N06S","first_name":"N","last_name":"Six","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N07S","first_name":"N","last_name":"Seven","club_name":null,"province":"ON","qualifications":"A"},
    {"callsign":"VE3N08S","first_name":"N","last_name":"Eight","club_name":null,"province":"ON","qualifications":"A"}]');
select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 10);
select lives_ok($$select apply_license_loads()$$, 'apply completes when FCC fails and ISED succeeds');
select is(
  (select ((select status from license_loads where authority = 'ISED' order by id desc limit 1),
           (select status from license_loads where authority = 'FCC' order by id desc limit 1),
           (select count(*) from callsign_licenses where callsign = 'K1NEWS'))::text),
  '(applied,failed,1)', 'ISED applies and leaves existing FCC rows untouched when FCC fails');

-- 7. spot_license_name for Canadian person, club, and hidden call
select is(
  (spot_license_name('{"callsign":"VE3TSS/P"}'::jsonb, 'first'),
   spot_license_name('{"callsign":"VE3TSS/P"}'::jsonb, 'last'))::text,
  '(Hélène,McFadden)', 'spot_license_name returns a Canadian person''s first and last names');
select is(spot_license_name('{"callsign":"VE5CSS"}'::jsonb, 'first'), null,
  'spot_license_name returns null for a Canadian club');
insert into hidden_callsigns (callsign) values ('VE3TSS');
select is(spot_license_name('{"callsign":"VE3TSS"}'::jsonb, 'first'), null,
  'spot_license_name returns null for a hidden Canadian call');

-- 8. Special callsigns load lifecycle into ised_special_callsigns
select is(ised_special_floor(), 10, 'first-load special floor is 10');
select lives_ok($$select ised_special_load_begin('2026-10-29-special')$$, 'ised special load begins');

-- 10 distinct (callsign, beg_date, end_date) rows (CF3VEDAY reused across 2 years) + 1 exact duplicate dropped.
select is(ised_special_load_rows((select max(id) from license_loads where authority = 'ISED-SPECIAL'),
  '[{"callsign":"CF3VEDAY","beg_date":"2005-05-01","end_date":"2005-05-31","event_en":"War Museum 2005","event_fr":"Musée 2005","call_sign_request":null,"use_by":"VA3ROR"},
    {"callsign":"CF3VEDAY","beg_date":"2005-05-01","end_date":"2005-05-31","event_en":"Duplicate ignored","event_fr":null,"call_sign_request":null,"use_by":"VA3ROR"},
    {"callsign":"CF3VEDAY","beg_date":"2026-05-01","end_date":"2026-05-31","event_en":"War Museum 2026","event_fr":"Musée 2026","call_sign_request":null,"use_by":"VA3ROR"},
    {"callsign":"VD2X","beg_date":"2005-06-15","end_date":"2005-07-15","event_en":"Centennial","event_fr":"Centenaire","call_sign_request":"VA3RA","use_by":null},
    {"callsign":"VE3TSS","beg_date":"2026-07-01","end_date":"2026-07-31","event_en":"Overlap with regular call","event_fr":null,"call_sign_request":null,"use_by":"VE3TSS"},
    {"callsign":"VC3S01S","beg_date":"2026-01-01","end_date":"2026-01-31","event_en":"E1","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VC3S02S","beg_date":"2026-02-01","end_date":"2026-02-28","event_en":"E2","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VC3S03S","beg_date":"2026-03-01","end_date":"2026-03-31","event_en":"E3","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VC3S04S","beg_date":"2026-04-01","end_date":"2026-04-30","event_en":"E4","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VC3S05S","beg_date":"2026-08-01","end_date":"2026-08-31","event_en":"E5","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VC3S06S","beg_date":"2026-09-01","end_date":"2026-09-30","event_en":"E6","event_fr":null,"call_sign_request":null,"use_by":null}]'),
  10, 'special rows drop exact duplicates and allow repeated callsigns with distinct date windows');

select throws_like(
  $$select ised_special_load_finish((select max(id) from license_loads where authority = 'ISED-SPECIAL'), 9)$$,
  '%staged 10 but the worker sent 9%', 'special finish refuses count mismatch');

select lives_ok(
  $$select ised_special_load_finish((select max(id) from license_loads where authority = 'ISED-SPECIAL'), 10)$$,
  'special finish accepts matching count');

select lives_ok($$select apply_license_loads()$$, 'apply swaps special callsigns into ised_special_callsigns');
select is(
  (select ((select count(*) from ised_special_callsigns),
           (select count(*) from ised_special_callsigns where callsign = 'CF3VEDAY' and use_by = 'VA3ROR'),
           (select count(*) from callsign_licenses where authority = 'ISED'))::text),
  '(10,2,10)', 'special callsigns land in ised_special_callsigns without colliding with callsign_licenses');

select is(ised_special_floor(), 9, 'with 10 special rows present the floor is 9');

select ised_special_load_begin('2026-11-05-special');
select ised_special_load_rows((select max(id) from license_loads where authority = 'ISED-SPECIAL'),
  '[{"callsign":"CF3VEDAY","beg_date":"2026-05-01","end_date":"2026-05-31","event_en":"Too few","event_fr":null,"call_sign_request":null,"use_by":null},
    {"callsign":"VD2X","beg_date":"2026-06-01","end_date":"2026-06-30","event_en":"Too few","event_fr":null,"call_sign_request":null,"use_by":null}]');
select throws_like(
  $$select ised_special_load_finish((select max(id) from license_loads where authority = 'ISED-SPECIAL'), 2)$$,
  '%staged only 2 rows (floor 9)%', 'special finish enforces floor');

-- Special lost-staging survival
select ised_special_load_begin('2026-11-06-special');
select ised_special_load_rows((select max(id) from license_loads where authority = 'ISED-SPECIAL'),
  (select jsonb_agg(jsonb_build_object('callsign', format('VC3L%sS', lpad(i::text, 2, '0')),
                                       'beg_date', '2026-01-01', 'end_date', '2026-01-31',
                                       'event_en', 'Lost', 'event_fr', null,
                                       'call_sign_request', null, 'use_by', null))
   from generate_series(1, 10) as i));
select ised_special_load_finish((select max(id) from license_loads where authority = 'ISED-SPECIAL'), 10);
truncate ised_special_stage;
select apply_license_loads();
select is(
  (select ((select status from license_loads where authority = 'ISED-SPECIAL' order by id desc limit 1),
           (select count(*) from ised_special_callsigns))::text),
  '(failed,10)', 'special apply survives lost staging without wiping ised_special_callsigns');

-- 9. Privileges: every new function is service_role only; new tables unreadable by clients
select ok(not exists (
  select 1 from unnest(array[
    'public.ised_operator_class(text)',
    'public.ised_license_floor()',
    'public.ised_special_floor()',
    'public.ised_license_load_status()',
    'public.ised_license_load_begin(text)',
    'public.ised_license_load_rows(bigint, jsonb)',
    'public.ised_license_staged_counts()',
    'public.ised_license_load_finish(bigint, integer)',
    'public.ised_license_load_abandon(bigint, text)',
    'public.ised_special_load_status()',
    'public.ised_special_load_begin(text)',
    'public.ised_special_load_rows(bigint, jsonb)',
    'public.ised_special_staged_counts()',
    'public.ised_special_load_finish(bigint, integer)',
    'public.ised_special_load_abandon(bigint, text)',
    'public.apply_fcc_license_load()',
    'public.apply_ised_license_load()'
  ]) as f
  where has_function_privilege('anon', f, 'execute')
     or has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute')),
  'every new ISED function is executable by service_role only');

select ok(not exists (
  select 1 from unnest(array['ised_amateur_stage', 'ised_special_stage', 'ised_special_callsigns']) as t
  where has_table_privilege('anon', t, 'select')
     or has_table_privilege('authenticated', t, 'select')),
  'clients cannot read ISED staging or special callsign tables');

select * from finish();
rollback;
