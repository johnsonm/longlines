# Reference profiles: design

Date: 2026-10-26. Status: **accepted; building** (PR 2 onward). Brad decided the four points
under Purpose on 2026-10-26 and accepted decisions 1 to 10 with the spec PR (#265). Decisions 11
to 14 come from the canvas. If the design changes during a PR, update this file in that PR.

Source: Brad's "Reference profiles" design canvas
(`https://claude.ai/artifact/2UFYsSb2YAS5QW8ZJorKKc`): the reference page on desktop and phone,
the header and empty states, link previews and the delivery field, and the Reference lookup page
on desktop and phone. Its copy is this file's Copy section. Where the canvas and this file
disagree, this file wins.

## Purpose

Long Lines builds a profile for every callsign (`/call/<base>`). It has nothing for the places
those stations operate from. A park, summit or WWFF reference shows up only as plain text in the
profile's "Where they've been spotted" table, in Stats "Most spotted parks, summits and WWFF
references" and in group statistics "Most activated places", and none of them links anywhere.

The deliveries link to the program's site instead. `spot_source_url` gives
`https://pota.app/#/park/US-2763`, `https://summits.sota.org.uk/summit/W4C/CM-001` or
`https://wwff.co/directory/?showRef=KFF-6101` for the webhook `url` field, push's "Open on POTA"
action and Discord's source title link. None of those pages gives a link preview of the place:

- pota.app keeps the park after `#`, which never reaches the server, so every park unfurls as
  the generic "Parks on the Air" card;
- summits.sota.org.uk is a single-page app titled "Sotadata3" with no Open Graph tags;
- the WWFF directory's tags are the site's own for every reference.

This feature adds:

- a public profile page for every POTA park, SOTA summit and WWFF reference, built from each
  program's official list and from the spots Long Lines already stores;
- the same kinds of figures the callsign profile has, turned around: who activated the place, when,
  on which bands and modes;
- link previews (Open Graph tags) for those pages, so a link pasted into Discord, Slack or a
  chat app shows the place;
- a "Reference page" delivery field that points at the new page.

Brad decided on 2026-10-26:

- POTA, SOTA and WWFF first. Islands on the Air and Bunkers on the Air are not sources today and
  come later as their own source work; the route leaves room for them (decision 1).
- Every reference in each program's official list gets a page, from a weekly import, not only the
  references that have been spotted.
- Link previews are part of this effort.
- Spec first; Brad designs the page.

## Decisions

1. **One route: `/ref/<program>/<reference>`.** `/ref/pota/US-2763`, `/ref/sota/W4C/CM-001`,
   `/ref/wwff/KFF-6101`. The program is lower case; the reference keeps its case-insensitive match
   in SQL and is shown upper case. SOTA's `/` stays a path separator (the route is
   `/ref/:program/*`, as `/call/*` takes portable calls). The page is public (`PublicRoute`).
   `iota` and `bota` can be added as programs later without a new route.
2. **The programs' lists are imported weekly, by the relay.** The three files are 10 to 25 MB
   (POTA `https://pota.app/all_parks_ext.csv` 9.8 MB, SOTA
   `https://storage.sota.org.uk/summitslist.csv` 25 MB, WWFF
   `https://wwff.co/wwff-data/wwff_directory.csv` 25 MB, measured 2026-10-26), too much to parse
   inside one Edge Function request. They load the way the FCC licenses do: the relay streams a
   file, parses it with a pure module under `_shared`, and posts batches to a push function that
   stages them; a pg_cron job swaps a complete stage in. *(The relay is the one process that
   already makes long downloads; a new process is not worth it for three weekly files.)*
3. **A truncated list never replaces a good one.** A stage is swapped in only when it is complete
   and holds at least 90% of the rows the current list has for that program (and at least 10,000
   on a first load). Otherwise the old list stays and the load is recorded as refused, so it shows
   on `/health` like any other failed job.
4. **An activation is one activator on one UTC day at the reference.** This is the definition the
   callsign profile and Stats already use. It means "spotted there that day", not the program's own
   rule (POTA's 10 contacts, SOTA's 4): Long Lines sees spots, not logs. The page's copy says so.
5. **Activations are rolled up per day, with the callsign rollup.** A new day-grain table,
   `reference_days`, is written by `rollup_callsign_day` in its marker transaction, from the pass
   it already makes over the day. Older days are filled from `raw_spots`, which is exact because
   `raw_spots` is never pruned and RBN spots carry no reference. The table is never compacted and
   has no running totals, so a fill can always rebuild it.
6. **Days not rolled up yet are read live, by reference.** The read goes through `spot_stream`,
   as every profile read does, and a partial expression index on `raw_spots` by `spot_stream`'s
   reference expression and time serves it. The live window is the callsign profile's
   (the unmarked days of the last 14, never before the first marker), so a day is never counted
   twice.
7. **Hidden calls count nowhere** on a reference page: not in a list, not in a total. This is
   group statistics' rule (`group_member_bases`), not the callsign profile's (which hides the
   page itself).
8. **A reference outside the official list still gets a page if it was spotted.** It says the
   reference is not in the program's list and shows its spots. A reference in neither the list nor
   any spot is a 404, the same 404 as a malformed one.
9. **Link previews come from a Vercel function, for link-preview crawlers only.** A rewrite in
   `web/vercel.json` sends `/ref/*` requests whose User-Agent is a known unfurler to
   `web/api/ref-preview.ts`, which returns a small HTML page with the place's Open Graph tags;
   browsers keep getting the app. Supabase rewrites a GET `text/html` reply to `text/plain` on its
   own domain, so the HTML cannot come from an Edge Function. *(This is the first server code in
   `web/`; it stays one file that only reads the public `reference-profile` function.)*
10. **Deliveries get a new field, "Reference page", rather than a changed one.** The webhook `url`
    field, push's "Open on {program}" action and Discord's source title link keep pointing at the
    program's site, so no consumer's body or behavior changes under it. The new field's key is
    `reference_url` and its value is the Long Lines page.
11. **A Reference lookup page finds references by reference or name** (canvas "Reference lookup").
    It is `/ref` (public), the nav's "Reference lookup" right after "Callsign lookup", which stays
    highlighted on every `/ref/*` page as Callsign lookup does on `/call/*`. A search is every word
    of the query (case-insensitive) found in the reference or the catalog name, optionally limited
    to one program; the top 25 by activations, then reference, plus whether there were more. It
    reads only `reference_catalog` and `reference_days` (no live days: a search is not a profile),
    through `search_references(p_query, p_program)` and the public `reference-search` function. With
    no query the page shows the Stats snapshot's `topReferences` ("Most spotted this week") from
    `useStats()`, never a new request.
12. **The header shows the newest spot at the reference** (canvas "Last activated"): the
    activator, frequency, mode, band and time, the callsign profile's "On the air now" chip
    (`onAirNow`), and that activator's spots and bands there that UTC day. It comes from the live
    read (the newest spot of the last 14 days); older than that, the band is absent and the KPI
    cards carry the history. The "Spotted {n} times today" line appears only when that day is
    today (UTC); for an earlier day the band shows the date and leaves the line out (canvas
    "States", the W4C/CM-001 header).
13. **A catalog row that is not active is shown as retired**, with the date when the program
    gives one (SOTA `ValidTo`, WWFF `validTo`). Its page keeps its history and has no "Get alerts"
    button. A reference outside the catalog (decision 8) has no name, no program site button and no
    "About" card; its alerts button stays, since spots still arrive for it.
14. **"Get alerts" opens a new connection for the reference**: `/connections/new` with the
    program's source and a rule that matches that reference only, the way the callsign profile
    prefills a `callsign is` rule. Signed out it is "Sign in to get alerts". The reference field
    has only `contains` today, a substring test over all of a spot's references, so a
    `reference contains US-1000` rule also matches US-10000 to US-10009 (1,164 POTA references are
    a prefix of another). The PR that builds the button therefore adds an exact `reference is` op
    (a value equal to one of the spot's references, case-insensitive) in
    `normalize_subscription_rules`, `rule_matches`, `docs/openapi.yaml` and the rule builder, and
    prefills `reference is`. *(Amended in PR 2 review; Brad to confirm before that PR.)*

## Schema

### Catalog (PR 2)

- `reference_catalog` (RLS on, no policies, no client grants):
  `program text` (`pota`, `sota`, `wwff`), `reference text`, `name text`, `active boolean`,
  `location text` (POTA `locationDesc`, `US-NC,US-VA`), `region text` (SOTA association and
  region, WWFF state or region), `country text`, `latitude numeric`, `longitude numeric`,
  `grid text`, `altitude_m int` (SOTA), `points int` (SOTA), `valid_from date`, `valid_to date`.
  Primary key `(program, reference)`, reference stored upper case. Only columns the page or the
  preview shows; no raw upstream row. *(About 350,000 rows; the database is close to the
  `/health` disk threshold, so the spec keeps the row narrow.)*
- `reference_catalog_stage` (same columns plus `load_id`) and `reference_catalog_loads` (one row
  per load: program, upstream `Last-Modified`, rows staged, state, started, finished and applied
  times, and the error of a refused or abandoned load), modeled on the license staging tables
  (`20261012000050_callsign_licenses.sql`). States: `staging` (taking batches), `finished` (complete
  and over the floor, waiting for the swap), `applied`, `refused` (decision 3) and `abandoned`
  (the relay gave up, or a newer load or a newer finished load superseded it).
- Called only by `load-references`, service role only:
  `reference_load_status()` (per program, the last applied load with its version, start, apply
  time and rows, and the newest load; the relay decides from it whether to download),
  `begin_reference_load(program, version)` (abandons the program's open staging loads),
  `stage_reference_rows(load_id, rows jsonb)` (returns the load's running total, so a retried
  batch counts once), `finish_reference_load(load_id, rows)` and
  `abandon_reference_load(load_id, error)`.
- Decision 3 lives in `finish_reference_load`: it answers `refused` when the staged count differs
  from what the relay sent (a lost batch) or is under `reference_load_floor(program)` (90% of the
  program's current rows, 10,000 on a first load), and commits the refusal (it does not raise),
  deleting the staged rows; otherwise `finished`. The relay never downloads a refused version
  again; a newer file is loaded as usual.
- `apply_reference_loads()`: pg_cron hourly (`apply-reference-loads`, :55). Per program, in its
  own subtransaction, it swaps the newest finished load in (set-based: one delete and one insert,
  which outlast the API's 8 s timeout for SOTA, hence cron), after checking the stage count and the
  floor again (a failure refuses that load without undoing another program's swap). Older finished
  loads of the program are superseded and the stage rows deleted. A run that neither swaps nor
  refuses anything while some program's newest load is refused raises, so the job fails on
  `/health` until a good load lands.
- Per program, the mapping from file columns (all in `_shared/reference_catalog.ts`):

  | Column | POTA | SOTA | WWFF |
  | --- | --- | --- | --- |
  | reference | `reference` | `SummitCode` | `reference` |
  | name | `name` | `SummitName` | `name` |
  | active | `active = 1` | `ValidTo` not past | `status = active` |
  | location | `locationDesc` | | |
  | region | | `AssociationName`, `RegionName` | `state` when a subdivision, else `region` |
  | country | | | `dxcc` through cty.dat, else `country` |
  | latitude, longitude | `latitude`, `longitude` | `Latitude`, `Longitude` | `latitude`, `longitude` |
  | grid | `grid` | from `Latitude`, `Longitude` | `iaruLocator` (dashes and spaces around it dropped, an extended locator cut to six), else from `latitude`, `longitude` |
  | altitude_m, points | | `AltM`, `Points` | |
  | valid_from, valid_to | | `ValidFrom`, `ValidTo` (DD/MM/YYYY) | `validFrom`, `validTo` (`0000-00-00` is none) |

  The SOTA file starts with a title line before its header. SOTA has no locator column; the
  parser derives the Maidenhead locator from the coordinates at the length POTA's file uses, so
  the header's grid chip works for every program.

  WWFF's `state` is a subdivision (`K-PA`, `VK-VIC`) or a prefix (the `dxcc` again, `R` for
  `RA`, `TA` for `TA2`) or a placeholder (`K-???`); only a subdivision is used, else the free-text
  `region`. WWFF's `country` is blank for about 80% of the directory and spelled several ways
  where present (`U.S.A.`, `United States`), so the country is cty.dat's entity for the reference's
  `dxcc` prefix, resolved in SQL (`cty_lookup` in `stage_reference_rows`, once per distinct prefix;
  TypeScript never resolves a call), and the directory's `country` only when that finds none. Only
  a plain prefix is looked up (`VP8-SG`, `SV/A` and `3Y/P` would resolve to their parent entities),
  and `AN`, WWFF's prefix for Antarctica, which cty.dat gives to Spain, is looked up as `CE9`. The
  parser passes `dxcc` in the row; it is not stored.

  A record whose reference is not its program's shape is skipped (POTA `<prefix>-dddd`, SOTA
  `<association>/<region>-ddd`, WWFF `<prefix>FF-dddd`, each with a little room to grow): in the
  2026-10-26 files that drops only POTA's `K-TEST` and WWFF's `Select-0001` and `Select-0002`,
  copies of real references left by an unfilled form. WWFF stores some names and regions as HTML
  character references (`Ragak&#257;pa`, `&nbsp;`); the parser decodes them.

### Rollup (PR 3)

- `reference_days` (RLS on, no policies, no client grants): `program text`, `reference text`,
  `day date`, `base text`, `source text`, `spots int`, `modes text[]`, `bands text[]` (sorted, as
  `callsign_days`). Primary key `(program, reference, day, base, source)`; index `(base, day)`.
  Heard role only: the activator, never the spotter. `program` is lower case, as
  `reference_catalog` and the route; `reference` is upper case, as the catalog stores it. Only the
  POTA, SOTAwatch and WWFF sources write rows: WWBOTA spots name an array of bunkers and wait for
  their own source work (decision 1). Every activator is stored, hidden calls included; leaving them
  out is the read's job (decision 7).
- `rollup_callsign_day` adds one insert from its existing `b` stage, `on conflict do nothing`,
  in the marker's transaction. The function's other output is unchanged. The roll-up and the fill
  write the same rows for the same day (pgTAP compares them).
- `callsign_rollup_days.references_filled_at timestamptz`, set by the roll-up for new days.
  `fill_reference_days(day)` builds a day from `raw_spots` (`source in ('pota', 'sotawatch',
  'wwff')`) and `backfill_reference_days(p_max_days)` walks unfilled days, oldest first.
  `backfill_callsign_rollups` calls it only in a run that rolled nothing up and filled no
  `callsign_days` (filled, not attempted, so a `callsign_days` day refused every hour cannot hold
  it back), with the same bound, and keeps its return shape `(rollup_day, spots, error)`. Like
  `backfill_callsign_days` it takes days that never failed first, and stops at twice the bound in
  attempts. A failed fill is recorded through `record_callsign_rollup_failure` with the prefix
  `reference_days fill: `; a successful one deletes only a failures row with that prefix, and
  `fill_callsign_days` is redefined to do the same with `callsign_days fill: `, so neither fill's
  success clears the other's failure. The day's one failures row holds whichever fill failed last.
  `callsign_rollup_status` gains `references_filled_at`, and `fill_failed` covers either fill.
- Index `raw_spots_reference_time_idx on raw_spots (coalesce(pota_reference, sota_summit_ref,
  wwff_reference, wwbota_references[1]), spot_time) where coalesce(...) is not null`: exactly
  `spot_stream`'s `reference` expression, so PR 4's live read, `spot_stream where reference = ...
  and spot_time >= ...`, reaches the `raw_spots` arm and uses it (the RBN arm's null reference
  drops out; pgTAP checks the plan). The view's expression and the index change together. Built by
  a plain `create index if not exists` in the migration (hosted `raw_spots` was about 562,000 rows
  / 342 MB on 2026-10-26).
- Size: one row per activator, reference, day and source. POTA, SOTA and WWFF together are a few
  thousand rows a day, about 1 MB.

### Profile (PR 4)

- `reference_profile(p_program text, p_reference text)` builds the whole payload: the catalog
  header, then from `reference_days` plus the live days activations, distinct activators, spots,
  first and last activation, the year heat map with the callsign profile's periods, monthly
  activations, bands, modes (`mode_bucket` labels), top activators, recent activations and the
  newest spots of the last 7 days. Every list length and ranking is SQL's. Not granted to clients.
  From the canvas: `last` (decision 12: activator and its base, time, frequency, mode, band,
  source, and that activator's spots and bands at the reference that UTC day, or null);
  `firstActivation` (day and activator); the heat map's days carry the activators' base calls,
  for "Hover a day to see who", and its figures are activations, days activated, longest streak
  and busiest day by activators; `monthly` is every month from the first activation through the
  current one, zero-filled; `bands` lists only bands with spots, in band order; `topActivators`
  (10: base, activations, last day); `recentActivations` (10: day, activator, spots, bands,
  modes); `recentSpots` (25, last 7 days: time, activator, frequency, mode, spotter, comment).
- `search_references(p_query text, p_program text)` (PR 5, decision 11): not granted to clients;
  returns `{results: [...], more: boolean}`, each result the catalog header plus activations and
  last day from `reference_days`. Words are matched with `strpos` on upper-cased text, not
  `like`, so `%` and `_` in a query are literal. No new index: a scan of the narrow catalog is
  well inside the statement timeout, and the database is near its disk threshold.
- `reference_profile_cache` and `cached_reference_profile(program, reference)`: 15 minutes,
  single-flight under an advisory lock, as `cached_callsign_profile`. `prune_callsign_lookups`
  also deletes expired rows.
- The shape is `ReferenceProfile` in `web/src/references/types.ts`, pinned by
  `supabase/tests/reference_profile.test.sql`; change the SQL, the type and the test together. The
  exact fields follow the canvas.

### Deliveries (PR 6)

- `spot_reference_url(spot)`: `app_site_url() || '/ref/' || program || '/' || reference` when the
  spot has a reference made of letters, digits, `/` and `-` (`spot_source_url`'s rule), else null.
- Webhooks: `reference_url` joins `webhook_fields()` (not the defaults), with "Reference page" in
  the field catalog, `docs/WEBHOOKS.md`, `docs/openapi.yaml` and `COMMON_FIELDS`
  (`web/src/sources/sources.ts`). `webhook_fields_valid` takes one more field.
- Discord: `title_link` gains `reference` ("Reference page", falling back to the profile when the
  spot has none), and the plain line links the reference value to its page as it links the
  callsign to its profile. Push is unchanged.

## Edge functions

- `load-references` (PR 2): POST from the relay only, `verify_jwt = false`, checks
  `x-relay-secret` as `load-licenses` does, never imports `isServiceRole`. It validates each batch
  with Zod and calls the staging RPCs.
- `reference-profile` (PR 4): GET `?program=&reference=`, `verify_jwt = false`, never imports
  `isServiceRole`. It shares the callsign profile's rate limit (`lookupLimit`) and payload schema
  pattern (`_shared/handlers/callsign_profile.ts`); 404 for an unknown or malformed reference;
  `Cache-Control: public, max-age=300`.
- `reference-search` (PR 5): GET `?q=&program=`, the same rules as `reference-profile` (no
  `isServiceRole`, `lookupLimit`, a Zod schema for `search_references`' reply). A query is 2 to
  64 characters after trimming, at most 6 words; anything else is a 400. Never logs a query.

## Relay

`relay/catalogs.ts` (PR 2), started from `relay/relay.ts` beside the license load. Once a day it
asks each file's `Last-Modified` (a HEAD with User-Agent); when a program's last applied load
began seven days ago (its start, not its apply time, which the hourly swap delays past the seventh
daily check) and the file is newer, it streams the file, parses rows with
`_shared/reference_catalog.ts`, and posts batches to `load-references`. One program at a time,
never more than one download open. A load that did not finish (staging or abandoned) is retried
twelve hours after it started, and a load waiting to be swapped in goes first. No test downloads a list; tests serve fixtures cut from the real
files from a local server, as the license tests do.

## Web

| Path | Guard | Page |
| --- | --- | --- |
| `/ref/:program/*` | `PublicRoute` | Reference profile (PR 4) |
| `/ref` | `PublicRoute` | Reference lookup (PR 5) |

- `web/src/references/`: the page, `useReferenceProfile` (one request per visit; no polling), types.
  The heat map reuses `profile/calendar.ts` and `ActivityHeatMap`.
- Every reference shown in the app links to its page: the callsign profile's "Where they've been
  spotted" table, Stats "Most spotted parks, summits and WWFF references", group statistics "Most
  activated places" and the band map's crowd menu. Every callsign on the reference page links to
  `/call/<base>` with the base call from SQL.
- `api.ts` gains `getReferenceProfile` (and `searchReferences` in PR 5), calling the functions
  with plain `fetch` like `getCallsignProfile`.
- Program chips use the band map's colors (`SOURCES` in `bandmap/model.ts`): POTA `primary`, SOTA
  `secondary`, WWFF `success`, from the theme.

## Previews (PR 6)

- `web/vercel.json`: before the catch-all, a rewrite of `/ref/(.*)` with a `has` condition on the
  `user-agent` header matching `Discordbot|Slackbot|Twitterbot|facebookexternalhit|TelegramBot|
  WhatsApp|LinkedInBot|Mastodon|Applebot` to `/api/ref-preview?path=$1`.
- `web/api/ref-preview.ts`: calls `reference-profile` and returns HTML with `og:title`
  (`US-2763 · Mount Mitchell State Park`), `og:description` (program, place, activations, last
  activated; wording from the canvas), `og:url`, `og:site_name` (`Long Lines`), `og:image` (the
  site's static icon), `twitter:card`, a canonical link and a plain link to the page.
  `Cache-Control: public, s-maxage=900`. A 404 from the function is a 404 here. Every value is
  HTML-escaped. Tests run in Vitest.
- A per-reference image (map or stat card) is out of scope.

## PR order

1. **Spec** (`reference-profiles-spec`): this file.
2. **Catalog** (`reference-catalog`): migration, `_shared/reference_catalog.ts` with fixtures,
   `load-references`, `relay/catalogs.ts`. Deploy: `supabase db push`, deploy `load-references`;
   the relay ships on merge, and the first loads land within a day.
3. **Rollup** (`reference-days`): migration, pgTAP. Deploy: `db push`. Hosted `raw_spots` is about
   562,000 rows / 342 MB (`supabase inspect db table-stats`, 2026-10-26), so the migration's plain
   `create index if not exists` builds in seconds inside the push. The fill then works through
   history two days an hour; days already rolled up have no reference rows until it reaches them.
4. **Profile and page** (`reference-profile`): migration, function, web page from the canvas,
   reference links across the app, `database.types.ts`, CLAUDE.md "Reference profile rules".
   Deploy: `db push`, deploy `reference-profile`; Vercel ships the web.
5. **Reference lookup** (`reference-lookup`): `search_references`, `reference-search`, the `/ref`
   page and its nav item. Deploy: `db push`, deploy `reference-search`; Vercel ships the web.
6. **Previews and the delivery field** (`reference-previews`): `web/api/ref-preview.ts`, the
   rewrite, `reference_url` for webhooks and Discord with editor and doc changes. Deploy: `db
   push`; Vercel ships the web and the function; the sender needs nothing (SQL renders the field).

## Verification

- **Catalog.** Parser tests on fixtures cut from the three real files (the SOTA title line, quoted
  names with commas, WWFF's `0000-00-00`, retired summits). pgTAP: a complete stage swaps in; one
  below the floor is refused and the old rows stay; staging is service-role only.
- **Rollup.** pgTAP: the roll-up and `fill_reference_days` write the same rows for the same day;
  RBN, DX Cluster and WWBOTA spots write none; program lower case, reference upper case; the fill
  is bounded, oldest first, runs only when nothing was rolled up and no `callsign_days` were
  filled, and keeps `backfill_callsign_rollups`' return shape; a failed fill is recorded with its
  prefix; `scripts/smoke-test.sql` still passes and checks a SOTA activation.
- **Profile.** pgTAP pins the shape; a hidden call is in no list and no total; a live day and a
  rolled-up day are not counted twice; a reference with spots and no catalog row, and one with
  neither. `advisor.test.sql` lists the new functions.
- **Web.** Vitest for the page, links and `ref-preview.ts` (tags for a Discordbot User-Agent,
  escaping, 404). `cd web && npm run test:all`.
- **After deploy.** `curl -A Discordbot https://longlines.io/ref/pota/US-2763` shows the park's
  `og:title`; a link pasted into a Discord test channel unfurls as the park; `/health` shows the
  catalog loads and `apply-reference-loads`.

## Out of scope

- Islands on the Air and Bunkers on the Air (separate source work; decision 1 leaves room).
- Two-fers: a spot carries one reference, and parks named only in a comment are not parsed.
- Linking a POTA park to the WWFF reference that covers the same land.
- A per-reference preview image.
- Previews for callsign pages (the same rewrite and function can take them later).
- Changing what the webhook `url`, push's source action or Discord's source link point at.
- Maps on the reference page beyond what the canvas draws.

## Copy

From the canvas, word for word. `{ref}` is the reference as shown (upper case), `{PROGRAM}` the
program's short name (POTA, SOTA, WWFF), and `{kind}` its place word: park (POTA), summit (SOTA),
reference (WWFF). The canvas draws a POTA park; other programs swap these words in.

### Reference page (`/ref/<program>/<reference>`)

Header card:

- Title `{ref}` with a `{PROGRAM}` chip; the catalog name under it.
- Chips, in order. POTA: location (`US-NC`), grid, `Active`. SOTA: `{association} · {region}`
  (`W4C · Central Mountains`), `{altitude} m` (`2,037 m`), `{points} points` (`1 point`), grid.
  WWFF: country, state or region, grid. A retired reference adds an outlined `Retired` chip first
  and drops `Active`. A reference outside the list shows only an outlined `Not in the {PROGRAM}
  list` chip.
- Buttons: `Get alerts for {ref}` signed in, `Sign in to get alerts` signed out (none for a retired
  reference); `Share`; `{PROGRAM}` with an open-in-new icon, linking the program's page for the
  reference (none outside the list).
- Last activated band: overline `Last activated`, the `On the air now` chip when it applies, the
  activator in large type linked to its profile, outlined chips for frequency (`14062.0 kHz`),
  mode and band, the time (`12 min ago (18:51 UTC)`, the callsign profile's `lastHeardWhen`), and
  `Spotted {n} times today, on {bands}.` (`Spotted 18 times today, on 20m and 40m.`; `once` for one
  spot), only when the newest spot is from today (UTC); for an earlier day the time is the date
  (`Oct 12 (15:02 UTC)`) and the line is left out (decision 12). The phone layout leaves out that
  last line.

KPI cards: `Activations` / `Since Long Lines started`; `Activators` / `Different callsigns`;
`Spots` / `All time`; `First activated` / the date (`Nov 2, 2025`) / `By {call}`.

Heat map card: title `Activations in the past year` (a year period: `Activations in {year}`);
subheader `Activators spotted at {ref} each day. Hover a day to see who.` (phone: `Tap a day to see
who.`). Figures `Activations`, `Days activated` (`112 of 365`), `Longest streak` (`6 days`),
`Busiest day` (`5 activators` and the date). `Period` select: `Past 365 days`, then each year.
`View as table`. Legend `Less` … `More`. Phone, under the grid: `Scroll sideways for earlier
months.`

About card: title `About this {kind}`; subheader `From the POTA park list. Refreshed weekly.`
(`the SOTA summit list`, `the WWFF directory`). Rows: `Name`, `Program` (`Parks on the Air`,
`Summits on the Air`, `World Wide Flora and Fauna`), then per program `Location` (POTA), `Region`
(SOTA, WWFF), `Country` (WWFF), `Altitude` and `Points` (SOTA), `Grid`, `Coordinates`
(`35.7650, -82.2652`), `Status` (`Active` or `Retired`), and `Valid until` with the date for a
retired reference that has one.

Charts: `Activity` / `Activations per month, since Long Lines started`; `Bands` / `Spots from this
{kind}, by band`; `Modes` / `Share of spots` (the phone legend adds each percent: `CW 46%`).

Tables:

- `Top activators` / `Most activations here, all time`; columns `Callsign`, `Activations`,
  `Last`. Phone rows: `{call}` and `{activations} · {day}`.
- `Recent activations` / `Newest first. An activation is one activator spotted here on one UTC
  day.`; columns `Day`, `Activator`, `Spots`, `Bands`, `Modes`. Phone rows: `{bands} · {modes} ·
  {n} spots`.
- `Recent spots` / `Spots from this {kind} in the last 7 days, newest first`; columns `Time (UTC)`,
  `Activator`, `Frequency`, `Mode`, `Spotter`, `Comment` (`–` when empty). Phone rows:
  `{frequency} · {mode} · by {spotter}`, or `self-spot`.

Footer: `An activation here means an activator was spotted at {ref} on that UTC day. Long Lines
sees spots, not logs, so these counts aren't {PROGRAM}'s own. {Kind} details come from the
{PROGRAM} {kind} list.` (WWFF: `the WWFF directory`; the last sentence is left out outside the
list.)

States:

- Retired (info alert): `This summit was retired from the SOTA list on Dec 31, 2019. Activations of
  it no longer count for SOTA.` Without a date: `This {kind} is retired in the {PROGRAM} list.
  Activations of it no longer count for {PROGRAM}.`
- Not in the list (warning alert): `{ref} isn't in the {PROGRAM} {kind} list. Long Lines shows it
  because activators were spotted here. It may be a new {kind}, or a typo in the spots.` (WWFF:
  `the WWFF directory`.)
- Never activated: the KPIs, charts and tables give way to a card reading `Long Lines hasn't heard
  an activation at {ref} yet.` beside the About card.
- Not found: title `Reference not found`; warning `Long Lines has no {PROGRAM} {kind} {ref}. Check
  the reference, like US-2763 or W4C/CM-001.` (an unknown program: `Long Lines has no reference
  {ref}.`); buttons `Callsign lookup` and `Stats`.

Elsewhere: the callsign profile's `Where they've been spotted` table, Stats `Most spotted parks,
summits and WWFF references`, group statistics `Most activated places` and the band map's crowd
menu link each reference to its page. Nothing else about them changes.

### Reference lookup (`/ref`)

- Nav item `Reference lookup`, after `Callsign lookup`, open signed out.
- Title `Reference lookup`; `Find a POTA park, SOTA summit or WWFF reference by its reference or its
  name.`
- Field label `Reference or name`, placeholder `Reference or name, like US-2763 or Mount Mitchell`
  (phone: `Reference or name, like US-2763`); button `Look up` (phone: the search icon, labelled
  `Look up`).
- Program chips: `All programs`, `POTA parks`, `SOTA summits`, `WWFF references` (phone: `All`,
  `POTA`, `SOTA`, `WWFF`).
- Results card: `{n} matches for "{query}"` (`1 match`) / `Most activated first`. Each row: the
  reference, its program chip, the name with the matched words in medium weight, a detail line
  (POTA `US-NC · EM85`; SOTA `W4C · Central Mountains · 2,037 m · 10 points`; WWFF
  `{country} · {region}`), a `Retired` chip when retired, and on the right `{n} activations · last
  {Mon D}` or `No activations yet`. With more than 25: `Showing the top 25. Add a word to narrow it
  down.`
- No results: `No parks, summits or WWFF references match "{query}".`
- No query: `Most spotted this week` / `Parks, summits and WWFF references`, the first five of the
  Stats `topReferences` with their spots, and a `More on the Stats page` link.

### Link previews

- `og:title`: `{ref} · {name}`; outside the list `{ref} · Not in the {PROGRAM} list`.
- `og:description`:
  - POTA: `POTA park in {location}. {n} activations on Long Lines, last on {Mon D, YYYY}.`
  - SOTA: `SOTA summit in {association}, {region}. {altitude} m, {points} points. {n} activations
    on Long Lines, last on {Mon D, YYYY}.`
  - WWFF: `WWFF reference in {country}. {n} activations on Long Lines, last on {Mon D, YYYY}.`
    Without a country (a prefix cty.dat cannot name and a blank directory column, under a
    hundred references) the first sentence is `WWFF reference.`, and the header and search line
    leave the country out.
  - Never activated: the first sentence, then `No activations on Long Lines yet.`
  - Outside the list: `Spotted as a {PROGRAM} {kind}. {n} activations on Long Lines, last on {Mon
    D, YYYY}.`
  - One activation reads `1 activation`.

### Delivery field

- Webhook Payload field `Reference page`, key `reference_url`, placed after `Spot URL` in the
  catalog.
- Discord `Title links to` options: `Callsign profile`, `Source site`, `Reference page`, `Nothing`;
  helper text `Or the spot on the source site, the park or summit's page on Long Lines, or nothing.
  Spots without a reference link to the callsign profile.` The plain style line links the
  reference to its page: `N4MTS · 14062.0 kHz · CW · US-2763 · Mount Mitchell State Park`.
