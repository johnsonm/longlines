# Source Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Sources page with a catalog of source tiles and add a detail page per live source (rates, delivered-spot schema, example, about, run by, where it shows up, recent spots).

**Architecture:** Rates come only from the existing stats snapshot (`useStats()`), which gains a `dx` series for DX Cluster in one new migration. Everything else on the pages is static copy in `web/src/sources/sources.ts` plus the existing `list_ingest_health` / `list_recent_spots` RPCs. No new RPCs, grants or Edge Functions.

**Tech Stack:** Postgres (plpgsql, pgTAP), React 19, MUI 9, `@mui/x-charts`, react-router 8, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-14-source-catalog-design.md` (read it before any part; the copy tables there are authoritative).

## How to run this plan: five prompts, three PRs

The work is split into five parts so each runs in a fresh session with a small context. Run them
in order; each ends with a commit. Paste the part's **Prompt** block into a new Claude Code session
opened in `/Users/bradbazemore/Dev/longlines-source-catalog`.

| Part | Tasks | Produces | Branch | PR |
| --- | --- | --- | --- | --- |
| 1 | Task 1 | Migration `20261014000200_stats_dxcluster.sql`, `dx` in `StatsPayload`, pgTAP | `source-catalog` | A: #161 |
| 2 | Tasks 2–3 | `sources.ts` catalog fields, `status.ts`, `rates.ts` (pure, node tests) | `source-catalog-data` | B |
| 3 | Tasks 4–5 | `useVisibleInterval.ts`, `useIngestHealth.ts`, `SourceMark.tsx`, `SourceTile.tsx`, catalog `SourcesPage.tsx` | `source-catalog-pages` | C (draft) |
| 4 | Tasks 6–7 | `RateChart.tsx`, `SourceDetailPage.tsx`, `/sources/:id` route | `source-catalog-pages` | C (draft) |
| 5 | Task 8 | CLAUDE.md rules, full gates | `source-catalog-pages` | C (ready) |

### Branches and PRs

Brad wants several reviewable PRs, not one. Each PR must be safe to merge on its own, so Parts 3–5
share PR C: Part 3 alone would drop the recent-spots table from `/sources` and link tiles to
`/sources/:id`, which only Part 4 adds.

- **Starting a part on a new branch (Parts 2 and 3):** `git fetch origin`. If the previous PR is
  merged into `origin/main`, branch from `origin/main`; otherwise branch from the previous PR's
  branch (stacked). Use `git switch -c <branch> <start>` in this worktree; never `git checkout` an
  existing branch another session may hold.
- **Pushing:** always `git push -u origin <branch>` with the branch named; never a bare `git push`
  (the worktree's first branch once tracked `origin/main`).
- **Opening the PR:** `gh pr create --base <base>`, where `<base>` is `main` or, when stacked, the
  previous PR's branch. The repo deletes branches on merge, so GitHub retargets a stacked PR to
  `main` when its base merges. Part 3 opens PR C as a draft (`--draft`); Parts 4 and 5 push to it;
  Part 5 marks it ready (`gh pr ready`) after every gate passes.
- **PR text** follows the PR A pattern: what the PR does, what's still to come, testing with real
  numbers, and that merging applies any migration to the hosted project.

## Global Constraints

- Work only in the worktree `/Users/bradbazemore/Dev/longlines-source-catalog`, on the part's branch (see "Branches and PRs"). Never `supabase db push`, `functions deploy`, `fly deploy`.
- Another session may share the local Supabase stack: run `supabase db reset` before `supabase test db`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `web/src/lib/api.ts` stays the only module that touches supabase-js; no change to it is needed.
- `sx` is for layout only (spacing, sizing, display, flex/grid, overflow, position). Colours, fonts, borders come from props and variants. MUI 9: `Grid size`, `Stack` alignment via `sx`, no `fontWeight` prop, `slotProps` not `InputProps`.
- The Stats page is unchanged: never poll the snapshot; read it only through `useStats()` from `web/src/stats/useStats.ts`.
- Copy is word for word from the spec's "Copy" section. Say "subscription", never "connection"; never mention the band map.
- Every callsign link rule still holds, but these pages show no callsign links except inside `SpotsTable`, which is reused as is.
- Web tests: component tests render through `web/src/test/render.tsx` (`renderPage`) and mock modules with explicit factories; pure `*.test.ts` stay in node.
- Gates: `cd web && npm run coverage` (80% every metric), `npm run build` (zero TS errors), `npm run lint`.

## Review Focus

1. **A snapshot from before the migration** (no `dx` key on `hourly` entries): DX Cluster must show "–" and "No rates yet…", never `NaN` or 0. Pinned in Task 3 (`sourceRates` returns `null`) and Task 7 (DX page test).
2. **An all-zero week** (a source down for 7 days): average/peak/minimum are 0, the busiest moment is the first hour, no division by zero. Pinned in Task 3.
3. **A deep link to a planned or unknown source** (`/sources/wwff`, `/sources/xyz`): redirect to `/sources`, no crash. Pinned in Task 7.
4. **Search with surrounding spaces or mixed case** (" rbn "): matches. Pinned in Task 5.
5. **Ingest health failing while stats succeed** (and the reverse): the page still renders the other half. Pinned in Task 5 (health fails) and Task 7 (stats fail).

---

# Part 1: DX Cluster in the stats snapshot

**Prompt:**

```
Implement Part 1 (Task 1) of docs/superpowers/plans/2026-10-14-source-catalog.md in this worktree
(/Users/bradbazemore/Dev/longlines-source-catalog, branch source-catalog). Read the plan's header,
Global Constraints and Part 1, and the spec it names. Use superpowers:executing-plans. Follow the
steps exactly, run every command, and stop after the Part 1 commit with a short report.
```

### Task 1: `dx` in `daily` and `hourly`

**Files:**
- Create: `supabase/migrations/20261014000200_stats_dxcluster.sql`
- Modify: `web/src/stats/types.ts:21-22`
- Modify: `web/src/stats/StatsPage.test.tsx:20-22,33-36` (fixture gains `dx`)
- Test: `supabase/tests/stats_snapshot.test.sql`

**Interfaces:**
- Produces: every `payload.daily[]` entry is `{ day, pota, sota, rbn, aprs, dx }` and every `payload.hourly[]` entry `{ hour, pota, sota, rbn, aprs, dx }`; `dx` counts `raw_spots` rows with `source = 'dxcluster'`. TS type `StatsPayload["hourly"][number]["dx"]: number`.

- [ ] **Step 1: Write the failing pgTAP assertions**

In `supabase/tests/stats_snapshot.test.sql`:

1. Add two DX Cluster rows to the first `insert into raw_spots … values` list (after the existing rows, before its terminating `;`; keep the comma style). One in window at day 2, 20:00 UTC (the hour the test already pins at `hourly -> 68`), one outside the window:

```sql
  -- DX Cluster: counted only in daily/hourly dx, never in totals or busiestSlot.
  ('dxcluster', 'dx1', 'dx1', pg_temp.at_utc(2, 20), 'DX1ABC', 'K1DX', 14025, '20m', 'cw', '', null, null, null, null, '{}'),
  ('dxcluster', 'dx2', 'dx2', pg_temp.at_utc(7, 1),  'DX1ABC', 'K1DX', 14025, '20m', 'cw', '', null, null, null, null, '{}'),
```

2. Every existing `jsonb_build_object(... 'aprs', N)` that pins a whole `daily` or `hourly` entry gains `, 'dx', <n>`: lines ~169, 170 and 225 get `'dx', 0`; line ~171 (`daily -> 6`) gets `'dx', 0`; line ~228 (`hourly -> 68`) gets `'dx', 1`. Search the file for `'aprs', ` inside `jsonb_build_object` to find every one, including any in the rolling-hours section at the end.

3. After the `hourly APRS adds up to aprs.packets` assertion, add:

```sql
-- dx: DX Cluster spots per day and hour, and nowhere else.
select is((pg_temp.snap() #>> '{daily,2,dx}')::int, 1, 'daily dx counts in-window DX Cluster spots');
select is((select sum((e ->> 'dx')::int) from jsonb_array_elements(pg_temp.snap() -> 'daily') e), 1::bigint,
          'daily dx leaves out DX Cluster spots outside the window');
select is((select sum((e ->> 'dx')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 1::bigint,
          'hourly dx adds up to the in-window DX Cluster spots');
select ok((select bool_and(e ? 'dx') from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 'every hourly entry has dx');
```

4. Raise `select plan(146);` by 4, to `plan(150)`.

The existing `totals.spots` and `busiestSlot` assertions already pin that the DX rows stay out: if
the DX row leaked into `spots`, `totals.spots` (16) and the busiest slot would change. Leave them as they are.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/bradbazemore/Dev/longlines-source-catalog
supabase start >/dev/null 2>&1 || true
supabase db reset
supabase test db 2>&1 | grep -E "stats_snapshot|not ok|Failed|Result" | head -30
```

Expected: `stats_snapshot.test.sql` fails (the pinned entries have no `dx`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000200_stats_dxcluster.sql`:

1. A header comment:

```sql
-- Stats snapshot: DX Cluster spots per day and hour (daily[].dx, hourly[].dx)
-- for the Sources detail pages' rates. DX Cluster stays out of in_window and
-- spots, so totals, peakHour, busiestSlot, bands, modes and the top lists are
-- unchanged. Otherwise refresh_stats_snapshot_at is 20261014000030's, verbatim.
```

2. Copy lines 173–687 of `supabase/migrations/20261014000030_stats_aprs.sql` verbatim (from `create or replace function public.refresh_stats_snapshot_at(p_now timestamptz)` through its `revoke all … from public, anon, authenticated;`). Check first with `sed -n 165,175p` and `sed -n 680,687p` that the range starts at the function's preceding comment block if one exists and ends at the revoke; include the comment block above `create or replace` if it describes the function.

3. In the copy, add two CTEs. After the `daily_aprs as ( … ),` CTE:

```sql
  daily_dx as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as dx
    from raw_spots
    where source = 'dxcluster'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
```

After the `slot_counts as ( … ),` CTE:

```sql
  slot_dx as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as dx
    from raw_spots r
    where r.source = 'dxcluster'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
```

4. In the `daily` CTE: the `jsonb_build_object(...)` gains `, 'dx', coalesce(x.dx, 0)` after the `'aprs'` pair, and the joins gain `left join daily_dx x using (day)`.

5. In the `hourly` CTE: the `jsonb_build_object(...)` gains `, 'dx', coalesce(sx.dx, 0)` after the `'aprs'` pair, and the joins gain `left join slot_dx sx on sx.slot = s.slot`.

6. If the function's header comment lists where `daily`/`hourly` values come from (around line 169 of the source: `-- - daily[].aprs and hourly[].aprs come from aprs_packet_hours;`), add a line: `-- - daily[].dx and hourly[].dx count raw_spots rows of source 'dxcluster';`.

Do not touch `in_window`, `spots`, `totals` or any other CTE.

- [ ] **Step 4: Run the database checks**

```bash
supabase db reset
supabase test db 2>&1 | tail -5
supabase db lint --level warning
docker exec -i supabase_db_longlines psql -U postgres -v ON_ERROR_STOP=1 < scripts/smoke-test.sql | tail -3
```

Expected: all pgTAP files pass (`Result: PASS`), lint reports no new issues, smoke test ends without error. If `advisor.test.sql` fails, the function lost its pinned `search_path` or its revoke: compare with the source lines.

- [ ] **Step 5: Update the type and the Stats fixture**

`web/src/stats/types.ts` lines 21–22 become:

```ts
  daily: { day: string; pota: number; sota: number; rbn: number; aprs: number; dx: number }[]; // exactly 7, oldest first, zero-filled
  hourly: { hour: string; pota: number; sota: number; rbn: number; aprs: number; dx: number }[]; // exactly 168, oldest first, zero-filled, ending at the last complete hour; hour is ISO UTC
```

Update the header comment's migration name (line 2) to `supabase/migrations/20261014000200_stats_dxcluster.sql`.

In `web/src/stats/StatsPage.test.tsx`, the `daily` fixture entry becomes `day, pota: 1000 + i, sota: 300 + i, rbn: 24000, aprs: 250000, dx: 40,` and the `hourly` entry `pota: 50, sota: 10, rbn: 1000, aprs: 10000, dx: 2,`.

- [ ] **Step 6: Run the web checks**

```bash
cd web && npx tsc -b && npx vitest run src/stats
```

Expected: no type errors; the stats tests pass unchanged otherwise (the Stats page does not read `dx`).

- [ ] **Step 7: Commit**

```bash
cd /Users/bradbazemore/Dev/longlines-source-catalog
git add supabase/migrations/20261014000200_stats_dxcluster.sql supabase/tests/stats_snapshot.test.sql web/src/stats/types.ts web/src/stats/StatsPage.test.tsx
git commit -m "Stats snapshot: DX Cluster spots per day and hour (dx)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Part 2: catalog data, status and rates (pure modules)

**Prompt:**

```
Implement Part 2 (Tasks 2 and 3) of docs/superpowers/plans/2026-10-14-source-catalog.md in this
worktree (/Users/bradbazemore/Dev/longlines-source-catalog). Part 1 is in PR #161. Read the plan's
header (including "Branches and PRs"), Global Constraints and Part 2, and the spec's "SourceInfo
additions", "Copy" and "Data" sections. Start branch source-catalog-data as "Branches and PRs" says.
Use superpowers:executing-plans with TDD. After the Task 3 commit, run cd web && npm run coverage &&
npm run build && npm run lint, push, open PR B, and stop with a short report and the PR URL.
```

### Task 2: `SourceInfo` catalog fields and `status.ts`

**Files:**
- Modify: `web/src/sources/sources.ts`
- Create: `web/src/sources/status.ts`
- Test: `web/src/sources/sources.test.ts`, create `web/src/sources/status.test.ts`

**Interfaces:**
- Produces (in `sources.ts`):

```ts
export type Volume = "standard" | "high";
export type StatsKey = "pota" | "sota" | "rbn" | "dx" | "aprs";
export type MarkColor = "primary" | "secondary" | "warning" | "success" | "default";
export interface SchemaField { name: string; type: string; description: string; derived: boolean }
export interface RunBy { operator: string; feed: string; modes: string }
// SourceInfo keeps id, name, full, status, interval, pollSeconds, desc, alerts and gains:
//   volume: Volume; title: string; tagline: string; mark: string; markColor: MarkColor;
//   statsKey: StatsKey | null; site: string | null; runBy: RunBy | null;
//   about: string[]; showsUp: string[]; schema: SchemaField[] | null;
//   example: Record<string, unknown> | null;
export function findLiveSource(id: string | undefined): SourceInfo | undefined;
```

- Produces (in `status.ts`):

```ts
export type SourceStatus = "connected" | "delayed" | "planned";
export function sourceStatus(source: SourceInfo, health: IngestHealth[] | null): SourceStatus;
export const STATUS_LABEL: Record<SourceStatus, string>; // Connected, Delayed, Not yet available
```

`health === null` means "not loaded or failed": a live source is then `"connected"`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/sources/sources.test.ts` (keep the existing tests; extend the import):

```ts
import { findLiveSource, SOURCES } from "./sources";

describe("SOURCES catalog fields", () => {
  const live = SOURCES.filter((s) => s.status === "live");
  const planned = SOURCES.filter((s) => s.status === "planned");

  it("gives every live source a title, tagline, mark, stats key and run-by rows", () => {
    for (const s of live) {
      expect(s.title, s.id).not.toBe("");
      expect(s.tagline, s.id).toMatch(/\.$/);
      expect(s.mark, s.id).toMatch(/^[A-Z]{2}$/);
      expect(s.statsKey, s.id).not.toBeNull();
      expect(s.runBy, s.id).not.toBeNull();
      expect(s.about.length, s.id).toBeGreaterThan(0);
      expect(s.showsUp.length, s.id).toBeGreaterThan(0);
    }
  });

  it("gives planned sources no stats key", () => {
    expect(planned.map((s) => s.id)).toEqual(["pskreporter", "wwff"]);
    for (const s of planned) expect(s.statsKey).toBeNull();
  });

  it("marks only RBN, APRS-IS and PSK Reporter as high volume", () => {
    expect(SOURCES.filter((s) => s.volume === "high").map((s) => s.id).sort()).toEqual(["aprs", "pskreporter", "rbn"]);
  });

  it("gives every live source but APRS-IS a schema whose fields match its example", () => {
    for (const s of live) {
      if (s.id === "aprs") {
        expect(s.schema).toBeNull();
        expect(s.example).toBeNull();
        continue;
      }
      expect(s.schema, s.id).not.toBeNull();
      expect(s.schema!.map((f) => f.name)).toEqual(Object.keys(s.example!).filter((k) => s.schema!.some((f) => f.name === k)));
      expect(s.example!.source).toBe(s.id);
    }
  });

  it("lists the source's own reference fields after the common ones", () => {
    const names = (id: string) => findLiveSource(id)!.schema!.map((f) => f.name);
    expect(names("pota").slice(-3)).toEqual(["pota_reference", "pota_park_name", "pota_location"]);
    expect(names("sotawatch").at(-1)).toBe("sota_summit_ref");
    expect(names("rbn").at(-1)).toBe("comment");
  });

  it("rewords RBN's spotter and marks DX Cluster's mode as derived", () => {
    const field = (id: string, name: string) => findLiveSource(id)!.schema!.find((f) => f.name === name)!;
    expect(field("rbn", "spotter").description).toBe("Callsign of the skimmer that heard the signal.");
    expect(field("dxcluster", "mode")).toMatchObject({ description: "From the comment, else the band plan.", derived: true });
    expect(field("pota", "mode").derived).toBe(false);
  });

  it("finds live sources only", () => {
    expect(findLiveSource("rbn")?.title).toBe("Reverse Beacon Network");
    expect(findLiveSource("wwff")).toBeUndefined();
    expect(findLiveSource("nope")).toBeUndefined();
    expect(findLiveSource(undefined)).toBeUndefined();
  });
});
```

Create `web/src/sources/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IngestHealth } from "../lib/api";
import { findLiveSource, SOURCES } from "./sources";
import { sourceStatus, STATUS_LABEL } from "./status";

const health = (source: string, age: number | null) => ({ source, seconds_since_last_success: age }) as IngestHealth;
const pota = findLiveSource("pota")!; // pollSeconds 60

describe("sourceStatus", () => {
  it("is connected within three poll intervals", () => {
    expect(sourceStatus(pota, [health("pota", 180)])).toBe("connected");
  });
  it("is delayed past three poll intervals", () => {
    expect(sourceStatus(pota, [health("pota", 181)])).toBe("delayed");
  });
  it("is delayed with no health row or no success yet", () => {
    expect(sourceStatus(pota, [])).toBe("delayed");
    expect(sourceStatus(pota, [health("pota", null)])).toBe("delayed");
  });
  it("falls back to connected when health is unknown", () => {
    expect(sourceStatus(pota, null)).toBe("connected");
  });
  it("is planned for a planned source whatever the health", () => {
    expect(sourceStatus(SOURCES.find((s) => s.id === "wwff")!, [])).toBe("planned");
  });
  it("labels each status", () => {
    expect(STATUS_LABEL).toEqual({ connected: "Connected", delayed: "Delayed", planned: "Not yet available" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/sources/sources.test.ts src/sources/status.test.ts`
Expected: FAIL (`findLiveSource` and `./status` do not exist; TS errors on new fields).

- [ ] **Step 3: Implement `sources.ts`**

Add the exported types above to `web/src/sources/sources.ts`, extend `SourceInfo` with the new fields, and add a schema builder above `SOURCES`:

```ts
const COMMON_FIELDS: SchemaField[] = [
  { name: "id", type: "integer", description: "Unique id Long Lines assigns to the spot.", derived: true },
  { name: "source", type: "string", description: "", derived: false }, // filled per source
  { name: "spot_time", type: "datetime", description: "When the source reported the spot, in UTC.", derived: false },
  { name: "callsign", type: "string", description: "Callsign that was spotted, as spotted.", derived: false },
  { name: "base_callsign", type: "string", description: "The call without prefixes or suffixes; profiles are keyed on it.", derived: true },
  { name: "spotter", type: "string", description: "Callsign of the person who posted the spot.", derived: false },
  { name: "frequency_khz", type: "number", description: "Frequency in kHz.", derived: false },
  { name: "band", type: "string", description: "Amateur band, worked out from the frequency.", derived: true },
  { name: "mode", type: "string", description: "Operating mode as the spotter entered it, lower case.", derived: false },
  { name: "mode_family", type: "string", description: "cw, phone or digital, worked out from the mode.", derived: true },
  { name: "comment", type: "string", description: "Free text from the spotter.", derived: false },
];

/** The delivered spot's fields for one source: the common ones with per-source wording, then its own. */
function deliveredSchema(id: string, overrides: Record<string, Partial<SchemaField>> = {}, own: SchemaField[] = []): SchemaField[] {
  return [
    ...COMMON_FIELDS.map((f) => ({
      ...f,
      ...(f.name === "source" ? { description: `Always "${id}" for this source.` } : {}),
      ...overrides[f.name],
    })),
    ...own,
  ];
}
```

Each example is a full literal with every delivered key in `docs/WEBHOOKS.md` order (`id, source, spot_time, callsign, base_callsign, spotter, frequency_khz, band, mode, mode_family, comment, pota_reference, pota_park_name, pota_location, sota_summit_ref`), so the JSON on the page reads like a real delivery.

Then replace each `SOURCES` entry, keeping the existing fields and adding the new ones. All copy below is verbatim from the spec:

```ts
export const SOURCES: SourceInfo[] = [
  {
    id: "pota", name: "POTA", full: "Parks on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Activator spots from api.pota.app", alerts: true,
    volume: "standard", title: "Parks on the Air", tagline: "Activators in parks, self-spotted and spotted by hunters.",
    mark: "PO", markColor: "primary", statsKey: "pota", site: "pota.app",
    runBy: { operator: "Parks on the Air", feed: "Spot list, polled every 60 seconds", modes: "CW, SSB, digital" },
    about: [
      "Parks on the Air is a program where operators activate parks and other operators hunt them. Activators and hunters post spots to the POTA spotting page as they operate.",
      "Long Lines stores every POTA spot, keeps the park details, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: POTA activity by state, most spotted parks and summits",
      "Subscription filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("pota", {}, [
      { name: "pota_reference", type: "string", description: "Park reference.", derived: false },
      { name: "pota_park_name", type: "string", description: "Park name.", derived: false },
      { name: "pota_location", type: "string", description: "Park locations as POTA lists them, comma separated.", derived: false },
    ]),
    example: {
      id: 58161241, source: "pota", spot_time: "2026-10-14T14:30:05+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "K3XYZ", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "Strong signal",
      pota_reference: "US-2763", pota_park_name: "Falls Lake SRA", pota_location: "US-NC", sota_summit_ref: null,
    },
  },
  {
    id: "sotawatch", name: "SOTAwatch", full: "Summits on the Air", status: "live", interval: "every 30s", pollSeconds: 30, desc: "Summit activation spots from SOTAwatch", alerts: true,
    volume: "standard", title: "SOTA", tagline: "Activators on mountain summits around the world.",
    mark: "SO", markColor: "secondary", statsKey: "sota", site: "sotawatch.sota.org.uk",
    runBy: { operator: "Summits on the Air", feed: "Spot list, polled every 30 seconds", modes: "CW, SSB, FM, digital" },
    about: [
      "Summits on the Air is an award program for portable operation from mountain summits. Activators and chasers post spots to SOTAwatch as they operate.",
      "Long Lines stores every SOTAwatch spot, keeps the summit reference, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: top SOTA associations, most spotted parks and summits",
      "Subscription filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("sotawatch", {}, [
      { name: "sota_summit_ref", type: "string", description: "Summit reference.", derived: false },
    ]),
    example: {
      id: 58161302, source: "sotawatch", spot_time: "2026-10-14T14:31:40+00:00", callsign: "KK4PWJ/P", base_callsign: "KK4PWJ",
      spotter: "KK4PWJ", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "QRV now",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: "W4C/CM-001",
    },
  },
  {
    id: "rbn", name: "RBN", full: "Reverse Beacon Network", status: "live", interval: "streaming", pollSeconds: 60, desc: "CW and digital skimmer spots", alerts: true,
    volume: "high", title: "Reverse Beacon Network", tagline: "CW and RTTY signals heard by skimmers around the world.",
    mark: "RB", markColor: "warning", statsKey: "rbn", site: "reversebeacon.net",
    runBy: { operator: "Reverse Beacon Network volunteers", feed: "Telnet stream of skimmer spots", modes: "CW, RTTY" },
    about: [
      "The Reverse Beacon Network is a network of automated receivers, called skimmers, that listen across the bands and report every CW and RTTY signal they decode, with signal strength and speed.",
      "Long Lines stores every RBN spot. You see them on a callsign profile under \"Heard by\" and in Stats.",
    ],
    showsUp: [
      "Callsign profile: Heard by, last heard, activity",
      "Stats: RBN skimmers, most heard on RBN",
      "Subscription filters: Bands, Modes, Callsigns or Callsign groups (required)",
    ],
    schema: deliveredSchema("rbn", {
      spotter: { description: "Callsign of the skimmer that heard the signal." },
      mode: { description: "CW or RTTY, as the skimmer decoded it." },
      comment: { description: "Signal strength and speed as the skimmer reported them." },
    }),
    example: {
      id: 58161377, source: "rbn", spot_time: "2026-10-14T14:30:12+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "W3LPL", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "18 dB 24 WPM CQ",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: null,
    },
  },
  {
    id: "dxcluster", name: "DX Cluster", full: "DXSpider network", status: "live", interval: "streaming", pollSeconds: 60, desc: "Human-entered DX spots", alerts: true,
    volume: "standard", title: "DX Cluster", tagline: "Spots entered by operators and shared across cluster nodes.",
    mark: "DX", markColor: "success", statsKey: "dx", site: null,
    runBy: { operator: "Volunteer cluster node operators", feed: "Telnet stream from a DXSpider node", modes: "Any, as the spotter enters it" },
    about: [
      "A DX Cluster is a network of nodes where operators post the stations they hear, often rare or distant ones, for everyone connected to see.",
      "Long Lines stores every DX Cluster spot and shows them on profiles. Only subscriptions that pick DX Cluster get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, activity",
      "Subscription filters: pick DX Cluster under Sources, then Bands, Modes, Callsigns, Callsign groups",
      "Not in Stats",
    ],
    schema: deliveredSchema("dxcluster", { mode: { description: "From the comment, else the band plan.", derived: true } }),
    example: {
      id: 58161420, source: "dxcluster", spot_time: "2026-10-14T14:32:00+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "K3XYZ", frequency_khz: 14025.0, band: "20m", mode: "cw", mode_family: "cw", comment: "CQ CQ",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: null,
    },
  },
  {
    id: "aprs", name: "APRS-IS", full: "Automatic Packet Reporting System", status: "live", interval: "streaming", pollSeconds: 60, desc: "Every packet on the worldwide APRS-IS feed", alerts: false,
    volume: "high", title: "APRS-IS", tagline: "Position, weather and message packets from the worldwide APRS-IS network.",
    mark: "AP", markColor: "warning", statsKey: "aprs", site: "aprs2.net",
    runBy: { operator: "APRS-IS tier 2 network volunteers", feed: "Full feed over TCP, receive only", modes: "APRS packets" },
    about: [
      "APRS-IS links the world's APRS radio networks over the internet. Igates forward the packets they hear, from positions and weather reports to messages.",
      "Long Lines stores every packet on the full feed for about two days and archives it after that. Packets are not spots: they never reach profiles or subscriptions, so there is no schema or recent spots list here. You see them in Stats.",
    ],
    showsUp: ["Stats: APRS-IS packets, stations, igates and packet types", "Not on profiles or in subscriptions"],
    schema: null,
    example: null,
  },
  {
    id: "pskreporter", name: "PSK Reporter", full: "PSK Reporter", status: "planned", interval: "streaming", pollSeconds: null, desc: "FT8, FT4 and other digital mode reports", alerts: true,
    volume: "high", title: "PSK Reporter", tagline: "Digital-mode reception reports from monitoring stations.",
    mark: "PS", markColor: "default", statsKey: null, site: null, runBy: null, about: [], showsUp: [], schema: null, example: null,
  },
  {
    id: "wwff", name: "WWFF", full: "World Wide Flora & Fauna", status: "planned", interval: "streaming", pollSeconds: null, desc: "WWFF reference activations", alerts: true,
    volume: "standard", title: "WWFF", tagline: "World Wide Flora and Fauna activations.",
    mark: "WW", markColor: "default", statsKey: null, site: null, runBy: null, about: [], showsUp: [], schema: null, example: null,
  },
];

/** A live source by id, for /sources/:id; planned and unknown ids give undefined. */
export function findLiveSource(id: string | undefined): SourceInfo | undefined {
  return SOURCES.find((s) => s.id === id && s.status === "live");
}
```

The catalog order is the array order: POTA, SOTA, RBN, DX Cluster, APRS-IS, PSK Reporter, WWFF.

- [ ] **Step 4: Implement `status.ts`**

```ts
import type { IngestHealth } from "../lib/api";
import type { SourceInfo } from "./sources";

export type SourceStatus = "connected" | "delayed" | "planned";

export const STATUS_LABEL: Record<SourceStatus, string> = {
  connected: "Connected",
  delayed: "Delayed",
  planned: "Not yet available",
};

/**
 * A live source is delayed when its last success is missing or older than
 * three poll intervals. Unknown health (null: not loaded, or failed) shows
 * a live source as connected rather than alarming on our own error.
 */
export function sourceStatus(source: SourceInfo, health: IngestHealth[] | null): SourceStatus {
  if (source.status !== "live") return "planned";
  if (health === null || source.pollSeconds === null) return "connected";
  const age = health.find((h) => h.source === source.id)?.seconds_since_last_success ?? null;
  return age === null || age > 3 * source.pollSeconds ? "delayed" : "connected";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/sources/sources.test.ts src/sources/status.test.ts && npx tsc -b`
Expected: PASS, no type errors. (The old `SourcesPage.tsx` still compiles: it uses only existing fields.)

- [ ] **Step 6: Commit**

```bash
git add web/src/sources/sources.ts web/src/sources/sources.test.ts web/src/sources/status.ts web/src/sources/status.test.ts
git commit -m "Sources: catalog copy, delivered-spot schemas and status per source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `rates.ts`

**Files:**
- Create: `web/src/sources/rates.ts`
- Test: `web/src/sources/rates.test.ts`

**Interfaces:**
- Consumes: `StatsKey`, `Volume` from `./sources`; `StatsPayload` from `../stats/types`.
- Produces:

```ts
export type Hour = StatsPayload["hourly"][number];
export interface Rates {
  series: number[];   // 168 values, per hour (standard) or per minute (high)
  hours: string[];    // the matching ISO hours
  average: number; peak: number; peakHour: string; minimum: number;
  perDay: number;     // raw count per day (total / 7)
}
export function sourceRates(hourly: readonly Hour[], key: StatsKey, volume: Volume): Rates | null;
export function formatRate(n: number): string;          // "4.8", "36", "1,042"
export function rateUnit(volume: Volume): string;       // "spots/hour" | "spots/min"
export function rateUnitShort(volume: Volume): string;  // "/ hour" | "/ min"
export function formatHour(iso: string): string;        // "Oct 12, 14:00 UTC"
export function formatPerDay(n: number): string;        // "4,600", "1.5 million"
```

- [ ] **Step 1: Write the failing tests**

`web/src/sources/rates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatHour, formatPerDay, formatRate, rateUnit, rateUnitShort, sourceRates, type Hour } from "./rates";

const START = Date.UTC(2026, 9, 7); // Oct 7 00:00 UTC
function week(value: (i: number) => number, key: "pota" | "rbn" | "dx" = "pota"): Hour[] {
  return Array.from({ length: 168 }, (_, i) => ({
    hour: new Date(START + i * 3_600_000).toISOString().replace(".000", ""),
    pota: 0, sota: 0, rbn: 0, aprs: 0, dx: 0, [key]: value(i),
  }));
}

describe("sourceRates", () => {
  it("works per hour for a standard volume source", () => {
    const r = sourceRates(week((i) => (i === 100 ? 88 : i === 5 ? 2 : 36)), "pota", "standard")!;
    expect(r.series).toHaveLength(168);
    expect(r.peak).toBe(88);
    expect(r.peakHour).toBe("2026-10-11T04:00:00Z");
    expect(r.minimum).toBe(2);
    expect(r.average).toBeCloseTo((36 * 166 + 88 + 2) / 168);
    expect(r.perDay).toBeCloseTo((36 * 166 + 88 + 2) / 7);
  });

  it("works per minute for a high volume source", () => {
    const r = sourceRates(week(() => 60_000, "rbn"), "rbn", "high")!;
    expect(r.average).toBe(1000);
    expect(r.peak).toBe(1000);
    expect(r.perDay).toBe(60_000 * 24);
  });

  it("takes the earliest hour when the peak ties", () => {
    const r = sourceRates(week((i) => (i === 30 || i === 90 ? 9 : 1)), "pota", "standard")!;
    expect(r.peakHour).toBe(week(() => 0)[30].hour);
  });

  it("handles an all-zero week", () => {
    const r = sourceRates(week(() => 0), "pota", "standard")!;
    expect(r).toMatchObject({ average: 0, peak: 0, minimum: 0, perDay: 0, peakHour: week(() => 0)[0].hour });
  });

  it("returns null for a snapshot without the source's key", () => {
    const old = week(() => 1).map(({ dx: _dx, ...rest }) => rest) as unknown as Hour[];
    expect(sourceRates(old, "dx", "standard")).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(sourceRates([], "pota", "standard")).toBeNull();
  });
});

describe("formatting", () => {
  it("formatRate uses one decimal below 10 and separators from 10", () => {
    expect(formatRate(0)).toBe("0.0");
    expect(formatRate(4.84)).toBe("4.8");
    expect(formatRate(9.96)).toBe("10");
    expect(formatRate(36.4)).toBe("36");
    expect(formatRate(1042.3)).toBe("1,042");
  });

  it("names the units by volume", () => {
    expect(rateUnit("standard")).toBe("spots/hour");
    expect(rateUnit("high")).toBe("spots/min");
    expect(rateUnitShort("standard")).toBe("/ hour");
    expect(rateUnitShort("high")).toBe("/ min");
  });

  it("formatHour is always UTC", () => {
    expect(formatHour("2026-10-12T14:00:00Z")).toBe("Oct 12, 14:00 UTC");
    expect(formatHour("2026-10-03T01:00:00Z")).toBe("Oct 3, 01:00 UTC");
  });

  it("formatPerDay rounds to two figures below a million and names millions", () => {
    expect(formatPerDay(0)).toBe("0");
    expect(formatPerDay(864)).toBe("860");
    expect(formatPerDay(4567)).toBe("4,600");
    expect(formatPerDay(999_499)).toBe("1,000,000");
    expect(formatPerDay(1_520_000)).toBe("1.5 million");
  });
});
```

Note: `formatRate(9.96)` must be "10", so round first, then pick the format:
`const r = Math.round(n * 10) / 10; return r < 10 ? r.toFixed(1) : Math.round(r).toLocaleString("en-US")`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/sources/rates.test.ts`
Expected: FAIL, `./rates` not found.

- [ ] **Step 3: Implement `rates.ts`**

```ts
// Rates for the Sources pages, from the stats snapshot's 168 hourly buckets
// (see useStats). Pure, so the maths is tested without a page.
import type { StatsPayload } from "../stats/types";
import type { StatsKey, Volume } from "./sources";

export type Hour = StatsPayload["hourly"][number];

export interface Rates {
  series: number[];
  hours: string[];
  average: number;
  peak: number;
  peakHour: string;
  minimum: number;
  perDay: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Null when the snapshot predates the source's key (DX Cluster before
 * 20261014000200) or has no hours, so the page shows "no rates yet" rather than zeros.
 */
export function sourceRates(hourly: readonly Hour[], key: StatsKey, volume: Volume): Rates | null {
  if (hourly.length === 0 || typeof hourly[0][key] !== "number") return null;
  const counts = hourly.map((h) => Number(h[key] ?? 0));
  const divisor = volume === "high" ? 60 : 1;
  const series = counts.map((n) => n / divisor);
  let peakIndex = 0;
  series.forEach((v, i) => {
    if (v > series[peakIndex]) peakIndex = i;
  });
  const total = counts.reduce((sum, n) => sum + n, 0);
  return {
    series,
    hours: hourly.map((h) => h.hour),
    average: series.reduce((sum, v) => sum + v, 0) / series.length,
    peak: series[peakIndex],
    peakHour: hourly[peakIndex].hour,
    minimum: Math.min(...series),
    perDay: total / 7,
  };
}

export function formatRate(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r < 10 ? r.toFixed(1) : Math.round(r).toLocaleString("en-US");
}

export function rateUnit(volume: Volume): string {
  return volume === "high" ? "spots/min" : "spots/hour";
}

export function rateUnitShort(volume: Volume): string {
  return volume === "high" ? "/ min" : "/ hour";
}

/** "Oct 12, 14:00 UTC": snapshot buckets are UTC hours, so the label is always UTC. */
export function formatHour(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
}

/** Two significant figures below a million ("4,600"), then "1.5 million". */
export function formatPerDay(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} million`;
  return Number(n.toPrecision(2)).toLocaleString("en-US");
}
```

(`(0).toPrecision(2)` is "0.0", so 0 gives "0"; 999,499 rounds to 1.0e+6 and gives "1,000,000".)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/sources/rates.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/rates.ts web/src/sources/rates.test.ts
git commit -m "Sources: per-source rates from the stats snapshot's hourly series

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Part 3: the catalog page

**Prompt:**

```
Implement Part 3 (Tasks 4 and 5) of docs/superpowers/plans/2026-10-14-source-catalog.md in this
worktree (/Users/bradbazemore/Dev/longlines-source-catalog). Part 2 is in PR B. Read the plan's
header (including "Branches and PRs"), Global Constraints and Part 3, the spec's "Components" and
"Copy > Catalog" sections, and web/src/sources/sources.ts, status.ts and rates.ts for the interfaces.
Start branch source-catalog-pages as "Branches and PRs" says. Use superpowers:executing-plans with
TDD. After the Task 5 commit, push and open PR C as a draft (the pages, Parts 3-5), and stop with a
short report and the PR URL.
```

### Task 4: polling hooks, `SourceMark` and `SourceTile`

**Files:**
- Create: `web/src/sources/useVisibleInterval.ts`, `web/src/sources/useIngestHealth.ts`, `web/src/sources/SourceMark.tsx`, `web/src/sources/SourceTile.tsx`
- Test: `web/src/sources/SourceTile.test.tsx`, `web/src/sources/useIngestHealth.test.tsx`

**Interfaces:**
- Consumes: `SourceInfo` (`./sources`), `SourceStatus`, `STATUS_LABEL` (`./status`), `Rates`, `formatRate`, `rateUnit` (`./rates`), `loadIngestHealth`, `IngestHealth` (`../lib/api`), `errorText` (`../app/hooks`).
- Produces:

```ts
// useVisibleInterval.ts
export function useVisibleInterval(callback: () => void, ms: number | null): void;
// Runs callback every ms while document.visibilityState === "visible", and on becoming visible; ms null = never.
// Does NOT run it on mount (callers load once themselves).

// useIngestHealth.ts
export function useIngestHealth(pollMs: number | null): { health: IngestHealth[] | null; error: string | null };
// health null until loaded and after a failure; error "Couldn't load sources." text via errorText.

// SourceMark.tsx
export function SourceMark({ source, size }: { source: SourceInfo; size?: "medium" | "large" }): JSX.Element;
// A filled Chip, label = source.mark, color = source.markColor (MUI Avatar has no colour prop and
// sx colours are not allowed, so a Chip carries the colour). aria-hidden: the title names the source.

// SourceTile.tsx
export function SourceTile({ source, status, rates }: { source: SourceInfo; status: SourceStatus; rates: Rates | null }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

`web/src/sources/SourceTile.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { findLiveSource, SOURCES } from "./sources";
import { SourceTile } from "./SourceTile";
import type { Rates } from "./rates";

const rates = (average: number): Rates => ({ series: [], hours: [], average, peak: 0, peakHour: "", minimum: 0, perDay: 0 });

describe("SourceTile", () => {
  it("links a live source to its page with status, volume and rate", () => {
    renderPage(<SourceTile source={findLiveSource("rbn")!} status="connected" rates={rates(1042.3)} />);
    expect(screen.getByRole("link", { name: /Reverse Beacon Network/ })).toHaveAttribute("href", "/sources/rbn");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("High volume")).toBeInTheDocument();
    expect(screen.getByText("1,042 spots/min")).toBeInTheDocument();
    expect(screen.getByText("CW and RTTY signals heard by skimmers around the world.")).toBeInTheDocument();
  });

  it("shows a delayed standard source per hour", () => {
    renderPage(<SourceTile source={findLiveSource("pota")!} status="delayed" rates={rates(36)} />);
    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getByText("Standard volume")).toBeInTheDocument();
    expect(screen.getByText("36 spots/hour")).toBeInTheDocument();
  });

  it("hides the rate when there are no rates", () => {
    renderPage(<SourceTile source={findLiveSource("dxcluster")!} status="connected" rates={null} />);
    expect(screen.queryByText(/spots\//)).not.toBeInTheDocument();
  });

  it("does not link a planned source", () => {
    renderPage(<SourceTile source={SOURCES.find((s) => s.id === "wwff")!} status="planned" rates={null} />);
    expect(screen.getByText("WWFF")).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
```

`web/src/sources/useIngestHealth.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useIngestHealth } from "./useIngestHealth";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn() }));

const rows = [{ source: "pota", seconds_since_last_success: 5 }] as IngestHealth[];

beforeEach(() => {
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue(rows);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useIngestHealth", () => {
  it("loads once without polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useIngestHealth(null));
    await waitFor(() => expect(result.current.health).toEqual(rows));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(1);
  });

  it("polls while mounted and stops on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderHook(() => useIngestHealth(30_000));
    await waitFor(() => expect(loadIngestHealth).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(2);
  });

  it("reports a failure and leaves health unknown", async () => {
    vi.mocked(loadIngestHealth).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useIngestHealth(null));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.health).toBeNull();
  });
});
```

Check how `errorText` (in `web/src/app/hooks.ts`) renders an `Error`: if it returns the fallback for a plain `Error`, change the expectation to `"Couldn't load sources."`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/sources/SourceTile.test.tsx src/sources/useIngestHealth.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the hooks**

`web/src/sources/useVisibleInterval.ts`:

```ts
import { useEffect, useRef } from "react";

/** Calls `callback` every `ms` while the browser tab is visible, and when it becomes visible again. */
export function useVisibleInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (ms === null) return;
    const tick = () => {
      if (document.visibilityState === "visible") saved.current();
    };
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}
```

`web/src/sources/useIngestHealth.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../app/hooks";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useVisibleInterval } from "./useVisibleInterval";

/** Ingest health, loaded on mount and, with pollMs, refreshed while the tab is visible. */
export function useIngestHealth(pollMs: number | null): { health: IngestHealth[] | null; error: string | null } {
  const [health, setHealth] = useState<IngestHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await loadIngestHealth();
      if (!mounted.current) return;
      setHealth(rows);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(errorText(err, "Couldn't load sources."));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useVisibleInterval(() => void refresh(), pollMs);
  return { health, error };
}
```

- [ ] **Step 4: Implement `SourceMark` and `SourceTile`**

`web/src/sources/SourceMark.tsx`:

```tsx
import { Chip } from "@mui/material";
import type { SourceInfo } from "./sources";

/** The two-letter source mark. A Chip carries the colour: Avatar has no colour prop and sx colours are off limits. */
export function SourceMark({ source, size = "medium" }: { source: SourceInfo; size?: "medium" | "large" }) {
  return (
    <Chip
      aria-hidden
      label={source.mark}
      color={source.markColor}
      variant={source.status === "live" ? "filled" : "outlined"}
      sx={size === "large" ? { height: 56, minWidth: 56, "& .MuiChip-label": { px: 2 } } : undefined}
    />
  );
}
```

`web/src/sources/SourceTile.tsx`:

```tsx
import { Card, CardActionArea, CardContent, Chip, Stack, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Link } from "react-router";
import type { SourceInfo } from "./sources";
import { STATUS_LABEL, type SourceStatus } from "./status";
import { formatRate, rateUnit, type Rates } from "./rates";
import { SourceMark } from "./SourceMark";

const STATUS_COLOR = { connected: "success", delayed: "warning", planned: "default" } as const;

export function SourceTile({ source, status, rates }: { source: SourceInfo; status: SourceStatus; rates: Rates | null }) {
  const live = source.status === "live";
  const body = (
    <CardContent>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <SourceMark source={source} />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexGrow: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Chip size="small" color={STATUS_COLOR[status]} variant={status === "planned" ? "outlined" : "filled"} label={STATUS_LABEL[status]} />
          </Stack>
        </Stack>
        <div>
          <Typography variant="h6" component="h2" color={live ? "text.primary" : "text.secondary"}>{source.title}</Typography>
          <Typography variant="body2" color="text.secondary">{source.tagline}</Typography>
        </div>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Chip size="small" variant="outlined" color={source.volume === "high" ? "warning" : "default"}
            label={source.volume === "high" ? "High volume" : "Standard volume"} />
          {rates && <Typography variant="body2" color="text.secondary">{formatRate(rates.average)} {rateUnit(source.volume)}</Typography>}
          {live && <ChevronRightIcon color="action" sx={{ ml: "auto" }} aria-hidden />}
        </Stack>
      </Stack>
    </CardContent>
  );
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      {live
        ? <CardActionArea component={Link} to={`/sources/${source.id}`} sx={{ height: "100%" }}>{body}</CardActionArea>
        : body}
    </Card>
  );
}
```

The volume chip appears once (bottom row), not twice as in the mock's top-right, which repeats it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/sources/SourceTile.test.tsx src/sources/useIngestHealth.test.tsx && npx tsc -b && npm run lint`
Expected: PASS. If the link's accessible name test fails because the whole card text is the name, keep `getByRole("link", { name: /Reverse Beacon Network/ })` (regex already allows that).

- [ ] **Step 6: Commit**

```bash
git add web/src/sources/useVisibleInterval.ts web/src/sources/useIngestHealth.ts web/src/sources/useIngestHealth.test.tsx web/src/sources/SourceMark.tsx web/src/sources/SourceTile.tsx web/src/sources/SourceTile.test.tsx
git commit -m "Sources: source tiles and ingest-health polling hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: the catalog `SourcesPage`

**Files:**
- Modify (rewrite): `web/src/sources/SourcesPage.tsx`
- Test (rewrite): `web/src/sources/SourcesPage.test.tsx`

**Interfaces:**
- Consumes: `SOURCES` (`./sources`), `sourceStatus` (`./status`), `sourceRates` (`./rates`), `useIngestHealth` (`./useIngestHealth`), `useStats` (`../stats/useStats`), `SourceTile`, `PageTitle` (`../layout/PageTitle`).
- Produces: `export function SourcesPage(): JSX.Element` with **no props** (recent spots moved to the detail page, so `prefs` is no longer needed). `App.tsx` line 153 changes to `<SourcesPage />`; the `App.test.tsx` mock of `./sources/SourcesPage` keeps working (it ignores props) but its rendered text includes `prefs.timezone`: change that mock to render `<p>sources page</p>` and its assertions `"sources page Asia/Tokyo"` to `"sources page"`. If any of those App tests exist specifically to prove prefs reach a page, point them at another page that still takes `prefs` (`/call/K1ABC` or `/subscriptions`), keeping the assertion's intent.

- [ ] **Step 1: Write the failing test**

Replace `web/src/sources/SourcesPage.test.tsx` entirely:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useStats } from "../stats/useStats";
import type { LatestStats } from "../stats/types";
import { SourcesPage } from "./SourcesPage";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn() }));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

const health = (source: string, age: number | null) => ({ source, seconds_since_last_success: age }) as IngestHealth;
const hourly = Array.from({ length: 168 }, (_, i) => ({
  hour: new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""),
  pota: 36, sota: 5, rbn: 62_520, aprs: 330_000, dx: 56,
}));
const STATS = { payload: { hourly }, generatedAt: "2026-10-14T15:00:00Z" } as unknown as LatestStats;

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([
    health("pota", 20), health("sotawatch", 600), health("rbn", 30), health("dxcluster", 40), health("aprs", 50),
  ]);
  vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
});

const tiles = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("SourcesPage", () => {
  it("shows the catalog copy and every source in order", async () => {
    renderPage(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("Where spots come from. Pick a source to see what it sends and what you can do with it.")).toBeInTheDocument();
    expect(screen.getByText("High volume sources require a callsign filter")).toBeInTheDocument();
    expect(screen.getByText(/A subscription to one must include a callsign rule/)).toBeInTheDocument();
    expect(tiles()).toEqual(["Parks on the Air", "SOTA", "Reverse Beacon Network", "DX Cluster", "APRS-IS", "PSK Reporter", "WWFF"]);
    expect(await screen.findByText("Delayed")).toBeInTheDocument(); // SOTA: 600 s > 3 × 30 s
  });

  it("shows each live source's average rate from the snapshot", () => {
    renderPage(<SourcesPage />);
    expect(screen.getByText("36 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("1,042 spots/min")).toBeInTheDocument();
    expect(screen.getByText("5,500 spots/min")).toBeInTheDocument();
    expect(screen.getByText("56 spots/hour")).toBeInTheDocument();
  });

  it("links live tiles to their pages and leaves planned ones unlinked", () => {
    renderPage(<SourcesPage />);
    expect(screen.getByRole("link", { name: /Parks on the Air/ })).toHaveAttribute("href", "/sources/pota");
    expect(screen.getByRole("link", { name: /APRS-IS/ })).toHaveAttribute("href", "/sources/aprs");
    expect(screen.queryByRole("link", { name: /WWFF/ })).not.toBeInTheDocument();
  });

  it("filters by search, trimming and ignoring case", async () => {
    const { user } = renderPage(<SourcesPage />);
    await user.type(screen.getByLabelText("Search sources"), "  rbn ");
    expect(tiles()).toEqual(["Reverse Beacon Network"]);
    await user.clear(screen.getByLabelText("Search sources"));
    await user.type(screen.getByLabelText("Search sources"), "summits");
    expect(tiles()).toEqual(["SOTA"]);
  });

  it("filters by chip and says when nothing matches", async () => {
    const { user } = renderPage(<SourcesPage />);
    await user.click(screen.getByRole("button", { name: "Not yet available" }));
    expect(tiles()).toEqual(["PSK Reporter", "WWFF"]);
    await user.click(screen.getByRole("button", { name: "Connected" }));
    expect(tiles()).toHaveLength(5);
    await user.type(screen.getByLabelText("Search sources"), "zzz");
    expect(screen.getByText("No sources match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.clear(screen.getByLabelText("Search sources"));
    expect(tiles()).toHaveLength(7);
  });

  it("still shows the catalog when ingest health fails", async () => {
    vi.mocked(loadIngestHealth).mockRejectedValue(new Error("Couldn't load source health."));
    renderPage(<SourcesPage />);
    expect(await screen.findByText("Couldn't load source health.")).toBeInTheDocument();
    expect(screen.queryByText("Delayed")).not.toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(5);
  });

  it("hides rates while there is no snapshot", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    renderPage(<SourcesPage />);
    expect(screen.queryByText(/spots\//)).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(7);
  });

  it("stacks tiles on a phone", () => {
    setMobile(true);
    renderPage(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    expect(within(screen.getByTestId("source-grid")).getAllByRole("heading", { level: 2 })).toHaveLength(7);
  });
});
```

Notes for the implementer:
- "Connected" appears both as a filter chip and on tiles, so the chip queries use `getByRole("button", …)`; make the filter chips clickable `Chip`s (`onClick`), which MUI renders with role `button`. If a tile status chip also gets role `button`, it won't: it has no `onClick`.
- `setMobile(value: boolean)` comes from `web/src/test/media.ts`; `errorText` returns the `Error`'s message, so the failure test sees the mocked message.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/sources/SourcesPage.test.tsx`
Expected: FAIL (old page renders tabs, takes `prefs`, no search field).

- [ ] **Step 3: Implement the catalog**

Replace `web/src/sources/SourcesPage.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Alert, AlertTitle, Box, Chip, Grid, Stack, TextField, Typography } from "@mui/material";
import { PageTitle } from "../layout/PageTitle";
import { useStats } from "../stats/useStats";
import { SOURCES, type SourceInfo } from "./sources";
import { sourceStatus } from "./status";
import { sourceRates } from "./rates";
import { SourceTile } from "./SourceTile";
import { useIngestHealth } from "./useIngestHealth";

type Filter = "all" | "connected" | "planned";
const FILTERS: [Filter, string][] = [["all", "All"], ["connected", "Connected"], ["planned", "Not yet available"]];

function matches(s: SourceInfo, query: string, filter: Filter): boolean {
  if (filter === "connected" && s.status !== "live") return false;
  if (filter === "planned" && s.status !== "planned") return false;
  const q = query.trim().toLowerCase();
  return q === "" || [s.title, s.name, s.full, s.tagline].some((t) => t.toLowerCase().includes(q));
}

export function SourcesPage() {
  const { health, error } = useIngestHealth(null);
  const { stats } = useStats();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => SOURCES.filter((s) => matches(s, query, filter)), [query, filter]);
  const hourly = stats?.payload.hourly ?? [];

  return (
    <Stack spacing={3}>
      <Box>
        <PageTitle>Sources</PageTitle>
        <Typography color="text.secondary">Where spots come from. Pick a source to see what it sends and what you can do with it.</Typography>
      </Box>
      <Alert severity="warning">
        <AlertTitle>High volume sources require a callsign filter</AlertTitle>
        They send thousands of spots an hour. A subscription to one must include a callsign rule, so it only passes spots for the stations you name.
      </Alert>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} useFlexGap sx={{ alignItems: { sm: "center" }, flexWrap: "wrap" }}>
        <TextField size="small" label="Search sources" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ minWidth: 220, maxWidth: 420, flexGrow: 1 }} />
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {FILTERS.map(([value, label]) => (
            <Chip key={value} label={label} onClick={() => setFilter(value)}
              color={filter === value ? "primary" : "default"} variant={filter === value ? "filled" : "outlined"} />
          ))}
        </Stack>
      </Stack>
      {shown.length === 0
        ? <Typography color="text.secondary">No sources match.</Typography>
        : (
          <Grid container spacing={2} data-testid="source-grid">
            {shown.map((s) => (
              <Grid key={s.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <SourceTile source={s} status={sourceStatus(s, health)}
                  rates={s.statsKey ? sourceRates(hourly, s.statsKey, s.volume) : null} />
              </Grid>
            ))}
          </Grid>
        )}
    </Stack>
  );
}
```

Selected filter chips use `aria-pressed`? MUI Chip doesn't set it; add `aria-pressed={filter === value}` to each filter chip for screen readers.

Then in `web/src/App.tsx` change `{page === "sources" && <SourcesPage prefs={prefs} />}` to `{page === "sources" && <SourcesPage />}` and update `App.test.tsx` as described under Interfaces.

`SpotsTable.tsx` and `spots.ts` stay; the detail page reuses them in Part 4. Until then `SpotsTable` is not imported by any page: if `npm run coverage` complains about an unloaded module, that is fixed in Part 4. Do not delete it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd web && npx vitest run src/sources src/App.test.tsx && npx tsc -b && npm run lint
```

Expected: PASS, zero type and lint errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/SourcesPage.tsx web/src/sources/SourcesPage.test.tsx web/src/App.tsx web/src/App.test.tsx
git commit -m "Sources: catalog of source tiles with search and filters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Part 4: the detail page

**Prompt:**

```
Implement Part 4 (Tasks 6 and 7) of docs/superpowers/plans/2026-10-14-source-catalog.md in this
worktree (/Users/bradbazemore/Dev/longlines-source-catalog, branch source-catalog-pages). Part 3 is
in draft PR C. Read the plan's header (including "Branches and PRs"), Global Constraints and
Part 4, the spec's "Components",
"Data > Rates/States" and "Copy" sections (volume alerts, cards), and web/src/sources/*.ts(x) for
the interfaces. Use superpowers:executing-plans with TDD. After the Task 7 commit, push to PR C and
stop with a short report.
```

### Task 6: `RateChart`

**Files:**
- Create: `web/src/sources/RateChart.tsx`
- Test: covered through `SourceDetailPage.test.tsx` (Task 7); this task adds a focused `web/src/sources/RateChart.test.tsx`.

**Interfaces:**
- Consumes: `Rates`, `formatRate`, `rateUnitShort`, `formatHour` (`./rates`), `Volume`, `MarkColor` (`./sources`).
- Produces: `export function RateChart({ rates, volume, color }: { rates: Rates; volume: Volume; color: MarkColor }): JSX.Element` — renders a caption "Peak 11.8 / min, Oct 12, 14:00 UTC" above a `LineChart` (area series of `rates.series`, plus a second series that is `null` except at the peak index, coloured `theme.palette.error.main`, with its mark shown).

- [ ] **Step 1: Write the failing test**

`web/src/sources/RateChart.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { RateChart } from "./RateChart";
import type { Rates } from "./rates";

const hours = Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""));
const rates: Rates = { series: hours.map((_, i) => (i === 125 ? 11.8 : 3)), hours, average: 3.1, peak: 11.8, peakHour: hours[125], minimum: 3, perDay: 4600 };

describe("RateChart", () => {
  it("labels the peak with its value and hour", () => {
    renderPage(<RateChart rates={rates} volume="high" color="warning" />);
    expect(screen.getByText("Peak 11.8 / min, Oct 12, 05:00 UTC")).toBeInTheDocument();
  });

  it("uses per-hour units for a standard source", () => {
    renderPage(<RateChart rates={{ ...rates, peak: 88 }} volume="standard" color="primary" />);
    expect(screen.getByText(/^Peak 88 \/ hour,/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/sources/RateChart.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```tsx
import { Stack, Typography, useTheme } from "@mui/material";
import { LineChart } from "@mui/x-charts";
import type { MarkColor, Volume } from "./sources";
import { formatHour, formatRate, rateUnitShort, type Rates } from "./rates";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Seven days of hourly rates; the busiest hour is marked in the error colour. */
export function RateChart({ rates, volume, color }: { rates: Rates; volume: Volume; color: MarkColor }) {
  const theme = useTheme();
  const hours = rates.hours.map((h) => new Date(h));
  const midnights = hours.filter((d) => d.getUTCHours() === 0);
  const peakIndex = rates.hours.indexOf(rates.peakHour);
  const unit = rateUnitShort(volume);
  const line = color === "default" ? theme.palette.grey[500] : theme.palette[color].main;
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">
        Peak {formatRate(rates.peak)} {unit}, {formatHour(rates.peakHour)}
      </Typography>
      <LineChart
        height={220}
        hideLegend
        skipAnimation
        xAxis={[{
          scaleType: "time",
          data: hours,
          tickInterval: midnights,
          valueFormatter: (d: Date, ctx) => (ctx.location === "tick" ? DAY_LABEL.format(d) : formatHour(d.toISOString())),
        }]}
        yAxis={[{ min: 0, width: 48 }]}
        series={[
          { label: "Rate", data: rates.series, area: true, showMark: false, color: line, valueFormatter: (v) => (v === null ? "" : `${formatRate(v)} ${unit}`) },
          { label: "Peak", data: rates.series.map((v, i) => (i === peakIndex ? v : null)), showMark: true, color: theme.palette.error.main, connectNulls: false },
        ]}
      />
    </Stack>
  );
}
```

If `@mui/x-charts` 9 types reject `valueFormatter`'s `(v) =>` signature or `connectNulls`, match the signatures used in `web/src/stats/StatsPage.tsx` (lines ~180-212) and drop `connectNulls` (null points are already gaps).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run src/sources/RateChart.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/RateChart.tsx web/src/sources/RateChart.test.tsx
git commit -m "Sources: seven-day rate chart with the busiest hour marked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: `SourceDetailPage` and the `/sources/:id` route

**Files:**
- Create: `web/src/sources/SourceDetailPage.tsx`, `web/src/sources/RecentSpotsCard.tsx`
- Modify: `web/src/App.tsx` (route + `Page` type + render), `web/src/App.test.tsx`
- Test: `web/src/sources/SourceDetailPage.test.tsx`

**Interfaces:**
- Consumes: everything from Parts 2–3, `RateChart`, `SpotsTable` (`./SpotsTable`, props `{ spots, dense, prefs }`), `loadRecentSpots`, `RecentSpot` (`../lib/api`), `relativeAge`, `TimePrefs` (`../lib/time`), `useParams`, `Navigate`, `Link` (`react-router`).
- Produces: `export function SourceDetailPage({ prefs }: { prefs: TimePrefs }): JSX.Element`; route `/sources/:id` rendered by `RequireAuth page="source"`.

Layout and copy (from the spec):
1. `Breadcrumbs`: `<Link component={RouterLink} to="/sources">Sources</Link>` › `<Typography color="text.primary">{title}</Typography>`.
2. Header row: `<SourceMark size="large">`, `PageTitle` with the title, status chip, volume chip, tagline; "Visit {site}" outlined `Button` with `OpenInNewIcon`, `href={\`https://${site}\`}`, `target="_blank"`, `rel="noopener"` when `site` is set.
3. Volume alert (`severity="warning"`, `AlertTitle`):
   - RBN: title "High volume source: a callsign filter is required"; body "Reverse Beacon Network sends about {formatPerDay(perDay)} spots a day. A subscription only gets its spots if it names callsigns, typed or through a group. One that lists only RBN can't be saved without them." — the first sentence is left out when rates are `null`.
   - APRS-IS: title "High volume source: stored only"; body "APRS-IS sends about {formatPerDay(perDay)} packets a day. Long Lines stores and archives them but does not match them, so they can't be used in subscriptions." — first sentence left out when rates are `null`.
4. Figure cards (`Grid size={{ xs: 6, md: 3 }}`, `Card variant="outlined"`, `Typography variant="overline" color="text.secondary"` label, `variant="h5"` value): "Average, 7 days" → `{formatRate(average)} {rateUnitShort}`, "Peak, 7 days", "Minimum, 7 days", "Busiest moment" → `formatHour(peakHour)`. With null rates every value is "–". While `useStats().loading`, each value is a `Skeleton`.
5. Left column (`size={{ xs: 12, md: 8 }}`):
   - Card "Rate over time" / subheader "Last 7 days. The red dot marks the busiest moment, so you can size downstream systems for it": `RateChart`, or with null rates `Typography color="text.secondary"` "No rates yet. They appear after the next hourly stats refresh.", or with `useStats().error` an `Alert severity="error"` "Couldn't load rates.".
   - Card "Schema" / "Every field on a {title} spot, as a webhook receives it.": `Table size="small"` with head Field / Type / Description, field name in `Typography component="code" variant="body2" fontFamily="monospace"`, plus `<Chip size="small" variant="outlined" label="Derived" />` when derived; under the table `Typography variant="body2" color="text.secondary"` "Fields for other programs are present and null." (on every schema: every source has null fields of other programs).
   - Card "Example spot" / "How a webhook receives a spot": `<Box component="pre" sx={{ overflow: "auto", m: 0 }}><Typography component="code" variant="body2" fontFamily="monospace">{JSON.stringify(example, null, 2)}</Typography></Box>`.
   - `RecentSpotsCard` (not for APRS-IS).
6. Right column (`size={{ xs: 12, md: 4 }}`): Cards "About this source" (one `Typography variant="body2"` per paragraph), "Run by" (`Table size="small"`: Operator / Website / Feed / Modes; Website row only when `site`), "Where it shows up" (one `Typography variant="body2"` per line).
7. APRS-IS: no Schema, Example spot or Recent spots cards.

Every card is `ChartCard` from `web/src/stats/parts.tsx` (`Card variant="outlined"`, `CardHeader` with an `h6` title, `CardContent pt: 0`). Make its `subheader` prop optional (`subheader?: string`) for About this source, Run by and Where it shows up; the Stats page passes one everywhere, so nothing there changes. Render each volume alert's body as one string (one text node) so `getByText` can match it.

`RecentSpotsCard({ source, prefs, health })`: loads `loadRecentSpots(source.id)` on mount and every 30 s via `useVisibleInterval(…, 30_000)`; shows `LinearProgress` until the first load, then `<SpotsTable spots={spots} dense prefs={prefs} />`; on failure an `Alert severity="error"` with `errorText(err, "Couldn't load recent spots.")`. Header "Recent spots" / "Everything ingested, before any subscription filters." Under the table: `Typography variant="caption" color="text.secondary"` "Last fetch {relativeAge(age)}, {source.interval}" where `age` is the source's `seconds_since_last_success` from the page's `useIngestHealth(30_000)` (passed in as `health`); omit the line while `health` is null.

- [ ] **Step 1: Write the failing tests**

`web/src/sources/SourceDetailPage.test.tsx`:

```tsx
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { loadIngestHealth, loadRecentSpots, type IngestHealth, type RecentSpot } from "../lib/api";
import { useStats } from "../stats/useStats";
import type { LatestStats } from "../stats/types";
import { SourceDetailPage } from "./SourceDetailPage";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn(), loadRecentSpots: vi.fn() }));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

const UTC = { utcTimes: true, timezone: "UTC" };
const hourly = (withDx = true) => Array.from({ length: 168 }, (_, i) => {
  const h: Record<string, unknown> = {
    hour: new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""),
    pota: i === 125 ? 88 : 36, sota: 5, rbn: i === 125 ? 708 : 192, aprs: 330_000,
  };
  if (withDx) h.dx = 56;
  return h;
});
const stats = (withDx = true) => ({ payload: { hourly: hourly(withDx) }, generatedAt: "2026-10-14T15:00:00Z" }) as unknown as LatestStats;
const spot = { id: 1, source: "pota", callsign: "W1AW", frequency_khz: 14062, band: "20m", mode: "cw", pota_reference: "US-0817",
  sota_summit_ref: null, spotter: "K1ABC", spot_time: "2026-10-14T14:00:05Z" } as RecentSpot;

function open(path: string) {
  return renderPage(
    <Routes>
      <Route path="/sources/:id" element={<SourceDetailPage prefs={UTC} />} />
      <Route path="/sources" element={<p>catalog</p>} />
    </Routes>,
    { route: path },
  );
}

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([{ source: "pota", seconds_since_last_success: 20 }, { source: "rbn", seconds_since_last_success: 5 }] as IngestHealth[]);
  vi.mocked(loadRecentSpots).mockReset().mockResolvedValue([spot]);
  vi.mocked(useStats).mockReturnValue({ stats: stats(), loading: false, error: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SourceDetailPage", () => {
  it("shows RBN's alert, figures, schema and peak", async () => {
    open("/sources/rbn");
    expect(screen.getByRole("heading", { level: 1, name: "Reverse Beacon Network" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/sources");
    expect(screen.getByText("High volume source: a callsign filter is required")).toBeInTheDocument();
    // (167 × 192 + 708) / 7 = 4,681.7 → "4,700"
    expect(screen.getByText(/^Reverse Beacon Network sends about 4,700 spots a day\./)).toBeInTheDocument();
    expect(screen.getByText("Peak 11.8 / min, Oct 12, 05:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("Oct 12, 05:00 UTC")).toBeInTheDocument(); // Busiest moment card
    expect(screen.getByText("Callsign of the skimmer that heard the signal.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Visit reversebeacon.net/ })).toHaveAttribute("href", "https://reversebeacon.net");
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("shows POTA's own fields, recent spots and last fetch", async () => {
    open("/sources/pota");
    expect(screen.getByText("pota_park_name")).toBeInTheDocument();
    expect(screen.queryByText("High volume source: a callsign filter is required")).not.toBeInTheDocument();
    expect(await screen.findByText("W1AW")).toBeInTheDocument();
    expect(loadRecentSpots).toHaveBeenCalledWith("pota");
    expect(await screen.findByText("Last fetch 20s ago, every 60s")).toBeInTheDocument();
    expect(screen.getByText(/"pota_reference": "US-2763"/)).toBeInTheDocument();
  });

  it("leaves schema, example and recent spots off APRS-IS", () => {
    open("/sources/aprs");
    expect(screen.getByText("High volume source: stored only")).toBeInTheDocument();
    expect(screen.queryByText("Schema")).not.toBeInTheDocument();
    expect(screen.queryByText("Example spot")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent spots")).not.toBeInTheDocument();
    expect(loadRecentSpots).not.toHaveBeenCalled();
  });

  it("shows no rates for DX Cluster on a snapshot from before dx", () => {
    vi.mocked(useStats).mockReturnValue({ stats: stats(false), loading: false, error: null });
    vi.mocked(loadRecentSpots).mockResolvedValue([]); // SpotsTable may print "–" for null fields
    open("/sources/dxcluster");
    expect(screen.getAllByText("–")).toHaveLength(4);
    expect(screen.getByText("No rates yet. They appear after the next hourly stats refresh.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Visit/ })).not.toBeInTheDocument();
  });

  it("drops the per-day sentence from the RBN alert without rates", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    open("/sources/rbn");
    expect(screen.queryByText(/spots a day/)).not.toBeInTheDocument();
    expect(screen.getByText(/A subscription only gets its spots if it names callsigns/)).toBeInTheDocument();
  });

  it("keeps the page when stats fail", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: "Couldn't load stats." });
    open("/sources/pota");
    expect(screen.getByText("Couldn't load rates.")).toBeInTheDocument();
    expect(screen.getByText("About this source")).toBeInTheDocument();
  });

  it.each(["/sources/wwff", "/sources/nope"])("redirects %s to the catalog", (path) => {
    open(path);
    expect(screen.getByText("catalog")).toBeInTheDocument();
  });

  it("stops refreshing recent spots when it unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = open("/sources/pota");
    await screen.findByText("W1AW");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);
  });

  it("lays out in one column on a phone", () => {
    setMobile(true);
    open("/sources/rbn");
    expect(screen.getByRole("heading", { level: 1, name: "Reverse Beacon Network" })).toBeInTheDocument();
    expect(screen.getByText("About this source")).toBeInTheDocument();
  });
});
```

Check the per-day arithmetic before relying on it: RBN counts are 192 per hour except 708 at index 125, so total = 167 × 192 + 708 = 32,772, per day 4,681.7, two figures "4,700"; peak 708 / 60 = 11.8. Index 125 is Oct 7 00:00 + 125 h = Oct 12 05:00 UTC.

In `web/src/App.test.tsx`, add a mock and a test:

```tsx
vi.mock("./sources/SourceDetailPage", () => ({
  SourceDetailPage: ({ prefs }: { prefs: { timezone: string } }) => <p>source page {prefs.timezone}</p>,
}));
// …
it("renders a source's detail page at /sources/:id", async () => {
  renderAt("/sources/rbn");
  expect(await screen.findByText("source page Asia/Tokyo")).toBeInTheDocument();
});
```

(Use the same profile/timezone set-up as the neighbouring `/sources` tests in that file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/sources/SourceDetailPage.test.tsx src/App.test.tsx`
Expected: FAIL, `./SourceDetailPage` not found.

- [ ] **Step 3: Implement `RecentSpotsCard.tsx`, `SourceDetailPage.tsx` and the route**

Write both components to the layout above. Key logic for `SourceDetailPage`:

```tsx
export function SourceDetailPage({ prefs }: { prefs: TimePrefs }) {
  const { id } = useParams();
  const source = findLiveSource(id);
  const { health, error: healthError } = useIngestHealth(30_000);
  const { stats, loading, error: statsError } = useStats();
  if (!source) return <Navigate to="/sources" replace />;
  const rates = source.statsKey && stats ? sourceRates(stats.payload.hourly, source.statsKey, source.volume) : null;
  const status = sourceStatus(source, health);
  // … render per the layout list
}
```

Hooks run before the early return (rules of hooks): keep `useIngestHealth` and `useStats` above `if (!source)`. The redirect case then makes one extra `loadIngestHealth` call, which is harmless.

In `web/src/App.tsx`:
- `type Page = "sources" | "source" | …` (add `"source"`).
- `<Route path="/sources/:id" element={<RequireAuth page="source" />} />` after the `/sources` route.
- In `SignedIn`: `{page === "source" && <SourceDetailPage prefs={prefs} />}` and the import.
- Check how `SignedIn` passes the page to `AppShell` for nav highlighting: `AppShell` derives the section from `location.pathname` (`split("/")[0]` after the leading slash), so `/sources/rbn` highlights Sources. If instead `SignedIn` passes `page` through, map `"source"` to `"sources"` there.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd web && npx vitest run && npx tsc -b && npm run lint && npm run coverage
```

Expected: every test passes; coverage at or above 80% on every metric.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/SourceDetailPage.tsx web/src/sources/SourceDetailPage.test.tsx web/src/sources/RecentSpotsCard.tsx web/src/stats/parts.tsx web/src/App.tsx web/src/App.test.tsx
git commit -m "Sources: detail page per source with rates, schema, example and recent spots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Part 5: rules, gates and PR C ready

**Prompt:**

```
Implement Part 5 (Task 8) of docs/superpowers/plans/2026-10-14-source-catalog.md in this worktree
(/Users/bradbazemore/Dev/longlines-source-catalog, branch source-catalog-pages). Parts 3-4 are in
draft PR C. Read the plan's header (including "Branches and PRs"), Global Constraints and Part 5.
Use superpowers:verification-before-completion. Push, update PR C's description and mark it ready
only after every gate passes; report the PR URL.
```

### Task 8: CLAUDE.md, full gates, PR C ready

**Files:**
- Modify: `CLAUDE.md` (new section after "Web app rules")

- [ ] **Step 1: Add the rules**

Insert after the "## Web app rules" section of `CLAUDE.md`:

```markdown
## Source catalog rules

- `/sources` is a catalog and `/sources/:id` a detail page per live source. Their copy lives in
  `web/src/sources/sources.ts` and follows Page 2 of Brad's design canvas, as amended by
  `docs/superpowers/specs/2026-10-14-source-catalog-design.md`; it says "subscription", never
  "connection", until Connections ship.
- Rates come only from the stats snapshot's `hourly` series through `useStats()` (`rates.ts`);
  never poll the snapshot or add a rates RPC. A new source with rates needs a key in
  `refresh_stats_snapshot_at`'s `daily`/`hourly`, the `StatsPayload` type and its pgTAP test.
- The Schema and Example spot cards describe the delivered spot (`DeliverySpot`, `docs/WEBHOOKS.md`).
  A field added to the delivered spot goes in `COMMON_FIELDS` (or a source's own fields) too.
```

- [ ] **Step 2: Run every gate**

```bash
cd /Users/bradbazemore/Dev/longlines-source-catalog
deno task check && deno task lint && deno fmt --check && deno task coverage
supabase db reset && supabase test db
cd web && npm run test:all
```

Expected: everything passes. `npm run test:all` runs every CI check against the local stack and prints a summary; read the summary, and on any failure fix it in the commit that owns it (amend only the last commit; otherwise add a fix commit).

- [ ] **Step 3: Look at it**

Run `cd web && npm run dev:full`, sign in locally (see the memory "Local browser walkthrough" if Playwright is needed), open `/sources`, `/sources/rbn`, `/sources/pota`, `/sources/aprs` at desktop and 390 px widths. Check: tiles in order, search and chips, the RBN alert, the chart with a red peak dot, schema table, example JSON, recent spots, no horizontal scroll on a phone. Fix anything broken and commit.

- [ ] **Step 4: Commit, push, mark PR C ready**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: source catalog rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin source-catalog-pages
gh pr edit source-catalog-pages --title "Source catalog: tiles and a detail page per source" --body "$(cat <<'EOF'
Builds Page 2 of the design canvas (Source catalog). The last of three PRs: #161 added `dx` to the stats snapshot, #<B> the catalog data, status and rates modules these pages use.

- `/sources` is now a catalog: search, All / Connected / Not yet available, one tile per source with status, volume and its 7-day average rate.
- `/sources/:id` per live source: volume alert, average / peak / minimum / busiest hour, a 7-day rate chart, the delivered-spot schema and an example, about, run by, where it shows up, and the recent spots table that used to sit on the Sources page.
- CLAUDE.md gains "Source catalog rules".

Spec: `docs/superpowers/specs/2026-10-14-source-catalog-design.md`. Copy differs from the mock where the mock describes things Long Lines doesn't do; the spec lists every change.

## Testing

<the gate results from Step 2 with real counts, and what Step 3 checked in the browser>

No migration; nothing changes in `relay/` or the Edge Functions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr ready source-catalog-pages
```

Fill in `#<B>` (`gh pr list --head source-catalog-data --state all`) and the Testing section before running it.

Expected: `gh pr ready` confirms; report the PR URL. CI runs on the PR.
