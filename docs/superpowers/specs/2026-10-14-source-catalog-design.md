# Source catalog

Date: 2026-10-14

## Goal

Build Page 2 of the Long Lines design canvas ("Source catalog (draft)"): the Sources page becomes a
catalog of source tiles, and each live source gets a detail page with its rates over the last seven
days, the shape of a delivered spot, what the source is, who runs it and where it shows up in Long
Lines. Today's recent-spots table and last-fetch freshness move onto the detail pages.

The canvas is the design and copy source for these screens, the way Brad's tokens mockup is for
`web/src/tokens/`. Copy is kept word for word except where the mock describes something Long Lines
does not do; every such change is listed under "Copy changes from the mock".

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| Recent spots and last fetch | Move to each source's detail page. Catalog tiles keep the Connected/Delayed chip. |
| Where rates come from | The stats snapshot's `hourly` series (approach A). No new RPC, no polling of rates. |
| DX Cluster rates | Add `dx` to the snapshot's `daily` and `hourly`. |
| Schema and example spot | The delivered spot (`DeliverySpot`, as in `docs/WEBHOOKS.md`), not the mock's field names. |
| "Connections", band map | Say "subscription"; leave out band map mentions until Page 3 and the band map exist. |
| APRS-IS | Gets a tile and a detail page: high volume, stored only, not in subscriptions. |

## Routes

- `/sources` is the catalog (`SourcesPage`).
- `/sources/:id` is a detail page (`SourceDetailPage`) for a live source: `pota`, `sotawatch`,
  `rbn`, `dxcluster`, `aprs`. An unknown id or a planned source (`wwff`, `pskreporter`) redirects to
  `/sources`.
- Both stay behind sign-in (`RequireAuth page="sources"`), so the Sources nav item stays selected on
  detail pages. `App.tsx` gains one `<Route path="/sources/:id">`.

## Components (`web/src/sources/`)

- **`SourcesPage.tsx`** (rewritten): title and lead, the high volume `Alert` (severity `warning`), a
  small outlined "Search sources" `TextField`, filter `Chip`s All / Connected / Not yet available,
  then a `Grid` of tiles (`size={{ xs: 12, sm: 6, md: 4 }}`). Search matches the tile title, short
  name and tagline, case-insensitive. Filtering is in memory. When nothing matches: "No sources
  match."
- **`SourceTile.tsx`**: mark, title, tagline, status chip, volume chip, and the seven-day average
  ("36 spots/hour", "1,042 spots/min"). A live source's tile is a `CardActionArea` linking to
  `/sources/<id>`; a planned source's tile is not a link and uses `color="text.secondary"` text.
- **`SourceDetailPage.tsx`**, top to bottom:
  1. `Breadcrumbs`: "Sources" (link) › title.
  2. Header: large mark, `h4` title, status and volume chips, tagline, and an outlined
     "Visit <site>" button (`OpenInNew` icon, `target="_blank" rel="noopener"`) when the source has
     a site.
  3. The source's volume `Alert` (RBN and APRS-IS only; text below).
  4. Four figure cards: "Average, 7 days", "Peak, 7 days", "Minimum, 7 days", "Busiest moment".
  5. Two columns (`Grid size={{ xs: 12, md: 8 }}` / `{{ xs: 12, md: 4 }}`). Left: Rate over time,
     Schema, Example spot, Recent spots. Right: About this source, Run by, Where it shows up.
  6. APRS-IS has no Schema, Example spot or Recent spots cards; its About text says why.
- **`RateChart.tsx`**: `@mui/x-charts` `LineChart` (area, the source's mark colour) over the 168
  hourly values, x axis labelled by day ("Oct 8"), the peak marked with a mark in the theme's error
  colour and the label "Peak 11.8 / min" (or "Peak 88 / hour").
- **`rates.ts`**: pure rate maths and formatting (below).
- **`useIngestHealth.ts`**: `loadIngestHealth` once (catalog) or every 30 s while the browser tab is
  visible (detail page), the pattern today's page uses.
- **`sources.ts`**: `SourceInfo` gains the catalog fields (below). Existing fields and
  `LIVE_SOURCES`, `sourceName` stay as they are; subscriptions and stats still use them.

The detail page's Recent spots card is today's: `loadRecentSpots(id)` every 30 s while visible,
rendered by `SpotsTable` with "Recent spots" / "Everything ingested, before any subscription
filters." Under the table: "Last fetch <relative age>, <interval>" from ingest health.

## Data

### Rates

`useStats()` (shared with `/stats`, so the two pages share one fetch an hour through
`stats/cache.ts`) supplies `payload.hourly`: 168 complete UTC hours, oldest first, zero-filled.

Each live source has a `statsKey`: `pota`, `sota`, `rbn`, `dx` or `aprs`. Planned sources have none.

`sourceRates(hourly, key, volume)` returns `null` when the snapshot has no `key` on its entries
(written before the `dx` migration), else:

- `series`: the 168 values, per hour for standard volume, per minute (count ÷ 60) for high volume
- `average`: mean of `series`
- `peak`, `peakHour`: the largest value and its hour; the earliest hour wins a tie
- `minimum`: the smallest value
- `perDay`: total ÷ 7 (used in the volume alert)

`formatRate(n)`: one decimal below 10 ("4.8", "0.4"), whole numbers with thousands separators from
10 ("36", "1,042"). Units: "spots/hour" / "spots/min" on tiles, "/ hour" / "/ min" on figure cards
and the peak label ("36 / hour"). `formatHour(iso)`: "Oct 12, 14:00 UTC", always UTC, because the
buckets are UTC hours. `formatPerDay(n)`: below a million, two significant figures with separators
("4,600"); from a million, one decimal and "million" ("1.5 million").

States: while stats load, the figure cards and chart show a `Skeleton`. No snapshot, or `null`
rates: figure cards show "–", the chart area says "No rates yet. They appear after the next hourly
stats refresh.", tiles hide the rate. Stats fail to load: an `Alert` "Couldn't load rates." in the
rates area; the rest of the page renders.

### Status

- Live source: "Connected" (`color="success"`); "Delayed" (`color="warning"`) when
  `seconds_since_last_success` is null or over 3 × `pollSeconds`, today's rule.
- Planned source: "Not yet available" (outlined).
- If ingest health fails to load: `Alert` "Couldn't load sources." and live sources show
  "Connected".
- Filter chips: Connected shows every live source, delayed or not; Not yet available shows planned
  ones.

### SQL: `20261014000200_stats_dxcluster.sql`

`create or replace function refresh_stats_snapshot()`, copied from
`20261014000030_stats_aprs.sql` with one addition:

- `daily_dx`: `raw_spots where source = 'dxcluster'` per UTC day in the window.
- `slot_dx`: the same per hour over `v_hour_start .. v_hour_end`.
- `daily[]` and `hourly[]` entries gain `'dx'`, zero-filled.

DX Cluster stays out of `in_window` and `spots`, so `totals`, `peakHour`, `busiestSlot`, `bands`,
`modes` and the top lists are unchanged. Both CTEs use `raw_spots_spot_time_idx`. The function keeps
its grants and pinned `search_path`. `web/src/stats/types.ts` gains `dx: number` on `daily` and
`hourly` entries, and `supabase/tests/stats_snapshot.test.sql` pins it. The Stats page does not show
`dx`.

## `SourceInfo` additions

```ts
volume: "standard" | "high";
title: string;        // tile and page heading: "Parks on the Air", "SOTA", "Reverse Beacon Network"
tagline: string;      // one line under the title
mark: string;         // two letters
markColor: "primary" | "secondary" | "warning" | "success" | "default";
statsKey: "pota" | "sota" | "rbn" | "dx" | "aprs" | null;
site: string | null;  // "pota.app"; the Visit button links to https://<site>
runBy: { operator: string; feed: string; modes: string };
about: string[];      // paragraphs
showsUp: string[];
schema: SchemaField[] | null;   // null for APRS-IS
example: Record<string, unknown> | null;
```

`SchemaField` is `{ name, type, description, derived }`.

## Copy

### Catalog

- Title: "Sources"
- Lead: "Where spots come from. Pick a source to see what it sends and what you can do with it."
- Alert title: "High volume sources require a callsign filter"
- Alert body: "They send thousands of spots an hour. A subscription to one must include a callsign
  rule, so it only passes spots for the stations you name."
- Search label: "Search sources". Chips: "All", "Connected", "Not yet available".
- Volume chips: "Standard volume", "High volume".

### Per source

| | POTA | SOTA | RBN | DX Cluster | APRS-IS |
| --- | --- | --- | --- | --- | --- |
| Title | Parks on the Air | SOTA | Reverse Beacon Network | DX Cluster | APRS-IS |
| Mark, colour | PO, primary | SO, secondary | RB, warning | DX, success | AP, warning |
| Volume | standard | standard | high | standard | high |
| Site | pota.app | sotawatch.sota.org.uk | reversebeacon.net | none | aprs2.net |
| Operator | Parks on the Air | Summits on the Air | Reverse Beacon Network volunteers | Volunteer cluster node operators | APRS-IS tier 2 network volunteers |
| Feed | Spot list, polled every 60 seconds | Spot list, polled every 30 seconds | Telnet stream of skimmer spots | Telnet stream from a DXSpider node | Full feed over TCP, receive only |
| Modes | CW, SSB, digital | CW, SSB, FM, digital | CW, RTTY | Any, as the spotter enters it | APRS packets |

Planned tiles: WWFF (WW, default, standard), "World Wide Flora and Fauna activations."; PSK
Reporter (PS, default, high), "Digital-mode reception reports from monitoring stations."

Taglines:

- POTA: "Activators in parks, self-spotted and spotted by hunters."
- SOTA: "Activators on mountain summits around the world."
- RBN: "CW and RTTY signals heard by skimmers around the world."
- DX Cluster: "Spots entered by operators and shared across cluster nodes."
- APRS-IS: "Position, weather and message packets from the worldwide APRS-IS network."

About this source:

- POTA: "Parks on the Air is a program where operators activate parks and other operators hunt
  them. Activators and hunters post spots to the POTA spotting page as they operate." / "Long Lines
  stores every POTA spot, keeps the park details, and shows them on profiles and in Stats."
- SOTA: "Summits on the Air is an award program for portable operation from mountain summits.
  Activators and chasers post spots to SOTAwatch as they operate." / "Long Lines stores every
  SOTAwatch spot, keeps the summit reference, and shows them on profiles and in Stats."
- RBN: "The Reverse Beacon Network is a network of automated receivers, called skimmers, that
  listen across the bands and report every CW and RTTY signal they decode, with signal strength and
  speed." / "Long Lines stores every RBN spot. You see them on a callsign profile under \"Heard by\"
  and in Stats."
- DX Cluster: "A DX Cluster is a network of nodes where operators post the stations they hear,
  often rare or distant ones, for everyone connected to see." / "Long Lines stores every DX Cluster
  spot and shows them on profiles. Only subscriptions that pick DX Cluster get them."
- APRS-IS: "APRS-IS links the world's APRS radio networks over the internet. Igates forward the
  packets they hear, from positions and weather reports to messages." / "Long Lines stores every
  packet on the full feed for about two days and archives it after that. Packets are not spots:
  they never reach profiles or subscriptions, so there is no schema or recent spots list here. You
  see them in Stats."

Where it shows up:

- POTA: "Callsign profile: last heard, parks and summits, activity" / "Stats: POTA activity by
  state, most spotted parks and summits" / "Subscription filters: Bands, Modes, Callsigns, Callsign
  groups, Park, summit, or location contains"
- SOTA: "Callsign profile: last heard, parks and summits, activity" / "Stats: top SOTA
  associations, most spotted parks and summits" / "Subscription filters: Bands, Modes, Callsigns,
  Callsign groups, Park, summit, or location contains"
- RBN: "Callsign profile: Heard by, last heard, activity" / "Stats: RBN skimmers, most heard on RBN"
  / "Subscription filters: Bands, Modes, Callsigns or Callsign groups (required)"
- DX Cluster: "Callsign profile: last heard, activity" / "Subscription filters: pick DX Cluster
  under Sources, then Bands, Modes, Callsigns, Callsign groups" / "Not in Stats"
- APRS-IS: "Stats: APRS-IS packets, stations, igates and packet types" / "Not on profiles or in
  subscriptions"

Volume alerts (detail pages):

- RBN, title "High volume source: a callsign filter is required", body "Reverse Beacon Network
  sends about <perDay> spots a day. A subscription only gets its spots if it names callsigns, typed
  or through a group. One that lists only RBN can't be saved without them." When rates are `null`,
  the first sentence is left out.
- APRS-IS, title "High volume source: stored only", body "APRS-IS sends about <perDay> packets a
  day. Long Lines stores and archives them but does not match them, so they can't be used in
  subscriptions."

Cards:

- "Rate over time" / "Last 7 days. The red dot marks the busiest moment, so you can size downstream
  systems for it"
- "Schema" / "Every field on a <title> spot, as a webhook receives it."
- "Example spot" / "How a webhook receives a spot"
- "About this source", "Run by" (rows "Operator", "Website", "Feed", "Modes"), "Where it shows up"

### Schema rows

Every source with a schema lists these, in this order, then its own fields:

| Field | Type | Description | Derived |
| --- | --- | --- | --- |
| `id` | integer | Unique id Long Lines assigns to the spot. | yes |
| `source` | string | Always "<id>" for this source. | |
| `spot_time` | datetime | When the source reported the spot, in UTC. | |
| `callsign` | string | Callsign that was spotted, as spotted. | |
| `base_callsign` | string | The call without prefixes or suffixes; profiles are keyed on it. | yes |
| `spotter` | string | Callsign of the person who posted the spot. | |
| `frequency_khz` | number | Frequency in kHz. | |
| `band` | string | Amateur band, worked out from the frequency. | yes |
| `mode` | string | Operating mode as the spotter entered it, lower case. | |
| `mode_family` | string | cw, phone or digital, worked out from the mode. | yes |
| `comment` | string | Free text from the spotter. | |

Per-source changes:

- POTA adds `pota_reference` ("Park reference."), `pota_park_name` ("Park name."), `pota_location`
  ("Park locations as POTA lists them, comma separated.").
- SOTA adds `sota_summit_ref` ("Summit reference.").
- RBN: `spotter` is "Callsign of the skimmer that heard the signal."; `comment` is "Signal strength
  and speed as the skimmer reported them."; `mode` is "CW or RTTY, as the skimmer decoded it.".
- DX Cluster: `mode` is "From the comment, else the band plan." and Derived.

A line under the table: "Fields for other programs are present and null." The `mode_family` values
come from `_shared/modes.ts`; the implementation checks the description against it.

Example spots are static objects in the `WEBHOOKS.md` shape, using the mock's values where they fit
(KK4PWJ on 14062.0 kHz, US-2763, Falls Lake SRA).

## Copy changes from the mock

| Mock | Ships as | Why |
| --- | --- | --- |
| "A connection to one must include a callsign rule" | "A subscription to one …" | No Connections yet |
| RBN "about 4,600 spots a day … or Long Lines will not let you save it" | Live per-day figure; the matching and save rules as they are | `spot_matches` and `subscriptions_rbn_needs_callsign` |
| RBN "CW and digital signals", modes "CW, RTTY, PSK" | "CW and RTTY" | The relay reads port 7000 (CW and RTTY) |
| RBN "It is a firehose, so RBN spots are not shown on the band map." | Dropped | No band map yet |
| POTA "shows them on the band map, on profiles and in Stats", "Band map (middle lane)" | Band map dropped | No band map yet |
| "Connection filters: … State, County, Grid square, Skimmer …" | "Subscription filters:" with the real fields | Those filters don't exist |
| Schema "You can use these fields in connection filters." | "… as a webhook receives it." | Not every field is a filter |
| Schema fields (`spot_id`, `received_at`, `skimmer`, `snr_db`, …) | The delivered spot's fields | Brad's decision |
| "Example spot / How Long Lines stores a spot" | "How a webhook receives a spot" | It shows the delivered shape |
| Mock rates (3.2 / min for RBN, …) | Live figures | Placeholders |

## Testing

- `rates.test.ts` (node): a fixed 168-hour array; per-hour and per-minute series; average, peak,
  minimum, earliest-wins tie; a missing key returns `null`; an all-zero week; `formatRate` either
  side of 10; `formatPerDay` either side of a million; `formatHour` in UTC.
- `sources.test.ts`: every live source has a title, tagline, mark, `statsKey` and run-by rows;
  every live source but APRS-IS has a schema and example whose keys match the schema; planned
  sources have no `statsKey`; only RBN, APRS-IS and PSK Reporter are high volume.
- `SourcesPage.test.tsx` (rewritten): tiles from mocked `loadIngestHealth` and `loadLatestStats`;
  the Delayed chip; search and each filter chip; "No sources match."; live tiles link to
  `/sources/<id>`, planned tiles don't; the phone layout via `setMobile(true)`; the ingest error.
- `SourceDetailPage.test.tsx`: RBN (alert with the per-day figure, figure cards, schema rows, peak
  label); POTA (its fields, recent spots, last fetch); APRS-IS (no schema, example or recent spots);
  DX Cluster with a pre-migration snapshot ("–" and the no-rates text); stats failing; an unknown
  and a planned id redirect; the refresh timer stops on unmount.
- `stats_snapshot.test.sql`: a DX Cluster spot in the window counts in `daily[].dx` and
  `hourly[].dx` and not in `totals.spots` or `busiestSlot`; every entry has `dx`.
- Gates: `npm run test:all`, web coverage at 80% or more, `npm run build`, `npm run lint`,
  `supabase db lint`, `scripts/smoke-test.sql`.

## Delivery

One branch, `source-catalog`, one PR. The migration is applied to the hosted project by the GitHub
integration on merge, and the web deploys through Vercel. Nothing changes in `relay/` or the Edge
Functions.

CLAUDE.md gains a short "Source catalog rules" section: catalog copy lives in `sources.ts` and
follows the canvas's Page 2; rates come only from the stats snapshot through `useStats()`; the
schema describes the delivered spot, so a new `DeliverySpot` field is added there too.

## Out of scope

Connections (canvas Page 3), the band map, WWFF and PSK Reporter ingest, live (sub-hour) rates,
showing `dx` on the Stats page, and any change to what is stored or delivered.
