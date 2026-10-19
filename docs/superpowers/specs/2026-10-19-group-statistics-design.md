# Group statistics and public group pages: design

Date: 2026-10-19. Status: proposed. Decisions 1 and 2 were made by Brad on 2026-10-19; the rest
are proposed here for review in the spec PR. If the design changes during a PR, update this file
in that PR.

Source: page 10 of Brad's design canvas ("Groups with statistics (draft)"), artboards
`GroupsLanding-Desktop` ("Groups landing, desktop"), `GroupsLanding-Mobile`, `GroupNew-Desktop`
("New group dialog"), `GroupStats-Desktop` ("Group statistics, public on"), `GroupStats-Mobile`,
`GroupSettings-Desktop` ("Group settings tab"), `GroupPublicConfirm-Desktop` ("Make statistics
public: confirm"), `GroupPublic-Desktop` ("Public statistics page, visitor") and
`GroupPrivate-Desktop` ("Private page, visitor"). Where the canvas and this file disagree, this
file wins; the differences are listed under Decisions and marked in Copy. The canvas's nav has a
Templates item (page 6), which is not built and stays out.

## Purpose

A group today is a named list of up to 1,000 base calls used in connection rules
(`2026-10-13-callsign-groups-design.md`). `/groups` is a card grid: name, "N callsigns · used by N
connections", member chips, an on-air chip, and Get alerts / Edit / Delete, with all editing in
`GroupDialog`.

Page 10 turns a group into a club page. A club that makes a group of its roster gets:

- **Landing cards.** Each group's last 30 days: spots, members heard, a sparkline and who is on
  the air.
- **A Statistics tab** for the owner, with:
  - four figures: spots heard, active members, activations, places activated
  - a year heat map of club spots per day
  - "Who is most active": six top-three lists
  - a ranked members table
  - spots by band and by mode
  - the most activated parks and summits
- **A Settings tab** that replaces the dialog:
  - the public page switch and its link
  - "Show each member's callsign"
  - name, members, used by, delete
- **An optional public page.** It is unlisted, anyone with the link can open it without signing
  in, and it shows the same statistics, with or without callsigns.
- **A "This page is private" page** for any link that is not public.

Everything is built from data that already exists, all in SQL:

- `callsign_days`, which is never compacted (`20261019000200`)
- day-grain `callsign_activity`, kept 35 days (`20261012000040`)
- `callsign_seen`
- `spot_stream`, for days not yet rolled up and for references

No new roll-up, cron job or ingest change.

## Decisions

1. **Periods are Last 7 days and Last 30 days.** The default is 30.
   - Per-day band and mode counts exist only for 35 days (`callsign_activity` folds older days
     into months), so longer periods would need a new per-day table or inexact month edges.
   - The year view is the heat map, which ignores the period, as its copy says.
   - "Previous period" figures need 60 days of `callsign_days`, which never compacts.
   - *Decided by Brad 2026-10-19.*
2. **The public link is a random code only: `/g/<code>`.**
   - The code is 10 characters of lower-case base32 (`[a-z2-7]`, 50 bits), drawn with
     `new_api_token()`'s unbiased masking (`20261013000300`).
   - The canvas's `piedmont-arc-7f3k` gives the name away and has only about a million codes.
   - The code is made the first time the page is made public and kept through renames and
     through turning the page off and on, so a link printed in a club newsletter keeps working
     once sharing is back on.
   - *Decided by Brad 2026-10-19.*
3. **Built in SQL, cached for an hour, no cron.**
   - `group_statistics(group, period)` builds the whole payload.
   - `cached_group_statistics` serves a row of `group_stats_cache` younger than one hour, or
     rebuilds it single-flight under an advisory lock with a 2 s lock wait. This copies
     `cached_callsign_profile` (`20261013000310`).
   - "Updated 12 minutes ago. Statistics refresh every hour." is that row's `generated_at`.
   - Saving a group whose member list changed deletes its cache rows, so the owner sees the new
     roster on the next load.
   - Groups nobody opens cost nothing.
4. **Hidden calls count nowhere.**
   - A member in `hidden_callsigns` is left out of every figure, list and count on both the owner
     and the public view, including the "of N members" denominators.
   - The member editor still lists it, and the Settings tab's "N of 1,000 callsigns" counts it.
   - Totals are not a way around hiding: a one-member group would otherwise publish a hidden
     call's activity.
5. **"Show each member's callsign" is redaction in SQL.** When it is off,
   `public_group_statistics` passes the payload through `group_stats_redact`, which removes:
   - the top lists
   - the members table
   - on-air names, leaving the count
   - the places' `by` lists

   The web hides those sections because the keys are absent; it never filters callsigns
   itself. The owner's view always has callsigns. The setting defaults to off: the confirm
   dialog's checkbox is drawn unchecked.
6. **What is counted.**
   - **Spots** are the heard role (the member is the spotted station) from every source in
     `spot_stream`: POTA, SOTAwatch, WWFF, DX Cluster and RBN ("All modes and sources"). APRS-IS
     never reaches `spot_stream`.
   - **Modes** are `mode_bucket`. The CW, SSB and Digital lists are the `CW`, `SSB` and `FT8/FT4`
     buckets; the design's Digital card already says "FT8 and FT4 spots heard".
   - **Activations** are one per (member, reference, UTC day), read from `spot_stream`'s
     `raw_spots` arm for the period, as `callsign_references.days` counts them.
   - **Places** are distinct references. "Parks" counts POTA and WWFF references and "summits"
     counts SOTA.
   - WWFF is a peer, as on the Stats page: the activations line names it when it is nonzero, and
     WWFF references appear in "Most activated places".
   - **Days** are distinct UTC days with at least one spot.
   - **Last heard** is the newer of `callsign_seen.last_spot` and the newest live spot.
7. **One write path.** `save_callsign_group(payload)` gains optional `public` and
   `show_callsigns` booleans.
   - An absent key keeps the stored value, so `patch_callsign_group` and the management API,
     which never send them, change nothing.
   - The New group dialog and the Settings tab's Save changes each call it once, so name, members
     and sharing save together.
8. **The management API and `list_callsign_groups` do not change.** `list_callsign_groups` feeds
   `api_group_json`, so a new column would change API responses. The landing cards read a new
   `list_group_summaries()`. Sharing through the API is out of scope.
9. **Unlisted means unlisted.**
   - `web/vercel.json` sends `X-Robots-Tag: noindex` for `/g/(.*)`, and the page also sets
     `<meta name="robots" content="noindex">` while mounted.
   - The `group-page` function answers `Cache-Control: no-store`, so "Turn this off and the link
     stops working right away" holds with no CDN copy.
   - An unknown code and a private group get the same 404 and the same page, so a code's
     existence never leaks.
   - The function is rate-limited like the profile (decision 10).
10. **The public function reuses the profile's limiter.** `group-page` keys `record_profile_lookup`
    with `rateLimitKey` (`_shared/handlers/callsign_profile.ts`): 30 requests a minute per client,
    shared with profile lookups, 429 with `Retry-After: 60`, failing closed. One limiter keeps one
    table and one prune job.
11. **Signed-in visitors.**
    - `/g/:code` is a `PublicRoute`: signed out it renders in `PublicShell`, signed in in
      `AppShell`.
    - An owner opening their own private link sees "This page is private" like anyone else. Their
      way in is `/groups/:id`, and the private page's Sign in is hidden when signed in (*added*).
12. **Settings replaces the dialog.**
    - `GroupDialog` goes. Its Type/Paste/Import CSV tabs and member chips move into a
      `MemberEditor` used by the Settings tab, with search added.
    - New group is the smaller dialog drawn (Name, Callsigns, Public switch). Its Callsigns field
      is a paste box split by `splitCallsigns` and normalized by `normalize_group_callsigns`, as
      today.
    - Turning on a Public switch, in the dialog or in Settings, opens the confirm dialog first.
      "Keep private" turns it back off.
13. **The confirm dialog follows the checkbox.** Its first bullet names the callsigns only when
    the checkbox is ticked. Unticked, it reads "Club totals only, without callsigns" (*added*).
    The canvas shows the callsign bullet with the box unticked.
14. **Top lists hold three rows**, as drawn. A list with fewer heard members shows fewer. A list
    with none shows "Nobody yet" (*added*).
15. **The members table lists every member.**
    - It shows the first ten, then "Show all N members".
    - It is ranked by spots, then days, then callsign.
    - Members with no spots in the period come last, with spots 0, days 0, a dash for main mode,
      and last heard "Not heard yet" when `callsign_seen` has no row (*added*).
    - Search filters the shown rows on the client by substring of the callsign, which is display
      filtering, not matching.
16. **Main mode** is the member's bucket with the most spots in the period, shown with the bucket
    labels the profile uses: CW, SSB, "FT8 and FT4" (the canvas's "FT8"), FM, Other.
17. **Heat map levels are the design's fixed club levels:** none, 1 to 99, 100 to 199, 200 to 399,
    400 or more.
    - They are a constant in the group heat map, not the profile's levels: the profile's
      `calendar.ts` levels are being reworked separately.
    - The grid, cell and table helpers in `web/src/profile/calendar.ts` are shared.
    - A cell's tooltip gives spots, the long date and members on the air that day.
18. **Card spots match the page.** `list_group_summaries()` reads each group's cached 30-day
    payload through `cached_group_statistics`, so "10,082 spots" on the card is the Statistics
    tab's figure.
    - Opening `/groups` can build a stale group's payload. A user has few groups, and a build is a
      member-indexed read, so it does not need its own budget.
    - On-air names, which go stale within minutes, are read live in the same call (last 30
      minutes of `spot_stream`).
19. **Charts are stock MUI X.** `SparkLineChart` on cards, a horizontal `BarChart` for bands and for
    modes as drawn (not the profile's mode pie), and `DataGrid` with the `GRID` defaults
    (`web/src/stats/parts.tsx`) for the members, places and "View as table" grids. No custom SVG
    except the heat map's grid, which the profile's already draws.
20. **Get alerts is unchanged.** It runs today's `getAlerts`: an existing connection with a
    positive group rule, else `SourcePickerDialog`, then
    `/connections/new?source=…&group=…`. It sits on each card and in the group page header.
21. **Delete is in Settings only.** The landing card's actions are Statistics, Settings and Get
    alerts. Delete keeps its guard (disabled with the tooltip while `subscription_count > 0`).
    Deleting a group deletes its cache rows and its public page (cascade).

## Schema (migration `20261019000400_group_statistics.sql`)

Renumber it if main has moved. Applied migrations are never edited; functions are recreated from
their latest definitions with `create or replace` where the signature stays.

### Columns

```sql
alter table callsign_groups
  add column public boolean not null default false,
  add column show_callsigns boolean not null default false,
  add column public_slug text unique check (public_slug ~ '^[a-z2-7]{10}$');
```

`authenticated` keeps select on its own rows through RLS. The slug is the owner's to read.

### Functions

| Function | Kind | Grant | Notes |
| --- | --- | --- | --- |
| `new_group_slug()` | plpgsql, volatile | none | 10 masked bytes of `gen_random_bytes`; the caller retries on `unique_violation` |
| `save_callsign_group(payload jsonb) returns uuid` | from `20261013000210`, `create or replace` | authenticated (kept) | Accepts `public` and `show_callsigns` (booleans; anything else is "Not a valid setting."). Absent keeps stored. Sets `public_slug` when `public` becomes true and the slug is null. Deletes the group's `group_stats_cache` rows when the member list changed. Errors otherwise unchanged |
| `group_statistics_at(p_group_id uuid, p_period text, p_now timestamptz) returns jsonb` | plpgsql, stable, definer, pinned path | none | The builder (below), clock passed in for tests. `p_period` is `'7d'` or `'30d'`, else "Not a valid period." |
| `group_statistics(p_group_id uuid, p_period text) returns jsonb` | SQL wrapper | none | `group_statistics_at(..., now())` |
| `cached_group_statistics(p_group_id uuid, p_period text) returns jsonb` | plpgsql, definer | none | One-hour TTL, single flight on `pg_advisory_xact_lock(hashtext('group_stats_cache'), hashtext(group_id::text || period))`, `lock_timeout` 2 s then build without the lock, upsert |
| `group_stats_redact(p jsonb) returns jsonb` | SQL, immutable, pinned path | none | Removes `top`, `members`, `onAir.callsigns`, each place's `by` |
| `get_group_statistics(p_id uuid, p_period text) returns jsonb` | plpgsql, definer | authenticated | Owner only, else "Group not found." Returns the cached payload plus `group: {id, name, public, show_callsigns, public_slug, member_count, subscription_count}` |
| `list_group_summaries() returns table (id uuid, public boolean, spots bigint, members_heard int, members int, daily int[], on_air text[])` | plpgsql, definer | authenticated | The caller's groups. `daily` is the 30 days oldest first. `on_air` is live, at most 3 calls, newest first, plus the count from the payload |
| `public_group_statistics(p_slug text, p_period text) returns jsonb` | plpgsql, definer | service_role | Null unless the slug exists and the group is public. Returns the payload (redacted unless `show_callsigns`) plus `group: {name, member_count, show_callsigns}` |

`advisor.test.sql` gains `get_group_statistics` and `list_group_summaries` in the authenticated
list. Every new function pins `search_path`, `group_stats_redact` included.

### Cache table

```sql
create table group_stats_cache (
  group_id uuid not null references callsign_groups (id) on delete cascade,
  period text not null check (period in ('7d', '30d')),
  payload jsonb not null,
  generated_at timestamptz not null default now(),
  primary key (group_id, period)
);
alter table group_stats_cache enable row level security;  -- no policies
revoke all on group_stats_cache from anon, authenticated;
```

### The builder

`group_statistics` takes the group's members minus `hidden_callsigns` as `m(base)`, then reads
each store once, every read filtered on `base = any(...)` or `base_callsign = any(...)` and time.
It follows `callsign_profile` (`20261019000300`) for the live days. The periods are UTC days: the
period is the last N days ending today. "Previous" is the N days before.

- **Days and spots:** `callsign_days` for rolled-up days, plus `spot_stream` grouped by day for
  days without a `callsign_rollup_days` marker (at most the last 14).
- **Bands and buckets:** day-grain `callsign_activity` (role heard) plus the same live rows.
- **References:** `spot_stream` where `program is not null`, for the period, grouped by base,
  program, reference and UTC day. Names come from the newest non-null `reference_name`. SOTA has
  none and shows the reference alone.
- **Last heard:** `callsign_seen` joined, newer live spot wins.

Payload (`GroupStatistics` in `web/src/groups/stats/types.ts`, pinned by
`supabase/tests/group_statistics.test.sql`; change the SQL, the type and the test together):

```json
{
  "period": "30d",
  "generatedAt": "2026-10-19T14:48:00Z",
  "memberCount": 24,
  "kpis": {
    "spots": 10082, "previousSpots": 9002,
    "membersHeard": 20,
    "activations": {"pota": 26, "sota": 5, "wwff": 0},
    "places": {"parks": 19, "summits": 3}
  },
  "daily": [{"day": "2026-09-20", "spots": 412}],
  "calendar": [{"day": "2025-10-20", "spots": 283, "members": 5}],
  "top": {
    "spots":   [{"callsign": "KK4PWJ", "value": 2591}],
    "days":    [{"callsign": "KK4PWJ", "value": 17}],
    "cw":      [{"callsign": "KK4PWJ", "value": 2591}],
    "ssb":     [{"callsign": "K4DEF", "value": 812}],
    "digital": [{"callsign": "AC4MN", "value": 577}],
    "parks":   [{"callsign": "KK4PWJ", "value": 9}]
  },
  "members": [{"callsign": "KK4PWJ", "spots": 2591, "days": 17, "mainMode": "CW", "lastHeard": "2026-10-19T14:46:00Z"}],
  "bands": [{"band": "160m", "spots": 0}],
  "modes": [{"label": "CW", "spots": 7158}],
  "places": [{"reference": "US-2763", "name": "Falls Lake SRA", "program": "POTA", "times": 4, "by": ["KK4PWJ", "W4ABC"]}],
  "onAir": {"count": 3, "callsigns": ["W4ABC", "KK4PWJ", "N4GHI"]}
}
```

`memberCount` excludes hidden calls (decision 4). `daily` is the period's days, oldest first, zero
filled, used by the card sparkline. `calendar` is 365 days, zero days omitted, as the profile's.
`bands` is the profile's fixed 12-band list zero filled. `modes` is the five buckets in the
profile's order, zero buckets omitted. `top` lists hold three entries; ties break on callsign.
`places` holds the top 10 by times, then reference.

## Edge function `group-page`

- `supabase/functions/group-page/index.ts` is a `Deno.serve` shell around
  `_shared/handlers/group_page.ts`, which takes its client as an argument (`fake_supabase.ts` in
  tests). The directory gets its own `deno.json`.
- `config.toml` gets a block with `verify_jwt = false` and a comment. The function joins
  `function_config.test.ts`'s `verify_jwt = false` list and never imports `isServiceRole`.
- It accepts GET `?slug=<code>&period=7d|30d` (default `30d`). Other methods get 405. A
  malformed code or period gets 404 `{"error": "private"}` without a database call.
- Then, in order:
  1. `record_profile_lookup(rateLimitKey(...))`. Over 30 gets 429, `Retry-After: 60`. An error
     gets 500.
  2. `public_group_statistics`. Null gets 404 `{"error": "private"}`.
  3. Otherwise 200 with `Cache-Control: no-store`.
- The HMAC key and client IP header are set up as in `callsign-profile/index.ts`.

## Web

Routes in `web/src/App.tsx`:

| Path | Guard | Page |
| --- | --- | --- |
| `/groups` | `RequireAuth` | `GroupsPage` (landing cards) |
| `/groups/:id` | `RequireAuth` | `GroupPage`, Statistics tab |
| `/groups/:id/settings` | `RequireAuth` | `GroupPage`, Settings tab |
| `/g/:slug` | `PublicRoute` | `PublicGroupPage` |

`?period=7d` selects the shorter period on both statistics views; no parameter means 30 days.

`web/src/lib/api.ts` gains:

- `listGroupSummaries()`
- `loadGroupStatistics(id, period)`
- `loadPublicGroup(slug, period)`, a plain `fetchFunction` with the anon key and no session. A
  404 resolves to `null`, so the page can show "This page is private".
- `saveGroup`, which accepts the two sharing keys.

Files under `web/src/groups/`:

- `GroupsPage.tsx`: the landing cards, the empty state kept, and the New group dialog.
- `NewGroupDialog.tsx` and `PublicConfirmDialog.tsx`.
- `GroupPage.tsx`: breadcrumb, header (title, Public page / Private page chip, meta, Get alerts),
  and the tabs as links.
- `GroupStatistics.tsx`: everything under the tabs on the Statistics tab, rendered from a
  `GroupStatistics` payload and shared by the owner page and the public page. A missing redacted
  key hides its section.
- `GroupHeatMap.tsx`: the year grid on `calendar.ts`'s helpers, with the tooltip, legend, mobile
  sideways scroll and "View as table".
- `GroupSettings.tsx` and `MemberEditor.tsx`.
- `PublicGroupPage.tsx` and `GroupPrivate.tsx`.
- `stats/model.ts`: pure helpers for the comparison line, activation and place lines, ago text and
  heat levels, with `*.test.ts` in node.

Phones: the landing page stacks the cards and has a full-width New group. The group page hides
the chip and Get alerts in its header, as drawn. The KPI grid goes to two columns. The members
table drops Main mode and the places table drops By. The heat map scrolls sideways, starting at
the latest week.

`sx` stays layout only; colors come from the theme (`primary` for the heat map and sparkline, the
profile's bucket colors for modes).

## PR order

1. **This spec and the plan** (branch `group-stats-spec`). Brad reviews before any code.
2. **Schema** (`group-stats-schema`, stacked on 1): the migration, pgTAP, smoke test lines,
   regenerated `database.types.ts`. Merging applies nothing until Brad runs `supabase db push`;
   nothing reads the new objects yet.
3. **Owner pages** (`group-stats-web`, stacked on 2): `api.ts`, the landing cards, New group,
   the group page with both tabs, `MemberEditor`, `GroupDialog` removed. Needs 2's migration on
   hosted before it merges.
4. **Public page** (`group-stats-public`, stacked on 3): the `group-page` function, `/g/:slug`,
   the private page, `vercel.json`'s header, CLAUDE.md's "Group statistics rules",
   `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md`, and this spec marked shipped. Brad deploys
   `group-page` before merging, or the Settings tab's Open page links to a failing page.

## Verification

- **Schema:** `supabase db reset && supabase test db`. The new `group_statistics.test.sql` covers:
  - the payload shape and the period sums against hand-made `callsign_days`,
    `callsign_activity` and `raw_spots` rows
  - live days
  - hidden calls
  - redaction
  - private and unknown codes giving null
  - another user getting "Group not found."
  - cache reuse within the hour and cleared after a member change
  - the code kept through rename and off/on
  - `save_callsign_group` keeping sharing when the keys are absent

  Also `callsign_groups.test.sql`, `management_api.test.sql` (an API PATCH keeps `public`),
  `account_delete.test.sql` (the cache goes), `advisor.test.sql`, `scripts/smoke-test.sql` and
  `supabase db lint`.
- **Function:** `deno task test`, `coverage`, `check`, `lint`, `fmt`. The handler tests cover:
  method, malformed code, rate limit, error, null, success headers.
- **Web:** `cd web && npm run test:all`, `build`, `lint`. Then in `npm run dev:full`:
  1. Make a group of seeded calls (ending in S).
  2. Compare the card's figures with the Statistics tab's.
  3. Switch to 7 days.
  4. Make it public with callsigns off and open `/g/<code>` in a private window: no callsign
     anywhere, not in the network response either.
  5. Turn callsigns on and reload.
  6. Turn the page off and reload: "This page is private".
  7. Check the headers (`X-Robots-Tag` from Vercel only on a preview deployment, `no-store`
     locally).
  8. Compare phone width with `GroupStats-Mobile` and `GroupsLanding-Mobile`.

## Out of scope

- Periods longer than 30 days, and calendar-year periods (decision 1).
- Sharing settings through the management API (decision 8).
- Telling members their group went public; the copy tells the owner to.
- Several owners or editors for one group; viewing another user's private group.
- Any directory, search or sitemap of public groups.
- The canvas's Templates nav item (page 6).
- Band map and Stats page changes.

## Copy

Use these word for word. "KK4PWJ" becomes the signed-in callsign; `{…}` marks a value. Lines
marked *(amended)* differ from the canvas and *(added)* are not on it; the rest are the canvas's.
Counts take the singular at 1 ("1 member", "used by 1 connection").

**Groups landing**
- Header: Groups · A group is a named list of callsigns, like a club roster. See how the group is
  doing, share its statistics, and use it in connection rules. · button New group
- Phones' sentence: A group is a named list of callsigns, like a club roster. See how the group is
  doing and share its statistics.
- Empty state: today's, unchanged.
- Card: {name} · {N} members · used by {N} connections | {N} members · not used by any connection
  · chip Public | Private
- Card figures: Last 30 days · {N} spots · {N} of {N} members heard · sparkline label Spots per
  day, last 30 days
- Card on-air line: {N} on the air now: {CALL}, {CALL}, {CALL} | Nobody on the air right now
  (more than three: the newest three, then "and {N} more" *(added)*)
- Card actions: Statistics · Settings · Get alerts

**New group dialog**
- Title: New group
- Sentence: Name the group and add its callsigns. You can add more later.
- Field Name · helper Names are unique. A name can be reused after the group that has it is
  deleted.
- Field Callsigns · helper Separate with commas, spaces or new lines. You can also import a CSV
  later.
- Switch: Public statistics page · Off by default. When on, anyone with the link can see the club
  statistics.
- Buttons: Cancel · Create group
- Toast: Created {name} (today's)

**Group page header**
- Breadcrumb: Groups › {name}
- Title {name} · chip Public page | Private page · meta {N} members · used by {N} connections ·
  button Get alerts
- Tabs: Statistics · Settings

**Statistics tab** (owner and public page)
- Status: Updated {N minutes ago}. Statistics refresh every hour.
- Select Period: Last 7 days *(added)* · Last 30 days
- Spots heard · {N} · {N}% more than the previous {7|30} days | {N}% fewer than the previous
  {7|30} days *(added)* | Same as the previous {7|30} days *(added)* | None in the previous {7|30}
  days *(added)*
- Active members · {N} of {N} · Heard at least once
- Activations · {N} · {N} POTA, {N} SOTA (and ", {N} WWFF" when nonzero *(added)*)
- Places activated · {N} · {N} parks, {N} summits
- Heat map card: Club activity over the past year · Spots heard each day for all members
  combined. Hover a day for the count. Ignores the period above.
- Tooltip: {N} spots · {Weekday, Month D, YYYY} · {N} members on the air | No spots *(added, a
  zero day)*
- Legend: Club spots per day: none, 1 to 99, 100 to 199, 200 to 399, 400 or more. (phones add:
  Scroll sideways for earlier months.) · Less · More
- Toggle: View as table | View as heat map *(added, the profile's)*
- Section: Who is most active
- Top lists, heading then subheading:
  - Most spots · All modes and sources
  - Most days on the air · Days heard in the period; value {N} of {7|30}
  - CW · Spots heard
  - SSB · Spots heard
  - Digital · FT8 and FT4 spots heard
  - POTA activations · Parks activated
  - Empty list: Nobody yet *(added)*
- Members card: Members · Ranked by spots heard in the period. {N} of {N} members were heard.
  · field Search members · columns # · Callsign · Spots · Days · Main mode · Last heard (phones
  drop Main mode) · ages "2 min ago", "3 hours ago", "9 days ago" · button Show all {N} members ·
  unheard: — and Not heard yet *(added)*
- Bands card: Bands · Club spots by band
- Modes card: Modes · Club spots by mode · legend CW · SSB · FT8 and FT4 (and FM, Other when
  present)
- Places card: Most activated places · Parks and summits the club activated in the period ·
  columns Reference · Name · Program · Times · By (phones drop By) · empty: No activations in the
  period *(added)*

**Settings tab**
- Public card: Public statistics page · chip Public | Private
  - On: Anyone with the link can see this page, without signing in. Your settings and member list
    are never shown.
  - Off: Only you can see this page, when you are signed in. Turn this on to share the club
    statistics with a link.
  - On, below a divider: the link `longlines.io/g/{code}` *(amended: code only, decision 2)* ·
    Copy link · Open page
  - Show each member's callsign · Off shows club totals only. Rankings and top operators are
    hidden.
  - The link is not listed anywhere and search engines are asked not to index it. Turn this off
    and the link stops working right away.
- Buttons: Cancel · Save changes · toast Saved changes (today's) · Link copied *(added)*
- Name card: Name · Shown on the statistics page and in connection rules · field Name · helper as
  in the New group dialog
- Members card: Members · {N} of 1,000 callsigns · tabs Type · Paste · Import CSV · field Paste
  callsigns · helper Separate with commas, spaces or new lines. · button Add callsigns · list
  heading Members · Remove all · field Search members · chips · +{N} more (Type and Import CSV
  keep today's dialog copy)
- Used by card: Used by · Connections that use this group in a rule · rows {connection name} with
  a source chip | Not used by any connection *(added)*
- Delete card: Delete group · Removes the group and its public page. Remove it from connections
  first. · button Delete group · disabled tooltip Used by {N} connection. Remove it from them
  first. | Used by {N} connections. Remove it from them first.

**Make the statistics page public? dialog**
- Title: Make the statistics page public?
- Anyone with the link will be able to see, without signing in:
  - Ticked: The callsigns of all {N} members, and how active each one is | Unticked: Club totals
    only, without callsigns *(added, decision 13)*
  - Club totals, charts and the year heat map
  - The parks and summits members activated
- Your settings, the member list editor and your connections are never shown. Members do not get
  a notice, so tell them first.
- Checkbox: Show each member's callsign on the public page
- Buttons: Keep private · Make public

**Public page**
- App bar: PublicShell's (Band map · Lookup · Sign in)
- Title {name} · chip Public page · Club statistics · {N} members · Updated {N minutes ago} ·
  button Share (copies the link where the browser cannot share; toast Link copied *(added)*)
- Then the Statistics tab's content
- Footer note: Built from public spots for the callsigns in this group. The group owner chose to
  share this page and can turn it off at any time. Long Lines does not show addresses.
- Document title: {name} statistics

**Private page**
- This page is private · The statistics for this group are not public. If you own the group, sign
  in to see them. · button Sign in (signed out only)
