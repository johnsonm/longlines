# Reference profiles: design

Date: 2026-10-26. Status: **proposed** (this spec PR; nothing built). Brad decided the four
points under Purpose on 2026-10-26; decisions 1 to 10 below are proposals for him to accept or
amend. If the design changes during a PR, update this file in that PR.

Source: none yet. Brad draws the reference page on the design canvas once the decisions are
settled; its Copy section then becomes this file's Copy section. Where the canvas and this file
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
6. **Days not rolled up yet are read live, by reference.** A partial expression index on
   `raw_spots` by reference and time serves the read. The live window is the callsign profile's
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
  per load: program, upstream `Last-Modified`, rows staged, state `staging` / `applied` /
  `refused`, timestamps), modeled on the license staging tables
  (`20261012000050_callsign_licenses.sql`).
- `begin_reference_load(program, version)`, `stage_reference_rows(load_id, rows jsonb)`,
  `finish_reference_load(load_id, rows)`: called only by `load-references`, service role only.
- `apply_reference_loads()`: pg_cron hourly (`apply-reference-loads`), swaps each finished stage in
  per program in one transaction when decision 3's floor holds, else marks it refused.
- Per program, the mapping from file columns (all in `_shared/reference_catalog.ts`):

  | Column | POTA | SOTA | WWFF |
  | --- | --- | --- | --- |
  | reference | `reference` | `SummitCode` | `reference` |
  | name | `name` | `SummitName` | `name` |
  | active | `active = 1` | `ValidTo` not past | `status = active` |
  | location | `locationDesc` | | |
  | region | | `AssociationName`, `RegionName` | `state`, `region` |
  | country | | | `country` |
  | latitude, longitude | `latitude`, `longitude` | `Latitude`, `Longitude` | `latitude`, `longitude` |
  | grid | `grid` | | `iaruLocator` |
  | altitude_m, points | | `AltM`, `Points` | |
  | valid_from, valid_to | | `ValidFrom`, `ValidTo` (DD/MM/YYYY) | `validFrom`, `validTo` (`0000-00-00` is none) |

  The SOTA file starts with a title line before its header.

### Rollup (PR 3)

- `reference_days` (RLS on, no policies, no client grants): `program text`, `reference text`,
  `day date`, `base text`, `source text`, `spots int`, `modes text[]`, `bands text[]` (sorted, as
  `callsign_days`). Primary key `(program, reference, day, base, source)`; index `(base, day)`.
  Heard role only: the activator, never the spotter.
- `rollup_callsign_day` adds one insert from its existing `b` stage, `on conflict do nothing`,
  in the marker's transaction. The function's other output is unchanged.
- `callsign_rollup_days.references_filled_at timestamptz`, set by the roll-up for new days.
  `fill_reference_days(day)` builds a day from `raw_spots` (`source in ('pota', 'sotawatch',
  'wwff')`) and `backfill_reference_days(p_max_days)` walks unfilled days, oldest first.
  `backfill_callsign_rollups` calls it only in a run that rolled nothing up and filled no
  `callsign_days`, with the same bound, and keeps its return shape `(rollup_day, spots, error)`.
  A failed fill is recorded through `record_callsign_rollup_failure` with the prefix
  `reference_days fill: `.
- Index `raw_spots_reference_time_idx on raw_spots (coalesce(pota_reference, sota_summit_ref,
  wwff_reference), spot_time) where coalesce(...) is not null`. Building it on the hosted
  `raw_spots` is a deploy step to time first (see PR order).
- Size: one row per activator, reference, day and source. POTA, SOTA and WWFF together are a few
  thousand rows a day, about 1 MB.

### Profile (PR 4)

- `reference_profile(p_program text, p_reference text)` builds the whole payload: the catalog
  header, then from `reference_days` plus the live days activations, distinct activators, spots,
  first and last activation, the year heat map with the callsign profile's periods, monthly
  activations, bands, modes (`mode_bucket` labels), top activators, recent activations and the
  newest spots of the last 7 days. Every list length and ranking is SQL's. Not granted to clients.
- `reference_profile_cache` and `cached_reference_profile(program, reference)`: 15 minutes,
  single-flight under an advisory lock, as `cached_callsign_profile`. `prune_callsign_lookups`
  also deletes expired rows.
- The shape is `ReferenceProfile` in `web/src/references/types.ts`, pinned by
  `supabase/tests/reference_profile.test.sql`; change the SQL, the type and the test together. The
  exact fields follow the canvas.

### Deliveries (PR 5)

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

## Relay

`relay/catalogs.ts` (PR 2), started from `relay/relay.ts` beside the license load. Once a day it
asks each file's `Last-Modified` (a HEAD with User-Agent); when a program's last applied load is
seven days old and the file is newer, it streams the file, parses rows with
`_shared/reference_catalog.ts`, and posts batches to `load-references`. One program at a time,
never more than one download open. No test downloads a list; tests serve fixtures cut from the real
files from a local server, as the license tests do.

## Web

| Path | Guard | Page |
| --- | --- | --- |
| `/ref/:program/*` | `PublicRoute` | Reference profile (PR 4) |

- `web/src/references/`: the page, `useReferenceProfile` (one request per visit; no polling), types.
  The heat map reuses `profile/calendar.ts` and `ActivityHeatMap`.
- Every reference shown in the app links to its page: the callsign profile's "Where they've been
  spotted" table, Stats "Most spotted parks, summits and WWFF references", group statistics "Most
  activated places" and the band map's crowd menu. Every callsign on the reference page links to
  `/call/<base>` with the base call from SQL.
- `api.ts` gains `getReferenceProfile`, calling the function with plain `fetch` like
  `getCallsignProfile`.

## Previews (PR 5)

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
3. **Rollup** (`reference-days`): migration, pgTAP. Before `db push`, time the index build against
   a copy of hosted `raw_spots` (or build it `concurrently` by hand first and let the migration's
   `if not exists` find it). The fill then works through history two days an hour; days already
   rolled up have no reference rows until it reaches them.
4. **Profile and page** (`reference-profile`): migration, function, web page from the canvas,
   reference links across the app, `database.types.ts`, CLAUDE.md "Reference profile rules".
   Deploy: `db push`, deploy `reference-profile`; Vercel ships the web.
5. **Previews and the delivery field** (`reference-previews`): `web/api/ref-preview.ts`, the
   rewrite, `reference_url` for webhooks and Discord with editor and doc changes. Deploy: `db
   push`; Vercel ships the web and the function; the sender needs nothing (SQL renders the field).

## Verification

- **Catalog.** Parser tests on fixtures cut from the three real files (the SOTA title line, quoted
  names with commas, WWFF's `0000-00-00`, retired summits). pgTAP: a complete stage swaps in; one
  below the floor is refused and the old rows stay; staging is service-role only.
- **Rollup.** pgTAP: the roll-up and `fill_reference_days` write the same rows for the same day;
  RBN and DX Cluster spots write none; the fill is bounded and keeps `backfill_callsign_rollups`'
  return shape; `scripts/smoke-test.sql` still passes.
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

From the canvas, to come.
