# Callsign lookup and public profiles: design

Date: 2026-10-12. Status: approved.

## Purpose

Anyone can look up a callsign and get a public, shareable page (`/call/KK4PWJ`). The page sums up
everything Long Lines has heard from that station since Long Lines started:

- how much POTA, SOTA and RBN activity it has
- which bands and modes it uses, and at what hours
- where it activates
- which countries it is heard from
- its FCC license details

Profiles are an aggregator. They show **counts and breakdowns, never every spotter forever**. The
raw record stays in the Storage archive, so later analysis can read it there.

Profiles must pick up new sources automatically. A source added to the system shows up in
profiles without any profile code changing.

## What this document is

The original spec, "Long Lines: Callsign Lookup and Public Profiles", Parts A and B, came with
screenshots of a mock. It defines the layout, routes, FCC fields, caching, rate limiting, hidden
callsigns, Get alerts and Share. **It still applies wherever the overrides below don't replace
it.** No updated `docs/ui-mock.html` exists, so the copy section of this document is the copy
source for the lookup and profile screens.

## Overrides to the original spec

| Topic | Original spec | Decided |
|---|---|---|
| History | Last 30 days | All time, served from permanent rollups |
| Sources | POTA, SOTA and RBN hard-coded | Generic. Profiles read one `spot_stream` view; a source writing `raw_spots` appears automatically. |
| RBN data | Assumed to be in `raw_spots`; add `snr_db` there | `raw_spots` holds only copies of watched-callsign RBN spots. The full feed is `rbn_spots` (it already has `snr`), kept for 7 days. Rollups make its history permanent. |
| Matching | Compare subscription callsigns to `base_callsign` | **Exact OR base.** `KK4PWJ` catches `KK4PWJ/P`; a `KK4PWJ/P` subscription still catches only `/P`. The RBN watched filter moves into SQL (`watched_among`). |
| Where heard from | Not covered | Country and continent of each spotter, taken from a cty.dat prefix table |
| License data | `fcc_licenses` | `callsign_licenses` with an `authority` column, so other countries' registries can be added later. FCC is the only loader for now. |
| Heard by | Top 10 RBN skimmers in the window | Top 10 spotters or skimmers over the **last 7 days**, read live. No per-spotter data is kept past retention. |
| Part B (Stats) | Rework the page for RBN and public access | Already shipped in #38. What remains: callsigns link to profiles, and `rbn.topStations` groups by base callsign. |

## Design

### Base callsigns

`base_callsign(text)` normalises a callsign in four steps:

1. Uppercase and trim.
2. Split on `/`.
3. Drop the parts `P`, `M`, `MM`, `AM`, `QRP`, `R` and any single digit.
4. Return the longest remaining part. On a tie, prefer the part with a digit after a letter, then
   the later part.

Supporting pieces:

- `raw_spots.base_callsign` is a stored generated column, indexed together with `spot_time`.
- `rbn_spots` gets an expression index on the base callsign in the PR whose profile queries read
  it (building it locks RBN inserts). `raw_spots.spotter` gets one only if a query needs it.
- Searching `KK4PWJ/P` opens `/call/KK4PWJ`. TypeScript never implements this rule.

### Spot stream

`spot_stream` is a service-role view. It gives every source one row shape:

| Column | Notes |
|---|---|
| `source`, `spot_time` | |
| `callsign`, `base_callsign` | |
| `spotter`, `spotter_base` | |
| `band`, `mode`, `mode_bucket` | |
| `snr` | |
| `program`, `reference`, `reference_name`, `reference_location` | |

It unions two inputs:

- `raw_spots` where `source <> 'rbn'`. RBN rows in `raw_spots` are copies and are left out.
- `rbn_spots`.

A new firehose table needs one `union all` arm. A new `raw_spots` source needs nothing.
`mode_bucket(text)` returns `CW | SSB | FT8/FT4 | FM | Other`. It is the Stats grouping, moved into
one function that both Stats and profiles use.

### Rollups (permanent, service-role only)

| Table | Grain | Used for |
|---|---|---|
| `callsign_activity` | period (day or month), base, role (heard or spotter), source, band, mode bucket → spots, `hours[24]` | Totals, sources, bands, modes, hour of day, activity charts, hunting |
| `callsign_reach` | period, base, source, spotter country, continent → spots | Heard from |
| `callsign_references` | base, program, reference → name, location, days, spots, first and last day | Activations, state map |
| `callsign_seen` | base → first and last spot, last frequency and mode, days on air | Header, KPIs |
| `callsign_variants` | base, callsign → spots, last day | "Also heard as" |
| `callsign_rollup_days` | day → rolled_at | Marker |

- **Nightly run.** `rollup_callsign_day(day)` runs nightly inside `maintain_rbn_spots()` (03:35 UTC)
  for every completed day that has no marker.
- **Compaction.** Day rows older than 35 days are compacted into month rows.
- **RBN retention.** An archived RBN day is retired when it has a marker, or once it is 14 days
  old regardless. The retention half ships first, in `20261012000010`, so no RBN day is lost
  while the rollups are being built, and a late rollup release cannot stop retention.
- **Backfill.** `backfill_callsign_rollups()` is a manual operator step.

### Live edge

Days without a marker (today, plus yesterday before 03:35) are read live from `spot_stream`
through the base-callsign indexes. "Heard by" (top 10, last 7 days) and "Recent spots" (newest
25) are always read live.

### Profile access

- `callsign_profile(p_callsign) returns jsonb` is security definer and is not granted to clients.
- Clients call the `callsign-profile` Edge Function. It:
  - validates input, returning 400 for invalid input
  - rate-limits each IP to 30 requests a minute, returning 429 with "Too many lookups. Try again
    in a minute."
  - caches profiles in the database for 15 minutes
  - sends `Cache-Control: public, max-age=300`
- `hidden_callsigns` is managed by the operator. A hidden call returns exactly the not-heard shape
  with no license.

### Licenses

`callsign_licenses` has these columns, readable by `anon` and `authenticated`:

| Column | Notes |
|---|---|
| `callsign` | Primary key |
| `authority` | `FCC` for now |
| `name` | |
| `operator_class` | |
| `status` | |
| `granted_on`, `expires_on` | |
| `country`, `state`, `grid` | |
| `loaded_at` | |

Loading works like this:

- A weekly job in the Fly relay app streams `l_amat.zip` and reads `HD`, `EN` and `AM`.
- It loads in batches through a service-role RPC, then swaps the loaded set in within one
  transaction.
- Nothing else from ULS is stored: no address, city, ZIP, FRN, phone, email or PO box.

## Copy

The following copy is transcribed from the screenshots of the mock. Wording that changes because
the window is now all time is marked (changed).

**Public app bar:** Long Lines · Stats · Lookup · Sign in. Below `md` these are icons only.
**Landing page buttons:** "View the last 7 days of activity" · "Look up a callsign".
**Signed-in nav:** "Callsign lookup", after Stats.

**Lookup page**
- Title: "Callsign lookup"
- Description (changed): "See what Long Lines has heard from any station: license details from
  the FCC, plus every spot since Long Lines started. Every profile has its own link you can share."
- Field placeholder: "Callsign, like KK4PWJ". Button: "Look up".
- Chips heading: "Busy this week". The chips are the current Stats snapshot's top activators.

**Profile page**
- **Header:** the callsign, then the name. Chips for class, state or country, and "Last heard
  14:32 UTC today on 14.062 MHz CW". Buttons: "Get alerts" ("Sign in to get alerts" when signed
  out) and "Share". The canonical URL appears in small text.
- **KPIs:**
  - Spots ("All time" (changed))
  - Days on the air
  - Heard from ("N countries" (changed), detail "N continents")
  - Activations ("3 parks, 2 summits")
- **License:** "From the FCC Universal Licensing System. Refreshed weekly." Rows: Name, Class,
  Status, Granted, Expires, State.
- **Activity (changed):** "Spots per month, since Long Lines started". A second chart is titled
  "Last 30 days" with "Spots per day".
- **When they're on the air (changed):** "Spots by hour of day (UTC). Useful for knowing when to
  listen."
- **Bands:** "All sources". **Modes:** "Share of spots".
- **Where they've activated (changed):** "Parks and summits". Columns: Reference, Name, Program,
  Times, Last. Map legend: "activations".
- **Heard from (new):** "Countries the spotters and skimmers who heard this station are in".
- **Hunting (new):** "Spots this station posted for other activators".
- **Heard by (changed):** "Spotters and skimmers that picked up this station in the last 7 days".
  Columns: Spotter, Spots, Best SNR, Top band. The Location column is dropped.
- **Recent spots:** "Newest first". Columns: Time (UTC), Callsign, kHz, Band, Mode, Reference,
  Source, Spotter.
- **Footer:** "License data comes from the public FCC database. Long Lines never shows street
  addresses. To have this page hidden, email {CONTACT_EMAIL}."

**States**
- Invalid input: a warning and a search box.
- No license, non-US prefix: "No FCC record. This looks like a callsign issued outside the United
  States."
- No license, US prefix (`K`, `N`, `W`, `AA`–`AL`): "No FCC record found for this callsign."
- Not heard: the header, the license card and a quiet message. No empty charts.

**Toasts:** "Link copied." · "Add a destination to start getting alerts."

## Delivery

Seven PRs, in this order:

1. Base callsigns, matcher, retention guard (this document lands here)
2. cty.dat country import; drops `watched_callsigns()`, which PR 1 keeps so the database and
   `ingest-rbn` can deploy in either order
3. Spot stream and rollups
4. FCC license import
5. Profile backend and Edge Function
6. Web
7. Stats: links and base-callsign grouping
