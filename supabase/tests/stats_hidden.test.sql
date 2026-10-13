-- pgTAP: stats snapshots never name a hidden call (20261012000080).
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

delete from stats_snapshots;
delete from hidden_callsigns;
insert into hidden_callsigns (callsign, note) values ('KK4HID', 'test');

insert into stats_snapshots (window_start, window_end, payload) values (now() - interval '7 days', now(), '{
  "totals": {"spots": 3},
  "topActivators": [{"callsign": "W1AW", "references": 3}, {"callsign": "KK4HID/P", "references": 2}, {"callsign": "K1ABC", "references": 1}],
  "rbn": {"spots": 9, "topStations": [{"callsign": "KK4HID", "spots": 5}, {"callsign": "DL1ABC", "spots": 4}]}
}');

select is((select payload -> 'topActivators' from stats_snapshots),
  '[{"callsign": "W1AW", "references": 3}, {"callsign": "K1ABC", "references": 1}]'::jsonb,
  'a hidden call is dropped from topActivators by base call, order kept');
select is((select payload #> '{rbn,topStations}' from stats_snapshots),
  '[{"callsign": "DL1ABC", "spots": 4}]'::jsonb, 'and from rbn.topStations');
select is((select payload #>> '{rbn,spots}' from stats_snapshots), '9', 'the rest of the payload is untouched');

-- Hiding a call after the fact: rewriting the payload scrubs the stored snapshot.
insert into hidden_callsigns (callsign, note) values ('W1AW', 'test');
update stats_snapshots set payload = payload;
select is((select payload -> 'topActivators' from stats_snapshots),
  '[{"callsign": "K1ABC", "references": 1}]'::jsonb, 'an update rescrubs');

-- A snapshot without the lists (older shapes) is stored as is.
insert into stats_snapshots (window_start, window_end, payload) values (now() - interval '7 days', now(), '{"totals": {"spots": 0}}');
select is((select payload from stats_snapshots order by id desc limit 1), '{"totals": {"spots": 0}}'::jsonb,
  'a payload without top lists is unchanged');

-- The refresh still writes its full shape through the trigger.
select lives_ok($$select public.refresh_stats_snapshot()$$, 'refresh_stats_snapshot writes through the trigger');

select * from finish();
rollback;
