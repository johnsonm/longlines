# Spotted activations: design

Date: 2026-11-01. Status: **accepted; building** (PR 1, this spec). Brad approved the
implementation plan this file condenses; the four points under Assumptions are the plan's reading
of the brief, decided by the plan, and Brad may revisit them. If the design changes during a PR,
update this file in that PR.

Source: Brad's canvas "Callsign profile: spotted activations"
(`https://claude.ai/artifact/ShuU5J5QZXcGvzMRa9iTYK`, artboards Main, Activation, MainMobile and
ActivationMobile, read 2026-10-31) and the feature brief "Feature: Spotted activations". The
canvas is the source of truth for layout and wording; its copy is this file's Copy section. The
behaviour comes from the brief; the technical design is ours. The canvas is drawn with stock MUI
values: build it with real MUI components, never its inline CSS. Where the canvas and this file
disagree, this file wins.

## Purpose

Hams share an activation after they finish one. Long Lines already stores every POTA, SOTAwatch,
WWFF, WWBOTA and DX Cluster spot (plus the RBN firehose), so it can recognise an activation on its
own: a run of spots of one callsign at one reference, followed by quiet.

This feature adds:

- a **Spotted activations** tab on the public callsign profile (`/call/<base>?tab=activations`):
  a twelve-month summary and the activator's recent activations, grouped by UTC day;
- a public, shareable **detail page** per activation (`/activations/<id>`): where the activator was
  heard, on which bands and modes, every spot that made it up, and a timeline;
- a **Copy link** button and **link previews** (Open Graph tags and a map image), so a link pasted
  into Discord or Slack unfurls as the activation.

Everything is labelled as *estimated from spots, not logs*: Long Lines never sees contacts, so it
cannot say whether an activation met a program's minimum.

## Assumptions

The brief leaves these open; the plan decided them. Each is **[DECIDED by the plan, Brad may
revisit]**.

1. **Three profile tabs.** The callsign profile gets the canvas's three tabs: **Activity** (today's
   page minus Recent spots), **Spotted activations** (new) and **Spots** (the existing Recent spots
   table). The tab lives in the query string, `/call/<base>?tab=activations|spots`; Activity has no
   parameter. **[DECIDED by the plan, Brad may revisit]**
2. **Closed activations only.** An activation is listed only once it has closed (no spot for the
   gap, 45 minutes), so it appears about 45 minutes after its last spot. Nothing in the canvas shows
   an in-progress state. **[DECIDED by the plan, Brad may revisit]**
3. **One program per activation.** A POTA park and a WWFF reference activated at once are two
   activations, one per program; a two-fer is within one program. **[DECIDED by the plan, Brad may
   revisit]**
4. **Previews render on Vercel** (`web/api/*`, `@vercel/og`), as the reference profiles spec
   planned for `ref-preview.ts` (never built). Supabase rewrites a GET `text/html` reply to
   `text/plain` on its own domain, so the HTML cannot come from an Edge Function. **[DECIDED by the
   plan, Brad may revisit]**

## Decisions

Behaviour, from the brief:

1. **An activation is a run of one activator's spots at one reference, with no gap longer than
   `activation_gap()` (45 minutes).** The activator is the base call (`raw_spots.base_callsign`,
   from `base_callsign()`), so `KK4PWJ/P`, `KK4PWJ/M`, `KK4PWJ/QRP`, `KK4PWJ/7` and `KK4PWJ` land in
   one activation. Reference spots come from POTA, SOTAwatch, WWFF, WWBOTA, and DX Cluster spots
   that carry an IOTA reference. Programs: `pota`, `sota`, `wwff`, `wwbota`, `iota`.
2. **Two-fers are one activation.** Spots of one activator in one program at overlapping times
   but different references (a POTA two-fer: one spot naming `US-2730` and another `US-4560`, or a
   spot naming both) fold into one activation listing every reference in feed order. A WWBOTA spot
   names several bunkers at once; every bunker is a reference of its activation.
3. **Rover days are several activations.** A rover's sequential parks never overlap in time, so
   each is its own activation. The tab groups activations under one UTC day heading and notes "3
   parks in one day".
4. **A single spot is an activation.** It closes like any other, with a `1 spot` chip and the note
   "Only spotted once. It may have ended early or just not been re-spotted."
5. **POTA splits at 00:00 UTC.** POTA counts each UTC day as its own activation, so a POTA run
   that crosses midnight is two activations, the later one pointing at the earlier
   (`continued_from`), both chipped `Split at 00:00 UTC`. Other programs do not split at midnight.
6. **Forward only.** Detection starts when the migration is pushed. There is no backfill of past
   spots.
7. **Late spots are dropped.** A spot ingested after its activation closed is never attached to
   it, and it opens nothing: a spot that would have attached to a closed row is dropped (detection
   step 3). Acceptable per the brief.
8. **Ids are permanent and opaque.** An id is 12 characters of `[a-z2-7]` (the `new_group_slug()`
   recipe), made once and never changed or reused. Old ids keep working through
   `spotted_activation_redirects`; nothing automatic writes it today (decision 12), a future
   correction tool would.
9. **One canonical URL.** `/activations/<id>` is canonical. `/<callsign>/activations/<id>` is an
   alias that renders the same page and replaces the URL with the canonical one (a wrong callsign
   too). A redirected id also lands on the canonical id. The alias's callsign is one path segment;
   the web never builds alias links, so a call with a `/` simply has no alias.
10. **Copy link** copies the canonical URL with the page's origin and toasts "Link copied.", or
    "Couldn't copy the link." on failure.
11. **Links unfurl.** Link-preview crawlers get a small HTML page of Open Graph tags with a
    1200×630 PNG map; browsers keep getting the app.

Design, from the plan and its review:

12. **Detection is SQL only**, one pg_cron job a minute
    (`assemble_spotted_activations(now())`), never TypeScript. Every figure on the tab and the page
    is SQL's; the web only words it.
13. **Forward reading is exact** through a `(ingested_at, id)` watermark and a cutoff that no open
    insert transaction can outlive (detection step 1).
14. **UTC day arithmetic everywhere.** A day is `(x at time zone 'utc')::date`, never `::date` or
    `current_date`, so a session time zone never moves a split.
15. **One split pointer.** `continued_from` is the only stored link between halves of a POTA
    midnight split; "continued by" is derived at read from its index.
16. **A two-fer merges only while both rows are open.** Rows are invisible until closed, and a
    closed row never merges, so a merge never retires an id anyone has seen and writes no redirect.
17. **RBN and DX Cluster spots join at close**, on the reference spots' bands only, for the
    window from the first to the last reference spot. RBN is read with the window's start
    truncated to the minute (RBN times are minute-granular) and only `spot_type in ('CQ', 'DX')`
    (no `BEACON`, no `NCDXF`).
18. **Places are SQL's.** A spotter's US state comes from `callsign_licenses` and is always a
    state, never a country (Alaska and Hawaii are their own DXCC entities but count as states); any
    other spotter is its cty.dat entity. Coordinates come from `reference_catalog`,
    `us_state_centroids` and `cty_entities`. The web never resolves a place.
19. **Hidden calls count nowhere.** A hidden activator has no tab and no pages (both RPCs null);
    a hidden spotter's spots are left out of the page, and its places and the farthest figure are
    recomputed without them.

## Schema

Migration `supabase/migrations/20261101000100_spotted_activations.sql` (PR 2). Every table has RLS
on and no policies, `revoke all ... from anon, authenticated`: service role only.

### Tables

- `spotted_activations`:
  - `id text primary key`, from `new_activation_id()` (12 characters of `[a-z2-7]`, the
    `new_group_slug()` recipe, `search_path = public, extensions`);
  - `base_callsign text not null`;
  - `program text not null check (program in ('pota', 'sota', 'wwff', 'wwbota', 'iota'))`;
  - `references text[] not null` (feed order, upper case) and `reference_names text[]`
    (index-aligned with `references`, null where neither the feed nor the reference list names
    one: WWBOTA names only the first bunker, and the close fills a null name from
    `reference_catalog`, which names SOTA summits);
  - `day date not null`: the UTC day of `started_at`, always `(started_at at time zone 'utc')::date`,
    recomputed when an earlier spot extends `started_at`;
  - `started_at`, `last_spot_at timestamptz not null`, `closed_at timestamptz null`;
  - `continued_from text null references spotted_activations` (the only split pointer);
  - `latitude`, `longitude numeric null` and `location_states text[]` (the reference's own US
    states from `reference_catalog.location`, parsed as `goal_park_state` does), from the first
    reference's catalog row;
  - summary columns filled at close: `spot_count int`, `source_counts jsonb` (source to count),
    `bands text[]`, `modes text[]` (canonical modes as `modes.ts` wrote them; readers fold USB and
    LSB), `states text[]`, `countries text[]` (cty entity names, US states left out), `farthest
    jsonb null` (`{kind, code, name, km}`);
  - `created_at timestamptz not null default now()`.

  Indexes: `(base_callsign, started_at desc) where closed_at is not null` (the list and the
  twelve-month summary), `(base_callsign, program) where closed_at is null` (the attach probe),
  `(continued_from)` (deriving `continuedBy`).
- `spotted_activation_redirects(old_id text primary key, new_id text not null references
  spotted_activations)`. `spotted_activation(id)` follows it; the web replaces the URL with the
  canonical id. No automatic path writes it (decision 16).
- `spotted_activation_spots`: one row per spot that makes up an activation.
  - `id bigint generated always as identity primary key` (a surrogate key: spots from different
    sources share no natural key);
  - `activation_id text not null references spotted_activations on delete cascade`;
  - `source text not null`, `source_spot_id text null`, `spot_time timestamptz not null`,
    `callsign text not null` (as spotted), `spotter text null` (SOTAwatch nulls RBNHOLE spotters),
    `spotter_base text null`, `self_spot boolean not null`, `frequency_khz numeric`, `band text`,
    `mode text`, `references text[] null` (null for RBN and DX Cluster rows);
  - `spotter_state text null` (US only), `spotter_entity text null`, `spotter_country text null`
    (the entity name).

  Partial unique indexes, every insert `on conflict do nothing`:
  `(activation_id, source, source_spot_id) where source <> 'rbn'` (a POTA comment edit re-inserts
  the spot into `raw_spots` with a new `content_hash` and must not raise `spot_count`) and
  `(activation_id, spot_time, spotter, callsign, frequency_khz) where source = 'rbn'` (the
  `rbn_spots` natural key). Index `(activation_id, spot_time)`. RBN rows are copied here because
  `rbn_spots` partitions retire after about 7 days.
- `spotted_activation_state`: one row, `watermark_at timestamptz`, `watermark_id bigint`,
  `last_run_at timestamptz`. Seeded with `now()` and the current max id at migration time: **no
  backfill** (decision 6).
- `us_state_centroids(state text primary key, name text, lat numeric, lon numeric)`: the 50 states
  and DC, computed once from `us-atlas` with `d3-geo`'s `geoCentroid` and pasted into the
  migration.
- Index `raw_spots_ingested_at_id_idx on raw_spots (ingested_at, id)`, so the watermark's tuple
  comparison is one range scan (hosted `raw_spots` is about 600,000 rows).

### Knobs

Immutable SQL functions, `search_path = ''`, each the one statement of its number:

| Function | Value | Use |
| --- | --- | --- |
| `activation_gap()` | `interval '45 minutes'` | the longest quiet inside an activation (the canvas copy says 45) |
| `activation_ingest_lag()` | `interval '30 seconds'` | how far behind `now()` a pass reads |
| `activation_batch_limit()` | `5000` | reference spots read per pass |
| `activation_close_limit()` | `100` | activations closed per pass |

Helper `great_circle_km(lat1, lon1, lat2, lon2)` (immutable, haversine on a 6371 km sphere,
pinned `search_path`).

## Detection

`assemble_spotted_activations(p_now timestamptz) returns int`: security definer,
`search_path = public`, takes `pg_advisory_xact_lock(hashtextextended('spotted_activations', 0))`
first. Scheduled as `cron.schedule('assemble-spotted-activations', '* * * * *', $$ select
public.assemble_spotted_activations(now()); $$)`. Cron sessions have a 2-minute statement timeout;
the batch and close limits keep a pass well inside it.

1. **Cutoff.** `v_cutoff = least(p_now - activation_ingest_lag(), min(xact_start) of the other
   active client backends in pg_stat_activity)`. `raw_spots.ingested_at` defaults to `now()`, the
   transaction start, and `id` is assigned at insert, not commit, so reading `(ingested_at, id)` up
   to a time cutoff is exact only if no insert transaction outlives the cutoff. The `xact_start`
   guard makes that a guarantee, and degrades to the plain lag if the role cannot see other
   sessions' `xact_start`. Every source read here reaches `raw_spots` only through `ingest_spots`,
   one sub-second statement; `logged` (which `apply_logged_contacts` wraps in a longer transaction)
   is not read. The cutoff never exceeds `p_now`. *(A second pgmq queue fed by `ingest_spots` was
   considered and rejected: it couples detection to every future `ingest_spots` version and still
   needs time order for the gap logic.)*
2. **Read new reference spots.** From `raw_spots` where `(ingested_at, id) > (watermark_at,
   watermark_id)`, `ingested_at <= v_cutoff`, `retracted_at is null`, and the source is `pota`,
   `sotawatch`, `wwff`, `wwbota`, or `dxcluster` with `iota_reference is not null`, and the spot
   has a reference. A SOTAwatch QRT spot without a summit is skipped; one with a summit attaches as
   an ordinary spot. Program, references and names use `spot_stream`'s expressions (WWBOTA: every
   bunker of `wwbota_references`, the name on the first). Ordered by `(ingested_at, id)`, limited
   to `activation_batch_limit()`; `v_capped` is set when the limit was hit. The watermark always
   advances to the last row read, never further.
3. **Attach or open**, a plpgsql loop in batch order (hundreds of spots a minute, one index probe
   each). Find the open row (`closed_at is null`) with the same `base_callsign` and program,
   `references && spot.references`, and `spot_time` within `[started_at - gap, last_spot_at + gap]`
   (so a spot that arrives out of order still attaches); POTA also requires the same UTC day.
   - Hit: insert the spot row (`on conflict do nothing`), extend `started_at` / `last_spot_at`,
     recompute `day`, union `references` and `reference_names` (names stay aligned).
   - Miss on open rows, but a closed row of the same base call and program would have matched
     (same probe, `closed_at is not null`): drop the spot (decision 7), so a late spot never
     opens a one-spot copy of a finished activation. *(Spelled out by this spec; the plan's
     "never attached" implied it.)*
   - Miss: insert a new row with a new id.
   - POTA only, the midnight split, looking both ways: an open same-reference row on the previous
     UTC day whose `last_spot_at` is within the gap of the new row's first spot sets the new row's
     `continued_from`; an open same-reference row on the next UTC day within the gap (the 00:02
     spot ingested before the 23:58 one) gets `continued_from = <new id>` when its own is null.
4. **Merge two-fers**, after the loop. For each `(base_callsign, program)` (and UTC day, for POTA)
   with two open rows whose `[started_at, last_spot_at]` intersect (closed intervals, so two
   self-spots at the same second merge), fold the younger row into the older (by `created_at`,
   then `started_at`, then id). Only a row the pass touched can have come to intersect another, so
   the search starts from those rows and searches a survivor again, since it has grown. Folding
   re-points its spot rows (`on conflict do nothing`), union references and names, `coalesce` `continued_from` into
   the survivor, re-point any row whose `continued_from` was the deleted id, then delete the
   younger row. No redirect is written (decision 16). A rover's sequential parks never intersect,
   so they stay apart. Two open rows that share a reference also fold when each lies within the
   gap of the other: a spot read out of order can bridge two runs at one reference (18:00, 18:10
   and 19:30 read first, 18:50 last), which in time order would have been one activation.
5. **Close**, skipped entirely when `v_capped` (closing against `p_now` while unread spots sit
   behind the watermark would close too early; the next pass closes). For at most
   `activation_close_limit()` open rows with `last_spot_at < p_now - activation_gap()`, oldest
   first. While another transaction holds the cutoff back, `p_now` here is instead that
   transaction's start plus `activation_ingest_lag()`, for the same reason:
   - Attach `rbn_spots` rows with `base_callsign(callsign) = base_callsign`,
     `spot_time >= date_trunc('minute', started_at)` and `spot_time <= last_spot_at`,
     `spot_type in ('CQ', 'DX')`, and `band = any(<the bands of the row's reference spots>)`
     (`rbn_spots_base_callsign_time_idx` plus partition pruning serve it).
   - Attach `raw_spots` `dxcluster` rows of the base in the same window and bands that are not
     already attached (an IOTA spot already is).
   - Resolve each distinct `(spotter, spotter_base)` of the new rows once
     (`rollup_country_day`'s pattern: `left join lateral cty_lookup(spotter) on true`, and
     `callsign_licenses` by `spotter_base` with `country = 'US' and state = any(us_states())`).
     `self_spot = is_self_spot(callsign, spotter)`.
   - Summary: `spot_count`, `source_counts`, `bands`, `modes` (each ordered by spots, most
     first); `states` = the distinct states of non-self spotters; `countries` = the distinct entity
     names of non-self spotters **with no state**, the United States entity (`K`) left out, so a US
     spotter with no license state is in no place (a spotter with a US state is always a state: a KL7 with an AK license is Alaska, the
     state); `farthest` by `great_circle_km` from the first reference's catalog coordinates to
     each state's centroid and each country's `cty_entities.lat/lon` (no coordinates: no
     `farthest` and no map lines, which is every WWBOTA and IOTA activation);
     `latitude` / `longitude` / `location_states` from the catalog.
   - Set `closed_at = p_now`. A closed row never changes again, except that reading it recomputes
     for hidden spotters (decision 19).
6. Update `last_run_at`; return the number of reference spots read. A raised error fails the cron
   run, which `/health` already shows for every job.

Not attached, by design: a spot ingested after its activation closed (decision 7), and the RBN
rows of an activation closed after its `rbn_spots` partition retired (a backlog older than about 7
days).

### Known limitation: the chaser merge false positive

A rover activates park A, moves to park B and is spotted there; a chaser then re-spots park A from
an old spot. Park A's row now reaches past the start of park B's row, the two intersect, and step
4 merges them into one two-fer. It needs a stale re-spot inside the gap, so it is rare; accepted.

## Read RPCs

Security definer, `search_path = public`, service role only, never granted to clients. No SQL
cache: both are index lookups over one activator's closed, immutable rows, not aggregates over
`raw_spots`, and `lookupLimit` plus `Cache-Control` bound the rate.

- `spotted_activation(p_id text) returns jsonb`: follows `spotted_activation_redirects`; null for
  an unknown id, an open row, or an activator in `hidden_callsigns` (by base). Spot rows whose
  `spotter_base` is hidden are left out of `spots`, and `heard`, the state and country counts and
  `farthest` are recomputed from the remaining rows at read (cheap, bounded by one activation).
  `split.continuedBy` is derived from `continued_from`.
- `callsign_spotted_activations(p_callsign text, p_now timestamptz) returns jsonb`: validates the
  call with `base_callsign` as `callsign_profile` does; null for a malformed or hidden call.
  Returns `{callsign (base), summary, recent, more}` over closed rows:
  - `summary.activations`: activations started in the past 12 months;
  - `summary.references`: `{total, pota, sota, wwff, wwbota, iota}`, distinct program and
    reference over 12 months;
  - `summary.onAirSeconds`: the sum of `last_spot_at - started_at` over 12 months;
  - `summary.mostActivated`: `{program, reference, name, times}` or null;
  - `recent`: closed activations, newest first, at most 200, with `more` when there were more.
    The web shows 10 and "Show all N".

## Payloads

TypeScript in `web/src/activations/types.ts`; Zod loose schemas beside the handler; both pinned by
`supabase/tests/spotted_activations.test.sql` (`pg_temp.keys`). Change the SQL, the types, the
schemas and the test together.

```
SpottedActivation {
  id, callsign (base), program, references[], referenceNames[], day, startedAt, lastSpotAt,
  durationSeconds, split: {continuedFrom: id | null, continuedBy: id | null},
  location: {latitude, longitude, states[]} | null,
  spotCount, sources: {pota?, sotawatch?, wwff?, wwbota?, dxcluster?, rbn?},
  bands[], modes[],
  heard: [{kind: "state" | "country", code, name, latitude, longitude, spots}],
  farthest: {kind, code, name, km} | null,
  spots: [{time, source, spotter, spotterBase, selfSpot, place (state name | country | null),
           frequencyKhz, mode, references[] | null}]   (all of them, time ascending)
}

ActivationCard (a `recent` row) {
  id, program, references[], referenceNames[], day, startedAt, lastSpotAt, durationSeconds,
  spotCount, bands[], modes[], states (count), countries (count), continuedFrom, continuedBy
}

CallsignActivations {
  callsign (base),
  summary: {activations, references: {total, pota, sota, wwff, wwbota, iota}, onAirSeconds,
            mostActivated: {program, reference, name, times} | null},
  recent: ActivationCard[], more
}
```

`id` in the detail payload is always the canonical id, so the page can tell a redirected URL.

## Edge functions

- `spotted-activations` (PR 3): `supabase/functions/spotted-activations/{index.ts, deno.json}`
  (the `callsign-profile` `deno.json`), handler `_shared/handlers/spotted_activations.ts`. GET only.
  `?id=<[a-z2-7]{12}>` reads the detail, `?callsign=<call>` (the profile handler's
  `parseCallsign`) the list; anything else is a 404 or 400 before any database call. It shares the
  callsign profile's budget (`lookupLimit(..., "spotted-activations", ...)`), answers a null with a
  404 `{error: "Spotted activation not found."}`, a failed RPC or a reply outside the schema with a
  500, and sends `Cache-Control: public, max-age=300` only on a 200. It never logs an id or a call.
  `verify_jwt = false` in `config.toml`, in `function_config.test.ts`'s list, and it never imports
  `isServiceRole`. Tests: `_shared/__tests__/handlers_spotted_activations.test.ts` with
  `fakeSupabase` (405, 400, 404 before the database, 429, 500 fail-closed, 200 headers, Zod
  refusing a malformed payload).

## Web

| Path | Guard | Page |
| --- | --- | --- |
| `/call/*?tab=activations` | `PublicRoute` | Callsign profile, Spotted activations tab |
| `/call/*?tab=spots` | `PublicRoute` | Callsign profile, Spots tab |
| `/activations/:id` | `PublicRoute` | Spotted activation (canonical) |
| `/:call/activations/:id` | `PublicRoute` | The same page; redirects to `/activations/:id` |

New folder `web/src/activations/` (PR 4):

- `types.ts`; `paths.ts` (`activationPath(id)` gives `/activations/<id>`, `activationUrl(origin,
  id)`, `activationsTabPath(base)` gives `/call/<base>?tab=activations`); `model.ts`, pure
  wording: `dayHeading` ("Thu 29 Oct 2026"), `timeWindow` ("18:12–19:40"), `duration` ("1 h 28
  min", "47 min"), `heardIn` ("14 states · 2 countries", and "Heard in 14 states, plus Canada and
  Germany."), `aboutKm` ("about 7,000 km", two significant figures), the chips (`Two-fer` when there
  is more than one reference, `1 spot`, `Split at 00:00 UTC`), the day note ("3 parks in one day",
  the activations under one day heading), the single-spot note, the continued-from note, and the
  estimate note with the gap in words; `fixtures.ts`.
- Hooks `useCallsignActivations(base)` and `useSpottedActivation(id)`: `keyedCached`, a 5-minute
  TTL, `{data, notFound, error, loading}`, as `useReferenceProfile`. One request per visit; never
  poll.
- `ActivationsTab.tsx`: the info `Alert`, four `Kpi` cards, and the "Recent" card: a desktop
  `Table` grouped by UTC day (day rows carry the rover note), phone stacked `ListItemButton` rows
  (`setMobile` tests); the first 10, then "Show all N". Each row links to `activationPath(id)`.
- `ActivationPage.tsx`: the back link to the tab, the overline, the h1, the names, the date line,
  the primary `Copy link` button (`navigator.clipboard.writeText(activationUrl(origin, canonical
  id))`, then `notify("Link copied.")`, or "Couldn't copy the link."; a `copyLink` helper beside
  `shareLink` in `lib/share.ts`), `HeardMap`, the "On the air" list, `SpotsTimeline`,
  `ActivationSpots`, and the "How this was estimated" alert. A `document.title` effect. Not found
  shows a card like the reference page's `NotFound`. When the payload's id differs from the URL's
  (a redirected id, or the alias), `Navigate replace` to `/activations/<id>`.
- `HeardMap.tsx`: `STATE_SHAPES` from `stats/stateShapes.ts` as the base, with `UsStateMap`'s fills
  (`action.hover`, strokes `background.paper`). The reference point and the heard states are
  projected with `geoAlbersUsa().scale(1300).translate([487.5, 305])` (us-atlas's projection for
  `states-albers-10m`) in a DOM-free `geometry.ts` shared with the preview image. One line per
  heard state (`primary.main`, with opacity), the reference's own states shaded with no line, state
  labels, the caption from `heardIn`. Countries are text only. Without a location: the shading
  only, plus "Location not known for this reference." Built with `Box component="svg"` and MUI
  `Tooltip`, never a chart library. The map draws SQL's coordinates only.
- `SpotsTimeline.tsx`: MUI X `ScatterChart`, one lane per source present, colours from
  `sourceColor(theme, source)`, x axis UTC `HH:MM`, as `BandStrip` (no Pro components).
- `ActivationSpots.tsx`: a desktop `DataGrid` (Time (UTC), Source, Heard by, kHz, Mode, Reference)
  and phone rows; the first 6, then "Show all N spots". Spotters link to `/call/<spotterBase>`
  (`lookupPath`), the base from SQL.
- `profile/CallsignPage.tsx`: MUI `Tabs` under the header (Activity, Spotted activations, Spots),
  the value from `useSearchParams`' `tab`. The Spots tab holds the existing Recent spots table;
  the activations tab mounts `ActivationsTab`, which makes its own request only when selected.
  `/call/*`'s redirects to the canonical base call keep the query string (today's `Navigate`
  drops it).
- `App.tsx`: the two activation routes; new `Page` / `PublicPage` entries; `layout/nav.ts` maps
  `activations` to the `lookup` section, so Callsign lookup stays highlighted. React Router ranks
  static segments first, so `/:call/activations/:id` never shadows an existing route.
- `lib/api.ts`: `loadSpottedActivation(id)` and `loadCallsignActivations(callsign)` with plain
  `fetch` and the `apikey` header only; only the function's own 404 body ("Spotted activation not
  found.") means null, any other 404 is an outage.
- Tests: `model.test.ts`, `geometry.test.ts`, `paths.test.ts` (node); `ActivationsTab.test.tsx`,
  `ActivationPage.test.tsx` (copy link, canonical redirect, title, not found, phone rows),
  `HeardMap.test.tsx`, the tab cases in `CallsignPage.test.tsx`; URLs in `api.test.tsx`; routes in
  `App.test.tsx`.
- `docs-site/src/content/docs/spotted-activations.md` under "Look things up" (`astro.config.mjs`).

## Previews (PR 5)

- `web/api/activation-preview.ts` (a Vercel Node function): `GET /api/activation-preview?id=`. It
  calls `spotted-activations` with `SUPABASE_URL` / `SUPABASE_ANON_KEY` (the integration's env) and
  returns HTML with `og:title` (`KK4PWJ at US-2730 · Spotted activation`), `og:description` (the
  names, date, window and duration, then `Estimated from spots, not logs.`), `og:url` (canonical),
  `og:site_name` (`Long Lines`), `og:image` (`/api/activation-image?id=`), `og:image:width` and
  `og:image:height`, `twitter:card` `summary_large_image`, `<link rel="canonical">` and a plain
  link. Every value is HTML-escaped. `Cache-Control: public, s-maxage=900`. A 404 from the function
  is a 404 here. The HTML builder is a pure function tested in Vitest.
- `web/api/activation-image.ts` (Vercel Edge runtime, `@vercel/og`'s `ImageResponse`, a 1200×630
  PNG: Discord does not render an SVG `og:image`): the map from `geometry.ts` and `STATE_SHAPES` as
  inline `<svg>` paths, the title and the date line. No JSX: the builder returns Satori's plain
  element objects (`{type, props}`), so the file stays `.ts` under `tsconfig.node.json`'s rules
  (Node types, erasable syntax). The builder is pure and tested with `@vercel/og` mocked.
  `@vercel/og` goes in `web/package.json` with a comment saying why (the one renderer that makes a
  PNG on Vercel without a browser).
- `web/vercel.json`: before the catch-all, rewrites of `/activations/:id` and
  `/:call/activations/:id` to `/api/activation-preview?id=:id`, with `has: [{type: "header", key:
  "user-agent", value: ".*(Discordbot|Slackbot|Twitterbot|facebookexternalhit|TelegramBot|WhatsApp|
  LinkedInBot|Mastodon|Applebot|Bluesky).*"}]`. Humans keep getting `index.html`.
- `web/tsconfig.node.json`'s `include` gains `"api"`, so `npm run typecheck` covers it; the Vitest
  `node` project's `include` gains `api/**/*.test.ts` and coverage's `include` gains `api/**/*.ts`.
  Vite's build ignores `api/` (its only entries are `index.html` and `sw.ts`). `geometry.ts` and
  `stateShapes.ts` are imported from `api/` with `.ts` extensions, so they must stay DOM-free.

## Docs and operations

- `CLAUDE.md`: "Spotted activation rules" (PR 1, this PR); "Profile rules" gains the tabs.
- `docs/ARCHITECTURE.md` (the tables and the cron job) and `docs/OPERATIONS.md` (the cron table,
  the one-time deploy of the new function by hand, the Vercel env).
- `scripts/smoke-test.sql` checks the job exists; `supabase/seed.sql` calls
  `assemble_spotted_activations(now() + interval '1 minute')` after its spots so a local reset has
  activations; `supabase/tests/advisor.test.sql` lists no new client-callable function, and every
  new function pins `search_path`; `web/src/lib/database.types.ts` is regenerated.

## PR order

Stacked, one worktree each (`../longlines-<branch>`):

1. **Spec** (`spotted-activations-spec`): this file and the CLAUDE.md rules.
2. **Schema** (`spotted-activations-schema`): the migration (tables, redirects, knobs,
   `new_activation_id`, `great_circle_km`, `us_state_centroids`, the `raw_spots (ingested_at, id)`
   index, `assemble_spotted_activations`, the two read RPCs, the cron job, grants),
   `supabase/tests/spotted_activations.test.sql`, the seed, the smoke test, the advisor lists and
   the OPERATIONS cron table. Deploy: `supabase db push`.
3. **Function** (`spotted-activations-function`): the Edge Function, handler, Zod schemas,
   handler tests, `config.toml`, `function_config.test.ts`, `deno.json`. Deploy by hand:
   `supabase functions deploy spotted-activations` (the integration skips new functions).
4. **Web** (`spotted-activations-web`): the tabs, the detail page, routes, hooks, api, tests,
   database types, the docs-site page. Vercel ships it.
5. **Previews** (`spotted-activations-previews`): `web/api/*`, the `vercel.json` rewrites,
   `@vercel/og`, the tsconfig and Vitest wiring. Vercel ships it.

## Verification

- **SQL** (`spotted_activations.test.sql`, inserting `raw_spots` / `rbn_spots` relative to `now()`
  and calling `assemble_spotted_activations(p_now)` at chosen instants):
  - a run of POTA spots with gaps under 45 minutes is one activation and closes after the gap; a
    46-minute gap makes two; `/P` and the plain call land in one;
  - a two-fer (two references, interleaved spots) merges into one row with both references, the
    younger row is gone, its spot rows belong to the survivor, and `continued_from` pointers
    survive the merge;
  - a row in `spotted_activation_redirects` resolves to the canonical payload;
  - a rover's three parks in a day stay three;
  - a spot read out of order that bridges two runs at one reference makes them one activation,
    while a rover's parks within the gap of each other stay apart;
  - POTA across 00:00 UTC splits with `continued_from` and the derived `continuedBy`, also when the
    00:02 spot is ingested before the 23:58 one, and under `set time zone 'America/New_York'`; a
    SOTA run across midnight does not split;
  - a single spot closes as a one-spot activation;
  - a SOTAwatch spot with a null spotter attaches, and a QRT with a null summit is skipped;
  - a POTA comment edit (same `source_spot_id`, new hash) does not raise `spot_count`;
  - RBN rows in the first minute and inside the window attach; a same-time row on another band and
    a `BEACON` do not; DX Cluster rows likewise;
  - a spot ingested after close is not attached and opens no new activation;
  - the watermark never reprocesses a row, the lag holds back a row ingested within 30 seconds,
    and the cutoff never exceeds the test transaction's `now()`;
  - a capped pass closes nothing and advances the watermark only to the last row read; the next
    pass closes;
  - `states`, `countries` and `farthest` from licenses and cty.dat; a KL7 spotter with an AK
    license counts as a state; self-spots count in `spotCount` but not in `heard`;
  - a hidden activator makes both RPCs null; a hidden spotter is left out and the counts are
    recomputed;
  - WWBOTA bunkers expand to `references` with aligned names; IOTA through DX Cluster; WWBOTA and
    IOTA have `location` null;
  - the shape pins for both payloads; grants (service role only, every function pinned, none in
    `advisor.test.sql`'s client lists); the cron job exists (a `cron.job` check as in
    `aprs.test.sql`).

  Then `supabase test db`, `scripts/smoke-test.sql` and `supabase db reset` with the seed.
- **Deno**: `deno task test`, `deno task coverage`, `deno task check`, `npm run lint`,
  `npm run typecheck`.
- **Web**: `cd web && npm run test:all` (Vitest including `api/` tests, coverage at 80% or more,
  build, oxlint). In a browser against `npm run dev:full`: `/call/KK4PWJ?tab=activations` lists the
  seeded activations grouped by day with chips; a row opens `/activations/<id>`; Copy link toasts
  and the clipboard holds the canonical URL; `/KK4PWJ/activations/<id>` and a wrong call both end
  on the canonical URL; phone width shows stacked rows; dark mode map colours come from the theme.
- **After deploy**: `curl -A Discordbot https://longlines.io/activations/<id>` returns the `og:*`
  tags; `curl -o map.png https://longlines.io/api/activation-image?id=<id>` is a 1200×630 PNG; a
  link pasted into the Discord test channel unfurls with the map; `/health` shows
  `assemble-spotted-activations` succeeding every minute; the first real activations appear about
  45 minutes after the migration is pushed.

## Out of scope

- An in-progress ("on the air now") activation state (assumption 2).
- A backfill of spots from before the migration (decision 6).
- Contacts, QSO counts or whether an activation met a program's minimum.
- One activation across programs, such as a POTA park and its WWFF reference (assumption 3).
- A correction tool, or anything that writes `spotted_activation_redirects`.
- Coordinates or map lines for WWBOTA bunkers and IOTA islands (no coordinates in the catalog).
- Spotted activations in Stats, group statistics, the reference profile, the management API,
  connections or deliveries.
- Link previews for callsign pages (the same rewrite and function pattern can take them later).
- Filters, sorting or date pickers on the tab.

## Copy

From the canvas, word for word, as the plan recorded it; sentence case, no exclamation marks. The
example values (KK4PWJ, references, counts, dates) are the canvas's sample data. Where the desktop
and phone alert differ (desktop "These are estimated ..."), both use the feature brief's wording
below.

- Tabs: Activity · Spotted activations · Spots
- Alert: "Estimated from spots, not logs. Long Lines doesn't see contacts, so it can't tell whether an
  activation met the program's minimum."
- Cards: SPOTTED ACTIVATIONS / "Past 12 months"; REFERENCES / "14 parks · 4 summits"; TIME ON AIR /
  "First spot to last spot, each activation" (phone: "First to last spot"); MOST ACTIVATED / "Eno River
  State Park · 9 times" (phone: "9 times").
- Recent card: "Recent", "Time (UTC)"; columns Reference · Time on air · Bands · modes · Spots ·
  Heard in · View; day heading "Sat 25 Oct 2026 · 3 parks in one day"; chips "Two-fer", "1 spot",
  "Split at 00:00 UTC"; notes "Only spotted once. It may have ended early or just not been
  re-spotted.", "Continued from Mon 13 Oct. POTA counts each UTC day as its own activation.";
  "Show all 27".
- Detail: back link "KK4PWJ spotted activations"; overline "Spotted activation · POTA"; h1 "KK4PWJ at
  US-2730 · US-4560"; "Thu 29 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min"; button "Copy link"; "Where
  KK4PWJ was heard"; "Heard in 14 states, plus Canada and Germany."; "On the air" rows Time on air,
  Bands, Modes (phone: "Bands · modes"), Spots "31 · POTA 8 · RBN 19 · DX cluster 4", Heard in "14
  states · 2 countries", Farthest "Germany · about 7,000 km", Contacts "Not known. Long Lines only
  sees spots."; "Spots over time" / "Time (UTC)"; "Spots" columns Time (UTC) · Source · Heard by ·
  kHz · Mode · Reference, "self-spot"; "Show all 31 spots"; "How this was estimated": "Long Lines
  grouped KK4PWJ's spots at these references with no gap longer than 45 minutes, then added RBN and DX
  cluster spots from the same window. Contacts aren't counted, so this can't confirm the activation met
  POTA's minimum."
- Toasts: "Link copied." / "Couldn't copy the link." Not found: "Spotted activation not found."

### Layout details read from the canvas

Not new copy; how the canvas lays out the lines above, for PR 4.

- The profile header above the tabs is unchanged (`KK4PWJ`, `General · North Carolina, United
  States`, `Last heard 2 days ago`).
- The cards' values: `27`, `18`, `31 h` (time on air in whole hours), and the most activated
  reference (`US-2730`) above its caption.
- Recent, desktop: the "Bands · modes" column holds the bands (`20m · 40m`) over the modes
  (`SSB · CW`); the last column's header is visually hidden, labelled `Open` for screen readers,
  and each row's button reads `View`. A row: references (`US-2730 · US-4560`) with its chips, the
  names under them (`Eno River State Park · Mountains-to-Sea State Trail`; a SOTA row `Mount
  Mitchell · SOTA`), the time window, the duration, bands and modes, spots, heard in. A single
  spot shows one time (`16:20`) and `–` for the duration and heard in. Empty cells are `–`.
- Recent, phone: per row, the references and chips, the names, `18:12–19:40 · 1 h 28 min`, then
  `20m · 40m · SSB · CW · 31 spots · 14 states, 2 countries`. A single spot: `16:20`, then
  `20m · CW · Only spotted once. It may have ended early or just not been re-spotted.` A continued
  split: `40m · SSB · 6 spots · 5 states. Continued from Mon 13 Oct.`
- Detail: the names line under the h1; the Time on air row reads `1 h 28 min · 18:12–19:40 UTC`.
  The timeline's lanes are labelled `POTA`, `RBN`, `DX cluster`.
- Spots, desktop: Heard by is the spotter then `· North Carolina` (its place) or `· self-spot`;
  kHz is grouped (`14,285`); Reference is `–` for RBN and DX cluster rows.
- Spots, phone: `18:12 · POTA · KK4PWJ self-spot` over `14,285 kHz · SSB · US-2730 · US-4560`, or
  `18:15 · POTA · N4KJB` over `North Carolina · 14,285 kHz · SSB · US-2730`.

### Drafts, not on the canvas (Brad to confirm)

- Other programs swap the place word and program: the day note's `parks` becomes `summits`
  (SOTA), `references` (WWFF), `bunkers` (WWBOTA), `islands` (IOTA), and `activations` on a day
  that mixes programs; the overline's `POTA` is `SOTA`, `WWFF`, `WWBOTA`, `IOTA`; the estimate
  note ends `{PROGRAM}'s minimum`; the References card caption lists each program with a count
  (`14 parks · 4 summits · 2 WWFF references · 1 bunker · 1 island`).
- The `Two-fer` chip shows for any activation with more than one reference (three references
  still read `Two-fer`).
- The day note shows only when a day holds more than one activation.
- The map without a location: `Location not known for this reference.`
- The not-found page: a card titled `Spotted activation not found`, with the toast's sentence and
  the reference page's `Callsign lookup` and `Stats` buttons.
- Link previews: `og:title` `KK4PWJ at US-2730 · Spotted activation`; `og:description` the names,
  `Thu 29 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min`, then `Estimated from spots, not logs.`
- The tab's empty state: `Long Lines hasn't spotted an activation by KK4PWJ yet.`

## Progress log

Append one entry per PR: date, PR, what landed, deviations from this spec, notes for the next PR.
Earlier entries are never edited.

- 2026-11-01, PR 1 (#344, branch `spotted-activations-spec`): this spec, planning only; no code, no
  migration. CLAUDE.md gains "Spotted activation rules" and the profile tabs under "Profile
  rules". Deviations from the approved plan: the migration is
  `20261101000100_spotted_activations.sql`, not `20261031000200`, because open PRs #342 and #343
  own `20261031000300` and `20261031000400`; this file is `2026-11-01-spotted-activations-design.md`,
  not the plan's `2026-10-31` name; the preview image is `web/api/activation-image.ts`, as the
  plan's Previews section says (its file list said `.tsx`). Added: detection step 3 drops a late
  spot that would have matched a closed row, so it never opens a one-spot copy (the plan said
  only "never attached"). Open for Brad: the four assumptions
  and every line under "Drafts, not on the canvas". Notes for PR 2: open PRs #340 to #343 also edit
  CLAUDE.md; expect a rebase.
- 2026-11-01, PR 2 (#345, branch `spotted-activations-schema`): the schema and the detection job.
  `20261101000100_spotted_activations.sql` adds the five tables, the `raw_spots (ingested_at, id)`
  index, the knobs, `new_activation_id`, `great_circle_km`, `assemble_spotted_activations`, the
  two read RPCs and the `assemble-spotted-activations` job; `spotted_activations.test.sql` (97
  assertions) covers every case under Verification; the seed gives KK4PWJ a fixed week (a
  two-fer, a rover day ending in a single spot, a midnight split, `/P`) with licensed spotters and
  North Carolina park coordinates, and assembles the seeded week; the smoke test, the OPERATIONS
  cron table and section, an ARCHITECTURE section and the database types. Deviations and
  additions: the cutoff is also never past the pass's own transaction start, and the
  other-transaction bound counts only client backends and stays strictly before the oldest
  `xact_start`; the merge search starts from the rows the pass touched (a scan of every open pair
  was quadratic on the seed: 19 s, 50 s and 130 s for the first three passes, now 3 to 9 s); a
  null reference name is filled from `reference_catalog` at close and by a later spot that names
  it; `countries` leaves out the United States entity; the read RPCs also recompute `spotCount`,
  `sources` and each card's `spotCount`, `states` and `countries` without hidden spotters, and
  `continuedFrom` is null unless that activation is closed; a spot's `place` is its state's name,
  else its entity's name (so an unlicensed US spotter reads "United States"); the DX Cluster
  window starts on the minute as RBN's does; the twelve-month summary counts activations started
  in `(p_now - 12 months, p_now]`, and `recent` is not limited to twelve months; the seed repeats
  the closing pass until nothing is open (a pass closes at most 100). Helpers beside the plan's:
  `activation_merge_references`, `spotted_activation_heard`, `spotted_activation_farthest`,
  `spotted_activation_time`, `spotted_activation_continued_by` and
  `spotted_activation_continued_from`, all pinned and service role only. Notes for PR 3: the
  payload keys are pinned in the pgTAP suite; numbers (`latitude`, `frequencyKhz`) are JSON
  numbers, times are `YYYY-MM-DDTHH:MM:SSZ` and `day` is `YYYY-MM-DD`.
- 2026-11-01, review of PR 2 (#345): two-fers also fold two open rows that share a reference and
  lie within the gap of each other (a spot read out of order bridged two runs, which stayed two
  activations), and a pass whose cutoff another transaction holds back closes only what had gone
  quiet by the held cutoff (closing against `p_now` closed activations whose next spot sat unread,
  then dropped that spot as late); the seed's closing loop stops when a pass closes nothing; two
  pgTAP cases (99 assertions).
- 2026-11-01, PR 3 (#346, branch `spotted-activations-function`): the `spotted-activations` Edge
  Function. `supabase/functions/spotted-activations/` (`index.ts`, the `callsign-profile`
  `deno.json`), the handler `_shared/handlers/spotted_activations.ts` with the exported
  interfaces and loose Zod schemas for both payloads (`spottedActivationSchema`,
  `callsignActivationsSchema`), `verify_jwt = false` in `config.toml`, the function in
  `function_config.test.ts`'s list, handler tests, and the function in ARCHITECTURE and
  OPERATIONS (with the one-time `supabase functions deploy spotted-activations`). The schemas are
  checked against real seed output: `__tests__/fixtures/spotted-activations.json` holds eight
  `spotted_activation` replies (a two-fer with RBN and DX Cluster spots, both halves of a
  midnight split, a single spot, a WWFF activation heard in two countries, a null spotter, a
  three-bunker WWBOTA activation, an IOTA one) and two `callsign_spotted_activations` replies
  (KK4PWJ's and an empty one), captured whole, not trimmed. Decisions the spec left open: a
  request that names both `id` and `callsign`, or neither, is the 404 before any database call;
  the id is taken exactly as sent (no trimming or lower-casing, since every id is lower case);
  a null from `callsign_spotted_activations` (a hidden call, or one with no base) is the same 404
  "Spotted activation not found.", so the web's loader treats both routes alike, while a
  callsign that cannot be one is the profile's 400 "Enter a callsign, like KK4PWJ."; the 500
  says "Spotted activations are unavailable right now." (a draft, not on the canvas); the
  handler takes `now: Date` from the entrypoint for `p_now`. Nullable beyond the spec's shapes,
  because SQL can produce them: `referenceNames` entries, a place's or `farthest`'s `name`, a
  place's coordinates (an entity missing from `cty_entities` after a reimport), and a spot's
  `spotter`, `spotterBase`, `place`, `frequencyKhz` and `mode`. Notes for PR 4: import nothing
  from `_shared`; `web/src/activations/types.ts` mirrors these interfaces, and a 404 from either
  route carries `{error: "Spotted activation not found."}`.
