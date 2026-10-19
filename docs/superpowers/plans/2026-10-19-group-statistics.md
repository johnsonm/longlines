# Group Statistics: Page 10, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 1, 2026-10-19, against main at `29ad1b3` (#223 callsign days and #225 heat map merged).
Brad decided the periods (7 and 30 days) and the link (random code only) the same day.

**Goal:** Build what **Page 10 of Brad's design canvas** draws:

- landing cards with each group's last 30 days
- a group page with a Statistics tab (figures, a year heat map, top lists, members, bands, modes,
  places) and a Settings tab (public page, name, members, used by, delete)
- a confirm dialog for going public
- an unlisted public page at `/g/<code>`, with or without callsigns
- a "This page is private" page

**Architecture:** SQL builds the whole payload from existing stores (`callsign_days`, day-grain
`callsign_activity`, `callsign_seen`, and `spot_stream` for live days and references) and caches it
per (group, period) for an hour, single-flight, like `cached_callsign_profile`. Redaction for a
public page without callsigns is SQL's.

Writes:
- `save_callsign_group` stays the only write path, with two optional keys.

Reads:
- the owner reads through two `authenticated` RPCs
- the public reads through a `verify_jwt = false` Edge Function (`group-page`) that rate-limits
  like the profile and calls a service-role RPC

No cron job, no new roll-up, no API change.

**Tech Stack:** Postgres (plpgsql, pgTAP), Deno Edge Functions, React 19, MUI 9, MUI X Charts and
Data Grid 9, react-router, Vitest + Testing Library.

**Design sources:**
- `docs/superpowers/specs/2026-10-19-group-statistics-design.md`: decisions 1 to 21, Schema, the
  builder and payload, Edge function, Web and **Copy** (page 10 transcribed with the amendments).
  Sessions never read the canvas.
- `docs/superpowers/specs/2026-10-13-callsign-groups-design.md`: groups as they are.
- `docs/superpowers/specs/2026-10-19-callsign-days-design.md`: what `callsign_days` holds and when
  a day is rolled up.

## Where things stand

| Area | State |
| --- | --- |
| Groups | `callsign_groups`, `callsign_group_members` (base calls, 1,000 cap), `save_callsign_group` (`20261013000210`), `delete_callsign_group` (`20261016000500`), `list_callsign_groups` (`20261015001000`, feeds `api_group_json`) |
| Web groups | `web/src/groups/`: `GroupsPage` (cards, `getAlerts`), `GroupDialog` (Type/Paste/Import CSV, member panel), `model.ts`, `parse.ts`, tests |
| Data | `callsign_days` (`20261019000200`, never compacted), `callsign_activity` (day grain 35 days), `callsign_seen`, `spot_stream` (`20261015001000`); live-day pattern in `callsign_profile` (`20261019000300`) |
| Cache pattern | `cached_callsign_profile` (`20261013000310`); rate limit `record_profile_lookup` and `rateLimitKey` (`_shared/handlers/callsign_profile.ts`) |
| Heat map | `web/src/profile/ActivityHeatMap.tsx`, `calendar.ts` (#225). A local `heatmap-levels` worktree has uncommitted changes to `calendar.ts`'s levels |
| Highest migration on main | `20261019000300_callsign_calendar.sql`; this plan's is `20261019000400` |
| Generated types | Never regenerated after #223 and #225; Part 1 regenerates |

## How to run this plan: four parts, four PRs

Each part runs in a fresh Claude Code session in its own worktree. The branches are stacked.

| Part | Tasks | Produces | Branch | PR |
| --- | --- | --- | --- | --- |
| 0 | Task 0 | The spec and this plan | `group-stats-spec` | PR 1 → main |
| 1 | Tasks 1 to 4 | Migration `20261019000400`, pgTAP, smoke lines, generated types | `group-stats-schema` (from `group-stats-spec`) | PR 2 |
| 2 | Tasks 5 to 9 | `api.ts`, landing cards, New group, group page, both tabs, `MemberEditor` | `group-stats-web` (from `group-stats-schema`) | PR 3 |
| 3 | Tasks 10 to 12 | `group-page` function, `/g/:slug`, private page, noindex, docs | `group-stats-public` (from `group-stats-web`) | PR 4 |

### Branches and PRs

- `git fetch origin && git worktree add ../longlines-group-stats-schema -b group-stats-schema
  origin/group-stats-spec` (use `origin/main` once PR 1 is merged). Do the same for the later
  parts. Never switch branches in the main checkout or in a worktree another session holds.
- `git push -u origin <branch>`, then `gh pr create --base <base>`. Say in the PR text that it is
  stacked and on what.
- Before pushing PR 2, check `origin/main` for a migration numbered `20261019000400` or later. If
  there is one, renumber and merge main in.
- PR text says what it does, what is still to come, testing with real numbers, Brad's steps, and
  whether merging applies a migration or needs a function deploy.

## Brad's steps (no part does these)

1. After PR 2 merges: `supabase db push`. The pending pushes of `20261019000200` and
   `20261019000300` go first; they are in the same push.
2. Before PR 4 merges: `supabase functions deploy group-page`.
3. After PR 4 merges and Vercel builds: open a public page signed out, and check `X-Robots-Tag:
   noindex` with `curl -I https://longlines.io/g/<code>`.

## Global Constraints

- Work only in the part's worktree on its branch. Never run `supabase db push`, `functions
  deploy`, `fly deploy`, `fly secrets set`, `supabase secrets set` or `vercel`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Applied migrations are never edited. `save_callsign_group` is recreated from its latest
  definition (`20261013000210`) with `create or replace`, so its grants stay.
  `list_callsign_groups`, `api_group_json` and `patch_callsign_group` do not change. `api_call`
  is recreated from `20261016000600` only to set `longlines.via_api`, under which
  `save_callsign_group` ignores the sharing keys (spec, decision 8).
- Behaviour goes in SQL: every figure, ranking, tie break, top-list length, the 10 places, period
  bounds, hidden calls, redaction, the code, cache freshness. The web formats numbers and ages and
  hides sections whose keys are absent. It never ranks, sums, filters callsigns for privacy or works
  out a base call. Search over the shown members is display filtering only.
- `web/src/lib/api.ts` stays the only supabase-js module. Edge Functions are called with plain
  `fetch` there.
- Copy is word for word from the spec's Copy section. Users see "connection", never "subscription".
- No new runtime dependency.
- Charts and grids are stock MUI X: no Pro components, no custom SVG beyond the heat map grid.
- MUI 9 rules from CLAUDE.md: `sx` for layout only; `Grid size`; `slotProps`; no `fontWeight`
  prop; MUI icons only.
- New SQL objects revoke `anon`/`authenticated` and grant explicitly. Pin `search_path`. Turn RLS
  on for the new table. Update `advisor.test.sql`.
- Gates per part:
  - `deno task fmt`, `deno task lint`, `deno task check`, `deno task coverage`
  - `supabase db reset && supabase test db`
  - `psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke-test.sql`
  - `supabase db lint`
  - `cd web && npm run coverage`, `npm run build`, `npm run lint`
  - `npm run test:all` once before a PR is marked ready

## Review Focus

- **Privacy:**
  - A redacted public payload contains no callsign anywhere. The test walks the jsonb for every
    string matching a member.
  - Hidden calls are absent from every figure and denominator.
  - Unknown and private codes are indistinguishable: same status, body and timing path, and no
    database call for a malformed code.
- **Cache:**
  - A rebuild happens at most once an hour per (group, period), even under concurrent requests.
  - A member change clears it.
  - A group's deletion and an account's deletion remove its rows.
- **Write path:** an API PATCH or a save without the sharing keys leaves `public`,
  `show_callsigns` and `public_slug` alone. The code never changes once set.
- **Agreement:** the card's spots and members heard equal the Statistics tab's 30-day figures.
- **Cost:** every read in the builder filters on member bases and time through existing indexes.
  `explain` the builder for a 1,000-member group on the seed and paste the timing in PR 2.
- **No-store:** the function's 200 is `no-store`, so turning a page off is immediate.

---

## Part 0: Spec and plan (PR 1, branch `group-stats-spec`)

### Task 0: Write the spec and the plan

**Files:** `docs/superpowers/specs/2026-10-19-group-statistics-design.md` (new),
`docs/superpowers/plans/2026-10-19-group-statistics.md` (new).

- [x] Spec in the webhook spec's structure, with page 10's Copy and the amendments marked.
- [x] This plan.
- [ ] Commit `Spec and plan: group statistics (canvas page 10)`, push `group-stats-spec`, open PR 1.

---

## Part 1: Schema (PR 2, branch `group-stats-schema`)

One migration file, `supabase/migrations/20261019000400_group_statistics.sql`, built up over
Tasks 1 to 3, each with its tests. One new suite, `supabase/tests/group_statistics.test.sql`
(include `helpers/users.psql`; use `pg_temp.as_user`; delete from the stores it counts first, so it
passes seeded or not).

### Task 1: Columns, the code and the write path

**Files:** the migration (section 1); `supabase/tests/group_statistics.test.sql` (new);
`supabase/tests/callsign_groups.test.sql`; `supabase/tests/management_api.test.sql`.

- [x] Failing tests first:
  - A new group has `public = false`, `show_callsigns = false` and `public_slug` null.
  - Saving with `public: true` sets a code matching `^[a-z2-7]{10}$`.
  - Renaming, members changes and off-then-on keep the same code.
  - A save without the keys keeps both flags.
  - `public: "yes"` raises "Not a valid setting."
  - An API `update_group` PATCH keeps the flags.
  - 1,000 calls to `new_group_slug()` give 1,000 distinct well-formed codes.
- [x] `alter table callsign_groups add column public …, show_callsigns …, public_slug …` (spec,
  Schema).
- [x] `new_group_slug()`: `gen_random_bytes(10)`, each byte `& 31` into
  `'abcdefghijklmnopqrstuvwxyz234567'` (`new_api_token()`'s masking). The caller loops on
  `unique_violation`.
- [x] `group_stats_cache` (spec, Cache table) is created here, ahead of `save_callsign_group`, so the
  save can clear it. Then `save_callsign_group` from `20261013000210` plus the two keys, the code
  on first public, and the cache delete when the member diff is non-empty.
- [x] `supabase db reset && supabase test db`.
- [x] Commit `Group statistics: public page columns and save keys`.

### Task 2: The builder

**Files:** the migration (section 2); `group_statistics.test.sql`.

- [x] Failing tests first, with a fixed clock. Stub `now()` by passing the day into an internal
  `group_statistics_at(p_group_id, p_period, p_now)` and have `group_statistics` call it with
  `now()`, following `refresh_stats_snapshot_at`. Insert hand-made `callsign_days`,
  `callsign_activity`, `callsign_seen`, `callsign_rollup_days` and `raw_spots` rows for three
  members, one hidden. Assert:
  - `kpis` for 7d and 30d, including `previousSpots`, `membersHeard` and the activations per
    program (POTA, SOTA, WWFF)
  - places split as parks (POTA plus WWFF) and summits
  - a live (unrolled) day counted once
  - `daily` zero filled
  - `calendar` without zero days
  - the six `top` lists at three entries with the callsign tie break
  - `members` including an unheard member last
  - `mainMode` labels
  - `bands` as twelve entries, `modes` in bucket order
  - `places` top 10 with `by`
  - the hidden member nowhere and not in `memberCount`
  - "Not a valid period." for `'90d'`
- [x] `group_statistics_at` and `group_statistics`, stable, definer, `search_path` pinned. Reads
  follow the spec's builder:
  - Members exclude `hidden_callsigns`.
  - `callsign_days` and `callsign_activity` are read by `base = any(v_bases)`.
  - The live rows come from `spot_stream` where `base_callsign = any(v_bases)` and `spot_time`
    is at or after the first unmarked day, materialized once. This is `callsign_profile`'s `live`
    CTE with an array.
  - References come from `spot_stream` for the period with `program is not null`.
  - `mode_bucket` labels are as stored; the web maps `FT8/FT4` to "FT8 and FT4".
- [x] `supabase db reset && supabase test db`; `explain analyze` on a 1,000-member seeded group,
  timing noted for the PR.
- [x] Commit `Group statistics: the payload builder`.

### Task 3: Cache, client RPCs, public RPC, redaction

**Files:** the migration (section 3, grants last); `group_statistics.test.sql`;
`supabase/tests/advisor.test.sql`; `supabase/tests/account_delete.test.sql`.

- [x] Failing tests first:
  - `cached_group_statistics` returns the same `generatedAt` on a second call and a new one after
    the row is aged past an hour.
  - A member change deletes the rows.
  - `get_group_statistics` works for the owner and raises "Group not found." for another user and
    for a missing id.
  - `list_group_summaries` returns only the caller's groups, with `spots` and `members_heard`
    equal to the 30-day payload's, and `daily` of length 30.
  - `public_group_statistics` returns null for an unknown code, a private group and a group made
    private again.
  - With `show_callsigns` off, no string anywhere in the result equals a member's call
    (`jsonb_path_query` over all strings), and with it on, `top` and `members` are present.
  - `group_stats_cache` has RLS on and no client privileges.
  - Deleting the account removes the cache rows.
  - The advisor lists are updated.
- [x] `cached_group_statistics` (one hour, advisory lock keyed on group and
  period, 2 s `lock_timeout`, as `20261013000310`), `group_stats_redact`, `get_group_statistics`,
  `list_group_summaries`, `public_group_statistics`.
- [x] Grants: revoke all from public, anon and authenticated on every new function. Grant execute
  on `get_group_statistics` and `list_group_summaries` to `authenticated`, and on
  `public_group_statistics` to `service_role`.
- [x] `supabase db reset && supabase test db`.
- [x] Commit `Group statistics: cache, owner and public RPCs`.

### Task 4: Smoke test, types and PR 2

**Files:** `scripts/smoke-test.sql`; `web/src/lib/database.types.ts`.

- [x] Smoke lines: the columns exist; `group_stats_cache` has RLS; `public_group_statistics('zzzzzzzzzz', '30d')`
  is null.
- [x] `supabase gen types typescript --local > web/src/lib/database.types.ts`. Run `cd web && npm
  run build` to show the regeneration (which includes #223/#225's objects) breaks nothing.
- [x] All gates.
- [x] Commit `Group statistics: smoke test and generated types`, push, open PR 2 stacked on
  `group-stats-spec`. Run /code-review and fix what it finds.

---

## Part 2: Owner pages (PR 3, branch `group-stats-web`)

Run `supabase db reset` first so the local stack has the migration. Component tests render through
`web/src/test/render.tsx` with `vi.mock("../lib/api")` and explicit factories; `setMobile(true)`
for phones. Fixtures are a `GroupStatistics` object in `web/src/groups/stats/fixtures.ts` shaped
exactly like the pgTAP-pinned payload.

### Task 5: `api.ts`, types and the pure model

**Files:** `web/src/lib/api.ts`, `api.test.tsx`; `web/src/groups/stats/types.ts`,
`stats/model.ts`, `stats/model.test.ts`, `stats/fixtures.ts`; `web/src/groups/types.ts`.

- [x] Tests first:
  - `listGroupSummaries`, `loadGroupStatistics(id, period)` and `saveGroup` with the sharing keys
    call the right RPCs with the right arguments.
  - Model:
    - the comparison line for more, fewer, same and none
    - the activations line with and without WWFF
    - the places line
    - singular and plural
    - the ago text ("2 min ago", "3 hours ago", "9 days ago")
    - the group heat level for 0, 1, 99, 100, 199, 200, 399, 400
    - the period from `?period=`
- [x] Implement. `GroupInput` gains optional `public` and `show_callsigns`.
- [x] `npm run coverage`, `build`, `lint`.
- [x] Commit `Group statistics web: api and model`.

### Task 6: Landing cards and New group

**Files:** `web/src/groups/GroupsPage.tsx` and test; `NewGroupDialog.tsx` and test;
`PublicConfirmDialog.tsx` and test.

- [x] Tests first:
  - Cards show the Copy's meta, the chip, the figures, the sparkline's label and the on-air line
    (none, three, five).
  - Statistics and Settings link to `/groups/:id` and `/groups/:id/settings`.
  - Get alerts keeps today's behaviour; move its existing tests over.
  - The phone sentence and a full-width button.
  - New group creates with the pasted calls (normalized, rejected calls reported as today).
  - Turning the switch on opens the confirm dialog: Keep private turns it off, and Make public
    keeps it on and sets `show_callsigns` from the checkbox.
  - The dialog's first bullet follows the checkbox.
- [x] Implement, with `SparkLineChart` from `@mui/x-charts`. The summaries merge into
  `listGroups` by id.
- [x] Gates.
- [x] Commit `Group statistics web: landing cards and New group`.

### Task 7: Group page and the Statistics tab

**Files:** `web/src/App.tsx` (routes, `Page` union); `web/src/groups/GroupPage.tsx` and test;
`GroupStatistics.tsx` and test; `GroupHeatMap.tsx` and test.

- [x] Tests first:
  - The routes resolve. An unknown id shows "Group not found." as an error.
  - The header has the breadcrumb, chip, meta, Get alerts and tabs. On phones there is no chip and
    no Get alerts.
  - The status line and Period select; changing the select sets `?period=7d` and reloads.
  - The four KPIs with their lines.
  - Heat map: cells, tooltip text, legend (the phone line), and View as table.
  - Six top lists, including "Nobody yet".
  - Members: ten rows, then Show all; search filters; the unheard row; phones drop Main mode.
  - Bands and Modes charts get the payload's series.
  - Places: phones drop By; the empty text.
  - A payload without `top`/`members` (redacted) hides those sections.
- [x] Implement:
  - `GroupStatistics` takes `{ stats, period, onPeriod }` and renders only what it is given.
  - `GroupHeatMap` uses `calendar.ts`'s `heatGrid`/cell helpers with its own level constant.
    Check whether the `heatmap-levels` work has landed on main first, and rebase if it has.
- [x] Gates.
- [x] Commit `Group statistics web: group page and Statistics tab`.

### Task 8: Settings tab and `MemberEditor`

**Files:** `web/src/groups/GroupSettings.tsx` and test; `MemberEditor.tsx` and test (moved from
`GroupDialog.test.tsx`); `GroupDialog.tsx` and its test deleted; `model.ts` as needed.

- [x] Tests first:
  - The public card's states, on and off. On shows the link from `window.location.origin` plus
    `/g/{code}`, Copy link (the clipboard and the toast) and Open page.
  - The callsigns switch.
  - Turning public on opens the confirm dialog.
  - Cancel restores the stored values. Save changes calls `saveGroup` once with name, calls and
    both flags, then toasts "Saved changes".
  - Members:
    - the Type/Paste/Import CSV behaviour moved over from `GroupDialog`'s tests
    - search
    - "+N more"
    - Remove all
    - the 1,000 cap
  - Used by lists the connections whose rules name the group (from `loadSubscriptions`), or the
    empty line.
  - Delete is disabled with the tooltip while used; otherwise it deletes and goes to `/groups`.
- [x] Implement; remove `GroupDialog`.
- [x] Gates.
- [x] Commit `Group statistics web: Settings tab`.

### Task 9: PR 3

- [ ] `npm run test:all`. Compare by hand in `npm run dev:full` with seeded calls at desktop and
  phone width.
- [ ] Push, open PR 3 stacked on `group-stats-schema`. Note that it needs PR 2's migration on
  hosted. Run /code-review and fix what it finds.

---

## Part 3: Public page (PR 4, branch `group-stats-public`)

### Task 10: The `group-page` function

**Files:** `supabase/functions/group-page/index.ts`, `group-page/deno.json`;
`supabase/functions/_shared/handlers/group_page.ts`; `_shared/__tests__/group_page.test.ts`;
`_shared/__tests__/function_config.test.ts`; `supabase/config.toml`.

- [ ] Tests first, with `fake_supabase.ts`:
  - POST gets 405.
  - A malformed code or period gets 404 `{"error":"private"}`, with no rpc call.
  - The rate limit at 31 gets 429 with `Retry-After: 60`.
  - A limiter error gets 500.
  - A null result gets 404.
  - Success gets 200, `Cache-Control: no-store` and the payload.
  - The default period is `30d`.
  - `function_config.test.ts` lists `group-page` as `verify_jwt = false`, and its import walk
    passes.
- [ ] Implement, setting up the HMAC key and client IP header as `callsign-profile/index.ts` does.
- [ ] `deno task fmt`, `lint`, `check`, `coverage`.
- [ ] Commit `Group statistics: public group-page function`.

### Task 11: `/g/:slug`, the private page and noindex

**Files:** `web/src/App.tsx`; `web/src/lib/api.ts` (`loadPublicGroup`), `api.test.tsx`;
`web/src/groups/PublicGroupPage.tsx`, `GroupPrivate.tsx` and tests; `web/vercel.json`.

- [ ] Tests first:
  - Signed out, it renders in `PublicShell`; signed in, in `AppShell`.
  - The header has the Copy's line, Share (`navigator.share` when present, else the clipboard and
    "Link copied"), the statistics and the footer note.
  - The document title is "{name} statistics".
  - A `noindex` robots meta tag is present while mounted and removed on unmount.
  - A 404 shows the private page, with Sign in only when signed out.
  - `?period=7d` passes through.
- [ ] `vercel.json`: `{"source": "/g/(.*)", "headers": [{"key": "X-Robots-Tag", "value":
  "noindex"}]}` beside the existing header rules.
- [ ] Gates.
- [ ] Commit `Group statistics: public and private pages`.

### Task 12: Docs, rules and PR 4

**Files:** `CLAUDE.md`; `docs/ARCHITECTURE.md`; `docs/OPERATIONS.md`; the spec (status).

- [ ] CLAUDE.md gets a "Group statistics rules" section:
  - The payload is pinned by `group_statistics.test.sql`; change the SQL, `stats/types.ts` and
    the test together.
  - Figures and redaction are SQL's.
  - `save_callsign_group` is the only write path, and the sharing keys are optional.
  - The code never changes once set.
  - There is no cron: an hour's cache, single-flight.
  - Hidden calls count nowhere.
  - `group-page` is `verify_jwt = false`, no-store and rate-limited with the profile's limiter.
  - `/g/*` is noindex.
  - The heat map has its own levels.
- [ ] ARCHITECTURE: a "Group statistics" section after "Callsign groups". OPERATIONS: how to turn
  off a public page by hand (`update callsign_groups set public = false where public_slug = …`)
  and how to clear the cache.
- [ ] The spec's status: shipped, with PR numbers.
- [ ] All gates, then `npm run test:all`.
- [ ] Commit `Group statistics: rules and docs`, push, open PR 4 stacked on `group-stats-web`.
  Say that Brad deploys `group-page` before merging. Run /code-review and fix what it finds.

---

## Out of scope

- Periods longer than 30 days.
- Sharing through the management API.
- Notifying members.
- Co-owners.
- A directory of public groups.
- The Templates nav item (page 6).
- Band map and Stats page changes.

## Session prompts

### Part 1 prompt

```
Create the worktree: git fetch origin && git worktree add ../longlines-group-stats-schema -b group-stats-schema origin/group-stats-spec (origin/main if PR 1 is merged). Work only there.

Read docs/superpowers/specs/2026-10-19-group-statistics-design.md in full, and docs/superpowers/plans/2026-10-19-group-statistics.md: "Where things stand", "Global Constraints", "Review Focus", "Brad's steps" and Tasks 1 to 4. Read CLAUDE.md's Callsign group, Callsign rollup, Profile and Conventions rules, and the migrations the plan names (20261013000210, 20261013000310, 20261019000200, 20261019000300). Don't read the canvas.

Do Tasks 1 to 4 in order, tests first, one commit each, ticking the boxes. One migration file, 20261019000400_group_statistics.sql (check origin/main for a newer number before pushing). Run the gates in Global Constraints before the PR. Push with git push -u origin group-stats-schema and open PR 2 stacked on group-stats-spec. Don't merge. Never run supabase db push, functions deploy, fly deploy, fly secrets set or vercel.
```

### Part 2 prompt

```
Create the worktree: git fetch origin && git worktree add ../longlines-group-stats-web -b group-stats-web origin/group-stats-schema (origin/main if PR 2 is merged). Work only there; run supabase db reset first.

Read the spec's Decisions, Web and Copy sections, the plan's "Global Constraints", "Review Focus" and Tasks 5 to 9, and CLAUDE.md's Web app, Callsign group, Subscription and Profile rules. Read web/src/groups/, web/src/profile/ActivityHeatMap.tsx and calendar.ts, web/src/stats/parts.tsx, web/src/lib/api.ts and web/src/test/render.tsx. Don't read the canvas.

Do Tasks 5 to 9 in order, tests first, one commit each, ticking the boxes. Copy word for word from the spec's Copy section. Gates after each task: cd web && npm run coverage, npm run build, npm run lint. Push with git push -u origin group-stats-web and open PR 3 stacked on group-stats-schema. Don't merge.
```

### Part 3 prompt

```
Create the worktree: git fetch origin && git worktree add ../longlines-group-stats-public -b group-stats-public origin/group-stats-web (origin/main if PR 3 is merged). Work only there.

Read the spec's Decisions 9 to 11, Edge function, Web and Copy sections, the plan's "Global Constraints", "Review Focus" and Tasks 10 to 12, and CLAUDE.md's Profile, Band map and Web app rules. Read supabase/functions/_shared/handlers/callsign_profile.ts, supabase/functions/callsign-profile/, _shared/__tests__/function_config.test.ts, web/src/App.tsx, web/src/layout/PublicShell.tsx and web/vercel.json. Don't read the canvas.

Do Tasks 10 to 12 in order, tests first, one commit each, ticking the boxes. Run every gate in Global Constraints before the PR. Push with git push -u origin group-stats-public and open PR 4 stacked on group-stats-web. Don't merge. Never run supabase functions deploy, db push or vercel.
```
