# IOTA (Islands on the Air) as a tag on DX Cluster spots

Date: 2026-10-27

## Goal

Long Lines recognises Islands on the Air activity. IOTA is an award program for operating from
island groups, each identified by a reference such as `EU-005` (Great Britain) or `AN-010` (South
Shetland Islands): a continent code, a dash and three digits.

IOTA has no spot feed. Its site (iota-world.org) publishes the reference list only. Activators are
spotted on the DX Cluster with the reference in the comment ("CQ from Arctowski (AN-010)-UP"). This
change reads that reference out of DX Cluster comments, as Spothole does, and makes it matchable,
deliverable and visible on profiles. WWBOTA (`2026-10-26-wwbota-design.md`) is the model for the
read side.

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| Shape | A tag on DX Cluster spots, Spothole-style, not a source of its own. A spot is stored once, as `dxcluster`, with `iota_reference` set. |
| Connections | A new rule field, "IOTA island", with `is` / `is_not`. Values are references (`EU-005`) or continents (`EU`); the editor offers "Any island", which fills all seven continents. The "Park, summit, or location" rule also searches islands. A connection still has to list DX Cluster to get these spots (DX Cluster is opt-in). |
| Profiles and group statistics | Like WWBOTA: `spot_stream` program `'IOTA'`, so islands show on callsign profiles, and group statistics gain IOTA activations and an islands count. |
| Island names | Our own small import: an `import-iota` Edge Function loads iota-world.org's `groups.json` into `iota_groups` monthly, like the cty.dat import. It can move into the reference catalog (`2026-10-26-reference-profiles-design.md`, which leaves room for `iota`) once that lands. |

## How Spothole does it

Spothole (`data/spot.py`, `infer_activities`) tags any spot whose comment holds a reference matching
`(?:AF|AN|AS|EU|NA|OC|SA)\-\d{3}`, case-insensitive, between non-word characters. IOTA references are
"globally unique" there, so no "IOTA" keyword is needed; a reference after "IOTA " or "IOTA-" is
found by the same match. Names come from `groups.json`, re-read about once a year.

## Upstream: the reference list

`GET https://www.iota-world.org/islands-on-the-air/downloads/download-file.html?path=groups.json`
returns a JSON array of the IOTA groups (1,178, 294 KB, sampled 2026-10-27). No key; served with
`Cache-Control: no-cache, private` and no `Last-Modified` or ETag.

```json
{"refno": "AF-001", "name": "Agalega Islands", "dxcc_num": "4", "latitude_max": "-10.75",
 "latitude_min": "-10.00", "longitude_max": "57.00", "longitude_min": "56.25", "grp_region": "",
 "whitelist": "0", "pc_credited": "37.2", "comment": ""}
```

Every `refno` matches `^(AF|AN|AS|EU|NA|OC|SA)-\d{3}$`; names are at most 85 characters. Only
`refno` and `name` are kept.

## Shape

### Extraction (`_shared/iota.ts`)

- `iotaReference(comment)`: the first match of `(?<![A-Za-z0-9_])(AF|AN|AS|EU|NA|OC|SA)-(\d{3})(?![A-Za-z0-9_])`,
  case-insensitive, uppercased; null when there is none. Only the dash form counts, as in
  Spothole: `EU005` and `EU 005` are not taken, to keep false matches out.
- The DX Cluster adapter sets `iota_reference` from the comment. The content hash is unchanged (the
  reference comes from the comment, which is already hashed), so no stored spot looks new.
- Only DX Cluster: other sources' comments are not read for IOTA in this change.
- DXSpider cuts comments at 30 characters, so a reference past that point is lost; nothing to do.

### Island list (`_shared/iota.ts`, `import-iota`)

- `parseIotaGroups(body)`: Zod (`z.looseObject`, third-party data) over the array, keeping `refno`
  (uppercased, must match the pattern) and `name` (trimmed, non-empty). A row that fails is an
  error for the whole file.
- `import-iota` (service role, `verify_jwt = true`, `isServiceRole`, wrapped in `timed`): fetches
  the file with User-Agent, parses it, refuses fewer than 1,000 groups (a truncated or wrong file),
  and calls `load_iota_groups(p_groups jsonb)`, which replaces `iota_groups` in one transaction and
  records the load in `iota_load`. Any failure leaves the list as it was and answers 500.
- pg_cron `import-iota` on the 1st of each month at 04:25 UTC through `cron_call_function`. Run it
  once by hand after the first deploy.

### Schema (one migration)

- `iota_groups (refno text primary key check (refno ~ '^(AF|AN|AS|EU|NA|OC|SA)-[0-9]{3}$'), name text not null)`
  and `iota_load (id boolean primary key, loaded_at, groups)`: RLS on, no policies, no client grants.
- `raw_spots` gains `iota_reference text` and `iota_reference_name text`. `NormalizedSpot` gains
  `iota_reference`; the name is SQL's.
- `ingest_spots` stores `iota_reference` and fills `iota_reference_name` from `iota_groups` as it
  inserts. A spot ingested before the first import keeps a null name.

### Matching

- `normalize_subscription_rules` accepts field `island` with `is` / `is_not`. Values are uppercased
  and must each be a reference or a continent code ("An IOTA island rule takes references such as
  EU-005 or continents such as EU.").
- `rule_matches`: `island` passes a spot whose `iota_reference` equals a reference value or starts
  with a continent value and a dash. A spot without a reference has no island, so it passes
  `is_not` and fails `is`, as a spot without a band does for `band`.
- The reference rule's haystack adds `iota_reference`.
- `preview_subscription` adds the two keys to its spot JSON.
- Web: "IOTA island" shows only when the sources list DX Cluster (`fieldsFor`). Its values are
  chips: continents offered by name, references typed, and "Any island" fills all seven.
  Help text: "Matches the IOTA reference in a DX Cluster spot's comment, such as EU-005, or every
  island on a continent." The reference rule's help becomes "Matches POTA references and
  locations, SOTA summit codes, WWFF references, WWBOTA bunkers and IOTA islands."
- `docs/openapi.yaml` lists the field.

### Delivery

- `delivery_spot_json` and `push_sample_spot` add both keys; `DeliverySpot` gains them (optional,
  for rows claimed before the migration).
- `render_push_field`: `reference` falls back to `iota_reference` after WWBOTA, and `place_name` to
  `iota_reference_name`. Webhooks, Discord and push render through it. No source URL.
- `format.ts` legacy embed and push facts add "IOTA" and "Island".

### Read models

- `recent_spots` gains the two columns; `list_recent_spots('iota')` returns DX Cluster spots with an
  IOTA reference (the IOTA catalog page's recent spots).
- `callsign_group_rows`' on-air reference falls back to `iota_reference`.
- `web/src/sources/spots.ts` `spotReference` falls back to `iota_reference`.

### Archive

`archive_columns` and `SPOT_COLUMNS` add the two columns for every `raw_spots` source;
`archive_convert`'s `LATER_COLUMNS` adds them. `iota_groups` is not archived.

### Profiles and group statistics

- `spot_stream`: program `'IOTA'` when `iota_reference` is set (after POTA, SOTA, WWFF, WWBOTA),
  `reference` and `reference_name` likewise.
- `group_statistics_at`: `kpis.activations.iota` and `kpis.places.islands`; the page names them
  only when nonzero ("26 POTA, 5 SOTA, 1 IOTA"; "19 parks, 3 summits, 1 island"). The places card
  subheader becomes "Parks, summits, bunkers and islands the club activated in the period".
- Profile: `PROGRAM_NOUNS.IOTA` is "IOTA island(s)"; the references card subheader becomes
  "Parks, summits, WWFF references, bunkers and islands, most recent first."

### Stats

`daily[].iota` and `hourly[].iota` count DX Cluster spots with an IOTA reference, from their own
CTEs, for the catalog's rates only. Not a Stats peer.

### Catalog (`web/src/sources/sources.ts`)

- `SourceInfo.via`: the source whose spots carry this one (null for the rest). With `via`, the
  entry is not offered as a connection source (`LIVE_SOURCES`), its status is the `via` source's
  health, and "Create connection" opens a DX Cluster connection.
- The `iota` entry: name "IOTA", full "Islands on the Air", interval "streaming", `pollSeconds: 60`,
  `statsKey: "iota"`, `site: "www.iota-world.org"`, mark "IO", `via: "dxcluster"`,
  desc "Island references in DX Cluster spots".
- runBy: operator "IOTA Ltd (iota-world.org)"; feed "DX Cluster spots that name an IOTA reference";
  modes "CW, SSB, digital".
- tagline: "Island activations, read from DX Cluster spots."
- about:
  - "Islands on the Air is an award program for operating from the world's island groups, each with a reference such as EU-005. IOTA has no spot feed of its own: activators are spotted on the DX Cluster with the reference in the comment."
  - "Long Lines reads the reference out of every DX Cluster spot and names the island group from the IOTA list, refreshed monthly. To get these spots, make a DX Cluster connection with an IOTA island rule."
- showsUp: "Callsign profile: last heard, references, activity"; "Connection filters: IOTA island, Park, summit, or location contains".
- schema: the DX Cluster delivered spot, with reference "IOTA reference." and place_name "Island group name."; source is `"dxcluster"`.

### Also

- Seed: the island groups the seed's DX spots name, and a few DX spots with IOTA references.
- pgTAP `iota.test.sql`; the suites pinning key sets, row shapes and rules change with it.
- Database types regenerated; docs (README, ARCHITECTURE, OPERATIONS, WEBHOOKS, openapi, CLAUDE.md).

## Not in this change

- IOTA in POTA, SOTA, WWFF or WWBOTA comments.
- Loose forms (`EU005`, `EU 005`) and more than one reference per spot (the first is kept).
- The band map, and Stats beyond the catalog rates.
- Island positions (`groups.json` has bounding boxes; not stored).

## Rollout

1. Merge. The migration applies; the `import-iota` cron job 404s until step 2.
2. `supabase functions deploy import-iota`, then redeploy the functions whose shared code changed
   (`ingest-dxcluster`, `archive`, `api`, `send-test`, `convert-archive`). Run `import-iota` once.
3. The relay ships on merge but does not change.
