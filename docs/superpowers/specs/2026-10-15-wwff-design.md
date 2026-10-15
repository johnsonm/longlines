# WWFF as a source

Date: 2026-10-15

## Goal

Long Lines ingests World Wide Flora & Fauna (WWFF) spots. WWFF is a POTA-like award program for
activations of nature reserves, each identified by a reference such as `KFF-5268` or `ONFF-0123`.
WWFF is already in the source catalog as a planned tile; this change makes it a live, alerting
source.

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| "Any source" | Opt-in only, like DX Cluster. A subscription gets WWFF spots only if its `sources` lists `wwff`. About half of WWFF spots are US `KFF` references that are usually POTA activations too, so including WWFF in "any source" would send existing subscribers duplicate alerts. |
| Scope | The full source in one PR: ingest, matching, the reference filter, delivery and push text, archive, the catalog tile going live with a detail page and rates, WWFF in profile activations, and the Stats top lists. |

## Upstream

`GET https://spots.wwff.co/static/spots.json` returns a JSON array of the latest spot per activator
over roughly the last 24 hours (48 spots, 48 activators when sampled on 2026-10-15 at 18:27Z). It
needs no key. It is served with `Cache-Control: public, max-age=60`, so we poll it once a minute, the
same as POTA. A conditional request would gain nothing at this size.

```json
{
  "id": 157369, "activator": "K2CAF", "frequency_khz": 18130, "mode": "SSB",
  "reference": "KFF-5268", "reference_name": "T.M. Goodwin", "remarks": "",
  "spotter": "K2CAF", "latitude": 27.86285, "longitude": -80.73032,
  "spot_time": 1792088822, "spot_time_formatted": "2026-10-15 18:27:02"
}
```

- `spot_time` is Unix seconds, UTC. `spot_time_formatted` is ignored.
- `frequency_khz` is a number in kHz.
- `remarks` is free text and may be empty. "Re-spotted via RBN" and "Re-spot from web" are common.
- `latitude`/`longitude` are the reference's position. They stay in `raw_payload` only; there is no
  column for them in this change.

## Shape

The flow is pg_cron → `ingest-wwff` → `runIngest` → `ingest_spots` → `raw_spots`, the same as POTA.
There is no relay change and no firehose table.

### Adapter (`_shared/wwff.ts`)

- `source_spot_id` is `id`.
- The content hash covers `spot_time, activator, reference, frequency_khz, mode, remarks`, in that
  order. The order goes into `ARCHITECTURE.md`'s hash section and is fixed from the first deploy.
- Skips follow POTA: `too_old` (older than five minutes) and `test_comment`. QRT spots are kept,
  as they are for POTA.
- The spotter is uppercased and trimmed, and a blank spotter becomes null. The comment is
  `remarks`, trimmed. Mode goes through `resolveMode(mode, comment)` and the band through
  `bandForFrequency`.
- A spot with a missing `id`, `activator`, `spot_time` or frequency throws, and the orchestrator
  records it in `ingest_failures`.
- The tests run against a fixture captured from the live feed (`fixtures/wwff-spots.json`) with
  `NOW` pinned inside the capture's five-minute window.

### Schema (one migration)

- `raw_spots` gains `wwff_reference text` and `wwff_reference_name text`, after
  `sota_summit_ref`. `NormalizedSpot` gains the same two keys, and the other four adapters set
  them to null.
- `wwff` is added to the source checks on `raw_spots`, `ingest_state` and `archive_log`. The
  migration also inserts the `ingest_state` row, without which `record_ingest_*` silently does
  nothing.
- `ingest_spots` adds the two columns to its insert, select and recordset lists.
- An `ingest-wwff` cron job runs `* * * * *`, built the same way as `ingest-pota`.

### Matching

- `source_matches` changes so that an empty list means `p_source not in ('dxcluster', 'wwff')`.
  It stays a one-expression `language sql immutable` helper, so it remains on
  `advisor.test.sql`'s unpinned list.
- The reference rule in `rule_matches` adds `spot.wwff_reference` to its `concat_ws`, so a
  "Park, summit, or location contains `KFF-`" rule matches WWFF spots.
- `preview_subscription` adds the two keys to its spot JSON. As with DX, the preview window
  already filters by source.
- Web: the reference field shows when the sources include `wwff` (`model.ts` `fieldsFor`). Its
  help text becomes "Matches POTA references and locations, SOTA summit codes and WWFF
  references."

### Delivery

- `claim_deliveries` adds both keys to the spot JSON, and `DeliverySpot` gains them.
- `format.ts`: `SOURCE_LABELS.wwff = "WWFF"`. Discord embeds add "WWFF" (the reference) and
  "Reserve" (the name). Push facts add both. `sampleSpot` sets them to null.
- `docs/WEBHOOKS.md` and `docs/API.md` list the new fields and the `wwff` source, with the same
  opt-in note as DX Cluster.

### Read models

- `recent_spots` is dropped and recreated with the two columns. That also means re-applying
  `security_invoker`, the revokes and the grant. `list_recent_spots`, which returns that row type,
  is recreated with it, and its RBN branch adds two nulls.
- `list_callsign_groups`: `coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference)`.
- `web/src/sources/spots.ts` `spotReference` falls back to `wwff_reference`.

### Archive

- `archive_slice_minutes('wwff')` is 60, and `ARCHIVE_ORDER` gains `wwff` after `dxcluster`.
- `archive_columns` puts `wwff` in the `raw_spots` branch and emits the two new columns.
  `SPOT_COLUMNS` in `archive.ts` adds them. Parquet files for every `raw_spots` source gain the
  two columns; in older files they are absent and readers treat them as null.
- `archive_status` adds `('wwff')`.

### Profiles

`spot_stream` adds a `'WWFF'` arm to `program`. `reference` coalesces `wwff_reference` after POTA
and SOTA, and `reference_name` coalesces `wwff_reference_name`. The rollups and `callsign_profile`
are generic over program, and the web already renders unknown programs as "N WWFF references", so
neither needs code changes. The new arm reaches only days rolled up after the deploy; days already
rolled up are never re-rolled.

### Stats

- `daily` and `hourly` gain a `wwff` key. The catalog rates read `hourly[].wwff` through
  `statsKey: "wwff"`.
- `topActivators` counts WWFF references and activations alongside POTA and SOTA.
  `topReferences` gains a WWFF arm whose name comes from `wwff_reference_name`. `Program` becomes
  `"POTA" | "SOTA" | "WWFF"`.
- The totals, band chart and country chart are unchanged. WWFF does not get its own KPI.
- Per the Phase 3 rules, `refresh_stats_snapshot_at`, `StatsPayload` and `stats_snapshot.test.sql`
  change together.

### Catalog (`web/src/sources/sources.ts`)

The `wwff` entry goes live with this copy:

- interval "every 60s", `pollSeconds: 60`, `statsKey: "wwff"`, `site: "wwff.co"`.
- `markColor: "success"`, `desc` "Reference activation spots from spots.wwff.co".
- runBy: operator "World Wide Flora & Fauna"; feed "Spot list, polled every 60 seconds"; modes
  "CW, SSB, digital".
- tagline: "Activators in nature reserves and protected areas around the world."
- about:
  - "World Wide Flora & Fauna is an award program for portable operation from nature reserves and protected areas. Activators and hunters post spots to the WWFF spotting page as they operate."
  - "Long Lines stores every WWFF spot, keeps the reference and its name, and shows them on profiles and in Stats. Only subscriptions that pick WWFF get them."
- showsUp:
  - "Callsign profile: last heard, references, activity"
  - "Stats: most spotted references, top activators"
  - "Subscription filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains"
- schema: `deliveredSchema("wwff", {}, [wwff_reference "WWFF reference.", wwff_reference_name "Reference name."])`.
  Every other source's `example` gains the two keys as null.

The tests that pin WWFF as planned (sources, status, tile, page, detail redirect, subscription
picker) change to treat it as live, and PSK Reporter becomes the only planned source.

### Also

- `web/scripts/invoke-function.ts` and `web/package.json` get `invoke:wwff`.
- `supabase/seed.sql` gets a WWFF section with made-up calls ending in `S`, some of them on the
  same activations as seeded POTA spots.
- `smoke-test.sql`, `readmodels_auth.test.sql` and `archive.test.sql` row counts go from 5 to 6.
- A new pgTAP suite, `supabase/tests/wwff.test.sql` (modelled on `dxcluster.test.sql`), covers the
  checks, the `ingest_state` row, opt-in `source_matches`, the reference rule, the slice length and
  `archive_status`.
- Database types are regenerated.
- Docs: README, ARCHITECTURE (adapters, hash order, cron, `source_matches`, archive, `spot_stream`),
  OPERATIONS (a WWFF section like DX Cluster's) and CLAUDE.md (the source list and the opt-in rule
  next to DX Cluster's).

## Not in this change

- **Cross-source dedup** of WWFF/POTA dual activations. It is excluded by the Phase 1 scope, and
  opt-in keeps existing users from seeing duplicates.
- **Band map.** It stays POTA, SOTA and DX Cluster. Adding WWFF is a small follow-up (a lane, a
  color, `band_map_snapshot`'s source list), but it is a separate product call.
- **Country rollups** (`rollup_country_day`), the band chart and a WWFF KPI on Stats.
- **Coordinates.** They stay in `raw_payload`.

## Rollout

1. Merge. The Supabase GitHub integration applies the migration, and the cron job starts calling
   `ingest-wwff`, which 404s until step 2.
2. `supabase functions deploy ingest-wwff`. The integration skips new functions. Redeploy
   `deliver` and `archive`, whose shared code changed.
3. Check `ingest_health` for `wwff` and the catalog tile after a few minutes.
