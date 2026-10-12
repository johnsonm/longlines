-- pgTAP: raw_spots.mode_family is stored by ingest_spots, exposed by
-- recent_spots, and lets a subscription match a whole mode family.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(4);

select lives_ok($$
  select * from ingest_spots(jsonb_build_array(jsonb_build_object(
    'source', 'pota', 'source_spot_id', 'fam-1', 'content_hash', 'f1', 'spot_time', now() - interval '5 minutes',
    'callsign', 'K0NY', 'frequency_khz', 14074, 'band', '20m', 'mode', 'ft8', 'mode_family', 'digital',
    'comment', '', 'raw_payload', '{}'::jsonb)))
$$, 'a spot with a mode family inserts');
select is((select r.mode_family from raw_spots r where r.source_spot_id = 'fam-1'), 'digital', 'mode_family stored');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select v.mode_family from list_recent_spots(200) v where v.callsign = 'K0NY'), 'digital', 'list_recent_spots shows mode_family');
select is((select count from preview_subscription('{"modes":["digital"],"callsigns":["K0NY"]}')), 1::bigint, 'preview matches the family filter');

select * from finish();
rollback;
