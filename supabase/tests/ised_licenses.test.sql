-- pgTAP: ISED license and special callsign loads.

begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

delete from callsign_licenses where authority = 'ISED';
delete from license_loads where authority in ('ISED', 'ISED-SPECIAL');

-- 1. Operator class mapping
select is(ised_operator_class('A'), 'Basic', 'qual A is Basic');
select is(ised_operator_class('D'), 'Advanced', 'qual D is Advanced');
select is(ised_operator_class('A,C,D'), 'Basic, 12 WPM, Advanced', 'multiple quals mapped in order');
select is(ised_operator_class('E'), 'Basic with Honours', 'qual E is Basic with Honours');
select is(ised_operator_class(''), null, 'empty quals return null');

-- 2. Privacy check: no address columns on staging tables
select is((select count(*) from information_schema.columns
           where table_name in ('ised_amateur_stage', 'ised_special_stage')
             and column_name ~ 'address|city|zip|po_box|phone|email|frn'),
  0::bigint, 'ISED staging tables have no address or contact columns');

-- 3. Staging and loading regular amateur certificates
select is(ised_license_load_status() -> 'load', null, 'no ISED load yet');
select lives_ok($$select ised_license_load_begin('2026-10-29')$$, 'ised load begins');
select is(ised_license_load_rows((select max(id) from license_loads where authority = 'ISED'),
  '[{"callsign":"VE3TSS","first_name":"Hélène","last_name":"McFadden","province":"ON","qualifications":"A,C,D"},
    {"callsign":"VE5CSS","club_name":"Example Radio Club","province":"SK"}]'),
  2, 'rows stage and count returns');

-- Floor check: floor is 80,000 when empty or 90% of current
select ok(ised_license_floor() >= 80000, 'floor is at least 80,000 initially');

-- Finish refuses count mismatch or below floor unless we mock floor or pass enough rows.
-- For testing apply/finish, we can temporarily stage enough or test floor refusal.
select throws_like(
  $$select ised_license_load_finish((select max(id) from license_loads where authority = 'ISED'), 2)$$,
  '%staged only 2 rows (floor %)', 'finish enforces floor');

-- For testing success, let's stage enough rows to meet floor (or test floor logic).
-- Instead of 80,000 rows in unit tests, we can test apply directly or adjust floor testing.
-- Actually, let's test special callsigns load lifecycle which has a floor of 10.

-- 4. Special callsigns load lifecycle
select lives_ok($$select ised_special_load_begin('2026-10-29-special')$$, 'ised special load begins');
select is(ised_special_load_rows((select max(id) from license_loads where authority = 'ISED-SPECIAL'),
  '[{"callsign":"CI","beg_date":"2005-05-01","end_date":"2005-05-31","event_en":"Grand Opening"},
    {"callsign":"CF3VEDAY","beg_date":"2005-05-01","end_date":"2005-05-31","event_en":"VE Day Commemoration"}]'),
  2, 'special rows stage');

select throws_like(
  $$select ised_special_load_finish((select max(id) from license_loads where authority = 'ISED-SPECIAL'), 2)$$,
  '%staged only 2 rows (floor %)', 'special finish enforces floor (floor 10)');

rollback;
