# WWBOTA as a source

Date: 2026-10-26

## Goal

Long Lines ingests Worldwide Bunkers on the Air (WWBOTA) spots. WWBOTA is an award program for
portable operation from bunkers: Cold War, WW2 and ROC posts, each identified by a reference such
as `B/G-2114` (`B/<scheme prefix>-<four digits>`). National schemes (UKBOTA, ONBOTA, HBBOTA,
EABOTA, ...) share one reference space and one spotting API.

Islands on the Air comes in a separate change: it has no spot feed of its own, so it is a tag on
DX Cluster spots (as Spothole does it), not a source.

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| "Any source" | Opt-in only, like DX Cluster and WWFF. A connection gets WWBOTA spots only if its `sources` lists `wwbota`. Bunker activations are often POTA or WWFF activations too (`B/G-2114 POTA GB-0051`) and there is no cross-source dedup. |
| Scope | Ingest, matching, the reference filter, delivery and push text, archive, the catalog tile going live with a detail page and rates, profiles and group statistics (which are generic over program), and the Health page's pulled sources. |
| Stats | Not a peer of POTA, SOTA and WWFF. The snapshot gains only `daily[].wwbota` and `hourly[].wwbota`, which the catalog's rates need, from their own CTEs as DX Cluster's `dx` does. Totals, charts, top lists and copy are unchanged. WWBOTA is about 30 spots a day. |
| Source id | `wwbota`, label "WWBOTA". Not `bota`: Spothole and others use BOTA for Beaches on the Air. |

## Upstream

`GET https://api.wwbota.net/spots/` (OpenAPI at `/openapi.json`; `api.wwbota.org` serves the same)
returns a JSON array of the spots of the last hour (`age`, 0 to 24 hours, defaults to 1). It needs
no key. It is served with `Cache-Control: public, no-cache` and an ETag. We poll it once a minute
like POTA and WWFF; a conditional request would gain nothing at this size (one to a few spots).

```json
{
  "spotter": "G0KAO", "call": "G0KAO", "freq": 6.6375, "mode": "FT8",
  "comment": "B/G-2386", "type": "QRT", "time": "2026-10-26T18:52:16.952139Z",
  "references": [{
    "scheme": "UKBOTA", "dxcc": 223, "reference": "B/G-2386",
    "name": "Horbury Gas Decontamination Centre", "type": "WW2 Gas Decontamination Unit",
    "lat": 53.6612, "long": -1.5593, "locator": "IO93FP", "extra": {"historic_county": "West Riding"}
  }]
}
```

- `freq` is MHz and may be null on a QRT spot. `mode` may be null.
- `time` is ISO 8601 UTC with microseconds.
- `type` is `Live`, `QRT` or `Test`, and it is state, not part of the spot: when an activator
  goes QRT, their recent spots all read `QRT` (in a capture of 29 spots, all 29 did, one of them
  with the comment "QRV"), and an edited spot can come back with a new `time`.
- `references` lists every bunker the comment names (a five-bunker "n-fer" is common: 15 of 29
  spots in the capture named more than one). WWBOTA extracts them; the comment must name at least
  one.
- The public spot has no id (`SpotPublic` leaves out `Spot.id`). The SSE stream's event id is the
  spot's `time`.

## Shape

The flow is pg_cron → `ingest-wwbota` → `runIngest` → `ingest_spots` → `raw_spots`, the same as
WWFF. There is no relay change and no firehose table.

### Adapter (`_shared/wwbota.ts`)

- `source_spot_id` is `time` as received. It is unique per spot to the microsecond, and it is what
  WWBOTA itself uses as the stream's event id.
- The content hash covers `time, call, freq, mode, comment`, in that order, raw as received. The
  order goes into `ARCHITECTURE.md`'s hash section and is fixed from the first deploy. `type` is
  left out on purpose: it flips from Live to QRT after the fact, and hashing it would store the
  same spot twice.
- Skips: `too_old` (older than five minutes) and `test_comment`, as for WWFF; `not_normal` for a
  `Test` spot and for a QRT spot without a frequency (there is nothing to tune to, and
  `frequency_khz` is not null). Other QRT spots are kept, as they are for POTA and WWFF.
- The spotter is uppercased and trimmed, and a blank spotter becomes null. The comment is trimmed.
  Mode goes through `resolveMode(mode, comment)`, frequency through `parseKhz(freq, "mhz")`, the
  band through `bandForFrequency`.
- `wwbota_references` is every reference, uppercased, in the feed's order, without duplicates.
  `wwbota_reference_name` is the first reference's name.
- A spot with a missing `time`, `call` or frequency (Live), or no references, throws, and the
  orchestrator records it in `ingest_failures`.
- `assertStorableSpot` bounds each reference at 64 characters and the list at 50.
- The tests run against a fixture captured from the live feed (`fixtures/wwbota-spots.json`,
  2026-10-26 ~19:03Z) with `NOW` pinned inside the capture's five-minute windows.

### Schema (one migration)

- `raw_spots` gains `wwbota_references text[]` and `wwbota_reference_name text`.
  `NormalizedSpot` gains the same two keys, and the other adapters set them to null.
- `wwbota` is added to the source checks on `raw_spots`, `ingest_state` and `archive_log` (not
  `country_daily_spots`: the world map is Stats). The migration inserts the `ingest_state` row.
- `ingest_spots` adds the two columns.
- An `ingest-wwbota` cron job runs `* * * * *` through `cron_call_function`.

### Matching

- `source_matches`: an empty list means `p_source not in ('dxcluster', 'wwff', 'wwbota')`.
- The reference rule's haystack adds every WWBOTA reference, so "Park, summit, or location
  contains `B/G-2114`" matches the third bunker of an n-fer too.
- `normalize_subscription_sources` accepts `wwbota`.
- `preview_subscription` adds the two keys to its spot JSON.
- Web: the reference field shows when the sources include `wwbota`. Its help text becomes
  "Matches POTA references and locations, SOTA summit codes, WWFF references and WWBOTA bunkers."

### Delivery

- `delivery_spot_json` and `push_sample_spot` add both keys; `DeliverySpot` gains them.
- `render_push_field`: `reference` is the WWBOTA references joined with ", " (an n-fer shows all
  of them), `place_name` the first bunker's name. Webhooks, Discord and push all render through it.
- `push_source_label('wwbota')` is "WWBOTA". `discord_source_color` gives WWBOTA gold (15844367,
  discord.py's `gold`). `spot_source_url` gives none: WWBOTA has no public page per bunker.
- `format.ts`: `SOURCE_LABELS.wwbota = "WWBOTA"`; the legacy Discord embed and push facts add
  "WWBOTA" (the references) and "Bunker" (the name).
- `docs/WEBHOOKS.md`, `docs/API.md` and `docs/openapi.yaml` list the source with the opt-in note.

### Read models

- `recent_spots` is dropped and recreated with the two columns (with `security_invoker`, the
  revokes); `list_recent_spots` is recreated with it, its RBN branch adding two nulls.
- `callsign_group_rows`' `reference` falls back to the first WWBOTA reference.
- `web/src/sources/spots.ts` `spotReference` falls back to the first WWBOTA reference.

### Archive

- `archive_slice_minutes('wwbota')` is 60, and `ARCHIVE_ORDER` gains `wwbota` after `wwff`.
- `archive_columns` puts `wwbota` in the `raw_spots` branch and emits `wwbota_references` (the
  references joined with `,`, which no reference contains) and `wwbota_reference_name` as strings.
  `SPOT_COLUMNS` adds them; `archive_convert`'s `LATER_COLUMNS` adds them, since no NDJSON slice
  has them.
- `archive_status` adds `('wwbota')`.

### Profiles and group statistics

- `spot_stream` adds a `'WWBOTA'` arm to `program`; `reference` is the first WWBOTA reference and
  `reference_name` its name. An n-fer credits its first bunker only, as a POTA 2-fer credits the
  park the spot names. The rollups, `callsign_profile` and `group_statistics_at` are generic over
  program.
- Web: the `Program` types gain `"WWBOTA"`. The activations KPI keeps its label; its detail lists
  WWBOTA only when there are bunkers ("1 WWBOTA bunker"). The references card subheader becomes
  "Parks, summits, WWFF references and bunkers, most recent first". `wwbota` gets a source color.

### Health

- `health_snapshot`'s pulled check and spots series include `wwbota`; `HealthPayload` gains
  `series.spots.wwbota`. The pulled caption becomes "POTA, SOTAwatch, WWFF, WWBOTA".

### Catalog (`web/src/sources/sources.ts`)

- interval "every 60s", `pollSeconds: 60`, `statsKey: "wwbota"`, `site: "wwbota.net"`, mark "WB",
  `desc` "Bunker activation spots from api.wwbota.net".
- runBy: operator "Worldwide Bunkers on the Air"; feed "Spot list, polled every 60 seconds";
  modes "CW, SSB, FM, digital".
- tagline: "Activators at Cold War and WW2 bunkers around the world."
- about:
  - "Worldwide Bunkers on the Air is an award program for portable operation from bunkers, from WW2 pillboxes to Cold War observation posts. Activators and hunters post spots to the WWBOTA spotting page as they operate, and one spot can name several bunkers."
  - "Long Lines stores every WWBOTA spot, keeps all of its bunker references and the first bunker's name, and shows them on profiles. Only connections that pick WWBOTA get them."
- showsUp: "Callsign profile: last heard, references, activity"; "Connection filters: Bands,
  Modes, Callsigns, Callsign groups, Park, summit, or location contains".
- schema: reference "Bunker references, comma separated.", place_name "Name of the first bunker.",
  state and url have no value.

### Also

- `web/scripts/invoke-function.ts` and `web/package.json` get `invoke:wwbota`.
- `supabase/seed.sql` gets a few WWBOTA spots (calls ending in `S`).
- Row counts in `smoke-test.sql`, `readmodels_auth.test.sql` and `archive.test.sql` go up by one.
- A new pgTAP suite, `supabase/tests/wwbota.test.sql`, covers the checks, the `ingest_state` row,
  opt-in `source_matches`, the reference rule on a later bunker, rendering, the slice length and
  `archive_status`.
- Database types are regenerated.
- Docs: README, ARCHITECTURE, OPERATIONS and CLAUDE.md.

## Not in this change

- **Stats peer** (see Decisions).
- **Band map.** It stays POTA, SOTA and DX Cluster.
- **Bunker positions.** Latitude, longitude and locator stay in `raw_payload`.
- **SSE.** The stream would save a poll a minute but needs a held connection; polling fits the
  Edge Function shape.

## Rollout

1. Merge. The migration applies and the cron job starts calling `ingest-wwbota`, which 404s until
   step 2.
2. `supabase functions deploy ingest-wwbota`, then redeploy every function (shared code changed).
3. Check `ingest_health` for `wwbota` and the catalog tile after a few minutes.
