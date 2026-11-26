# Canadian Licenses (ISED): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 3, 2026-10-29, against main at `28e3d55` (#302, revision 2 of this plan, merged).
Revision 3 checks every fact against the published file (the file is UTF-8, not Latin-1; 92,175
records; nightly) and follows the FCC and reference-list loaders this repo already has.

**Goal:** Load ISED's amateur certificate list into `callsign_licenses` (`authority = 'ISED'`,
`country = 'CA'`) weekly, so callsign profiles and the First name / Last name delivery fields
cover Canadian calls.

**Architecture:** The FCC load's shape with one staging table. The inbound worker
(`inbound/ised_licenses.ts`) checks once a day and loads weekly: it GETs the 2.3 MB zip, reads
`amateur_delim.txt` with the existing `inbound/zip.ts`, parses it with `_shared/ised.ts` and posts
batches to `load-ised-licenses`, which stages them through `ised_license_load_*` RPCs. SQL
enforces the floor at finish, and the existing hourly `apply_license_loads()` swaps the newest
ready load of each authority.

**Tech Stack:** Deno, TypeScript, Zod, Postgres (plpgsql, pgTAP), React 19, MUI 9, Vitest.

**Design source:** `docs/superpowers/specs/2026-10-29-canadian-license-import-design.md`
(decisions, the file's facts, privacy, copy). Read it first.

**Models to copy:** the FCC load (`inbound/licenses.ts`, `_shared/uls.ts`,
`_shared/handlers/load_licenses.ts`, `load-licenses/`, `20261012000050_callsign_licenses.sql` and
the latest bodies in `20261021000300_destination_names.sql` and `20261028000200_inbound_worker.sql`)
and the reference list load's cadence and floor (`inbound/catalogs.ts`, `reference_load_floor` in
`20261026001100_reference_catalog.sql`).

## Before you start

- [ ] Brad has confirmed the spec's (Brad) items: the qualification wording and the profile copy.
      Tasks 1 to 4 do not depend on them; Task 5 does.
- [ ] The attribution question in the spec's "Profile" section is answered (Task 5 adds the line
      if the licence needs one).
- [ ] Work in a worktree (`git worktree add ../longlines-ised -b ised-licenses origin/main`).
- [ ] Pick the migration number: the next free one after the newest on main
      (`20261029001000` when this was written). Never reuse or slot below an existing number.

## Task 1: Parser (`_shared/ised.ts`)

Files: create `supabase/functions/_shared/ised.ts`,
`supabase/functions/_shared/__tests__/ised.test.ts`,
`supabase/functions/_shared/__tests__/fixtures/ised-amateur.txt`.

- [x] Write the fixture by hand: a header line identical to the real one, then about 12 synthetic
      records with calls ending in `S` (as `seed.sql` does: `VE3TSS`, `VA7QSS`, ...), CRLF line
      ends, UTF-8. Cover: accented names (`Hélène`, `Françoise`), a literal `"` nickname, padded
      names, a club with `club_name_2`, a blank province, each qualification combination in the
      spec, one A-only and one E-only. Every address field holds made-up text, so the tests can
      prove none of it comes through. Never paste lines from the real file.
- [x] Write failing tests:
  - the header is read by name: a fixture with the columns shuffled parses the same rows; a
    header missing `callsign`, `first_name`, `surname`, `prov_cd`, any `qual_*` or `club_name`
    throws `ValidationError`
  - a person row gives `{callsign, first_name, last_name, club_name: null, province, qualifications}`
    with names trimmed and accents intact; `qualifications` is the held letters in order (`"ACD"`)
  - a club row gives `club_name` as `club_name` + `" "` + `club_name_2` trimmed, and still the
    person fields (SQL drops them; the parser does not decide what a club is)
  - an empty province is null; an empty name is null
  - no row object has any key for address, city, postal code or club address/city/province/postal
    code (assert the exact key set)
  - a line with a field count other than the header's, or a callsign failing `^(?:C[F-KYZ]|V[A-GOXY]|X[J-O])[A-Z0-9]{1,7}[A-Z]$`,
    is skipped and counted, not thrown (`IsedRecords.skipped`)
  - a qualification field holding anything but its own letter or empty is skipped and counted
  - the parser streams: feeding the fixture in 7-byte chunks gives the same rows
- [x] Implement:
  - `export interface IsedRow` (the six keys above) and `isedRowSchema: z.ZodType<IsedRow>`,
    `z.strictObject` (our own request bodies)
  - `export class IsedRecords`, modelled on `UlsRecords` and `ReferenceCatalogParser`: takes text
    chunks, splits CRLF/LF lines, reads the header once, yields rows; `MAX_ISED_RECORD` bounds a
    line
  - the request types and schemas the handler and the worker share (`LoadIsedLicensesRequest`,
    actions `status`, `begin`, `rows`, `finish`, `abandon`; `finish` carries `{load, rows}`) and
    `IsedLoad` / `isedLoadSchema` (`z.looseObject`, RPC jsonb)
  - split on `;` only: the file has no quoting (spec, "Upstream")
- [x] `deno test -P supabase/functions/_shared/__tests__/ised.test.ts`, then `npm run lint`,
      `npm run typecheck`. Commit.

## Task 1B: Special Callsigns Parser (`_shared/ised_special.ts`)

Files: create `supabase/functions/_shared/ised_delim.ts` (shared semicolon-delimited streaming
reader extracted from `_shared/ised.ts`), `supabase/functions/_shared/ised_special.ts`,
`supabase/functions/_shared/__tests__/ised_special.test.ts`,
`supabase/functions/_shared/__tests__/fixtures/ised-special.txt`.

- [x] Sourced from runtime URL `https://apc-cap.ic.gc.ca/datafiles/special_callsign.zip` containing `special_callsign.txt`.
- [x] Header: `Special_call_sign;beg_date;end_date;event_en;event_fr;call_sign_request;use_by`.
- [x] Write synthetic fixture `ised-special.txt` following header structure and test parsing of special callsigns with valid calendar ISO date ranges, event descriptions, and skipping of 2-character RIC-9 special event prefixes and malformed dates.
- [x] Implement parser `IsedSpecialRecords` over `IsedDelimReader`, Zod schemas (`z.iso.date()` for dates), request/status schemas for `load-ised-special`, and unit tests.

## Task 2: Migration

Files: create `supabase/migrations/<number>_ised_licenses.sql`, `supabase/tests/ised_licenses.test.sql`.

- [x] `ised_amateur_stage`, unlogged, RLS on, no policies, `anon`/`authenticated` revoked:
      `callsign text primary key, first_name text, last_name text, club_name text, province text,
      qualifications text not null`. No other columns.
- [x] `ised_special_callsigns` live table (RLS on, `anon`/`authenticated` revoked) and
      `ised_special_stage` (unlogged, RLS on, `anon`/`authenticated` revoked), both keyed by
      `(callsign, beg_date, end_date)` with `event_en`, `event_fr`, `call_sign_request`, `use_by`
      (`callsign_licenses` stays untouched, keeping `callsign` as PK).
- [x] `ised_special_floor() returns integer`, `ised_special_staged_counts()`, and lifecycle RPCs
      (`ised_special_load_*`) for special callsigns (`on conflict (callsign, beg_date, end_date) do nothing`,
      returning cumulative staged count).
- [x] `ised_operator_class(p_letters text) returns text` (immutable, `search_path` pinned): the
      spec's order and words; null for an empty string.
- [x] `ised_license_floor() returns integer`: 90% of the current ISED rows of
      `callsign_licenses`, 80,000 when there are none (the shape of `reference_load_floor`).
- [x] The lifecycle RPCs, each `security definer`, `search_path` pinned, executable by
      `service_role` only, mirroring the FCC ones with `authority = 'ISED'`:
  - `ised_license_load_status()`: the newest ISED load and the `started_at` of the newest applied
    one (the worker's week rule needs both)
  - `ised_license_load_begin(p_version)`: fails unfinished ISED loads, truncates staging, returns
    the id
  - `ised_license_load_rows(p_load, p_rows jsonb)`: `jsonb_to_recordset` into the staging columns
    (unknown keys dropped), `on conflict (callsign) do nothing`; returns the staged count
  - `ised_license_staged_counts()`: `jsonb_build_object('rows', count(*))`
  - `ised_license_load_finish(p_load, p_rows)`: the staged count must equal `p_rows` and be at
    least `ised_license_floor()`, else raise (the worker abandons); marks ready with counts
  - `ised_license_load_abandon(p_load, p_error)`: failed, staging truncated
- [x] Replace `apply_license_loads()`. Start from its latest body (`20261021000300`) word for word
      and move it into `apply_fcc_license_load()`; add `apply_ised_license_load()`:
      check `ised_license_staged_counts() is distinct from v_load.counts` before swapping;
      delete `authority = 'ISED'` rows, insert from `ised_amateur_stage` with
      `name = coalesce(club_name, nullif(trim(concat_ws(' ', first_name, last_name)), ''))`,
      `first_name`/`last_name`/`operator_class` null when `club_name` is set, else the names and
      `ised_operator_class(qualifications)`, `status`/`granted_on`/`expires_on`/`grid` null,
      `country 'CA'`, `state = province`, `loaded_at now()`. In a second independent exception
      block, check `ised_special_staged_counts() is distinct from v_special_load.counts` and swap
      `ised_special_stage` into `ised_special_callsigns`. Each exception block marks its load
      failed and truncates its staging table. `apply_license_loads()` calls the FCC one, then the
      ISED one. The cron job stays as it is.
- [x] Replace `callsign_profile` from its latest body (`20261019000300_callsign_calendar.sql`)
      word for word, adding `'caPrefix', v_base ~ '^(V[A-GOXY]|C[F-KYZ]|X[J-O])'` beside
      `usPrefix`.
- [x] pgTAP (`ised_licenses.test.sql`, rolled back, deleting from the tables it counts first):
  - staging has exactly the six columns; `ised_license_load_rows` drops an `address_line` key
  - begin, rows twice with an overlapping batch, finish, apply: the rows land with the right
    authority, country, names, `operator_class` for each spec example, null status and dates
  - a club row: club name, null first/last/class
  - finish refuses a count mismatch and a load below the floor (first load: 80,000; with 10 ISED
    rows present the floor is 9)
  - lost-staging survival for both regular ISED and special ISED loads
  - special callsign lifecycle into `ised_special_callsigns` (repeated callsign across date
    ranges, exact duplicate dropped, floor check, apply)
  - a failing ISED apply (force a bad staged row, or drop staging counts out of step) leaves the
    FCC rows and an FCC ready load applied; a failing FCC apply leaves the ISED swap working
  - an FCC apply never touches ISED rows and the reverse
  - `spot_license_name` returns a Canadian person's names and nothing for a club or a hidden call
  - every new function is executable by `service_role` only
- [x] In `callsign_profile.test.sql`: `caPrefix` in the key list; true for `VE3`, `VA7`, `VY0`,
      `CY0`, false for `K1`, `G4`. In `advisor.test.sql`: add a function only if the suite asks.
- [ ] `supabase db reset`, `supabase test db`, `psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke-test.sql`,
      `supabase db lint`. Regenerate `web/src/lib/database.types.ts`. Commit.

## Task 3: Edge Functions (`load-ised-licenses` and `load-ised-special`)

Files: create `supabase/functions/_shared/handlers/load_ised_licenses.ts`,
`supabase/functions/load-ised-licenses/index.ts`, `supabase/functions/load-ised-licenses/deno.json`
(copy `load-licenses/deno.json`), `supabase/functions/_shared/__tests__/handlers_load_ised_licenses.test.ts`,
plus the parallel `load_ised_special.ts` / `load-ised-special/` / `handlers_load_ised_special.test.ts`
files; edit `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/db.ts`,
`supabase/config.toml`.

- [x] `IsedLicenseDb` and `IsedSpecialDb` in `types.ts` (status, begin, stageRows, finish, abandon)
      and `createIsedLicenseDb` / `createIsedSpecialDb` in `db.ts`, each RPC result read with its
      schema from `_shared/ised.ts` / `_shared/ised_special.ts`.
- [x] Failing handler tests with fakes, copying `handlers_load_licenses.test.ts`:
      a missing or wrong `x-inbound-secret` is 401 before any db call; each action maps to its
      method; a body with an extra key or a row with an address key is 400; more than
      `MAX_ISED_ROWS_PER_REQUEST` rows is 400; a failed RPC (a finish refusal included) is a 500
      with its message, as the FCC handler maps it.
- [x] Implement `handleLoadIsedLicenses(req, deps)` and `handleLoadIsedSpecial(req, deps)` with
      their entrypoints (`Deno.serve(handler);`).
- [x] `config.toml`: `[functions.load-ised-licenses]` and `[functions.load-ised-special]` with
      `verify_jwt = false` and the comment the FCC entry has. Neither handler imports
      `isServiceRole` (`function_config.test.ts`).
- [ ] `deno task test`, `deno task check`, `npm run lint`, `npm run typecheck`. Commit.

## Task 4: Inbound worker

Files: create `inbound/ised_licenses.ts`, `inbound/__tests__/ised_licenses.test.ts`; edit
`inbound/config.ts`, `inbound/inbound.ts`, `inbound/Dockerfile`, `inbound/__tests__/modules.test.ts`,
`inbound/__tests__/inbound.test.ts`, `inbound/__tests__/licenses.test.ts`,
`inbound/__tests__/catalogs.test.ts`.

- [x] `config.ts`: `ISED_AMATEUR_ZIP` / `INBOUND_ISED_LICENSES` and `ISED_SPECIAL_ZIP` /
      `INBOUND_ISED_SPECIAL` read like `INBOUND_LICENSES` (`off`, a URL, or unset for the ISED
      file; unset with local functions means off; https outside local development) into
      `isedZipUrl: string | null` and `isedSpecialZipUrl: string | null`.
- [x] Failing tests against a local server (`zip_server.ts`) serving a zip built in the test from
      the Task 1 and Task 1B fixtures, and a fake client:
  - `shouldImportIsed(version, status, now)`: no load yet, yes; last applied began under 7 days
    ago, no; a newer `Last-Modified` and a week passed, yes; an unfinished load under 12 hours
    old, no
  - a full import posts begin, batched rows, finish with the parsed/staged row count
  - a 500 mid-download, a zip without `amateur_delim.txt` and a finish refusal each abandon the
    load with the error
  - the HEAD and the GET send the User-Agent
- [x] Implement: once a day HEAD; on import, GET the whole body under `STREAM_HEADER_TIMEOUT_MS`,
      wrap it in an in-memory `RangeSource` (no new zip code), `openZipEntry` the list,
      `pipeThrough(new TextDecoderStream())` (UTF-8, the default) into `IsedRecords` /
      `IsedSpecialRecords`, post in batches. No floor in TypeScript: SQL's finish decides.
- [x] Wire into `inbound.ts` beside the FCC loop (separate `FunctionPoster`s for
      `load-ised-licenses` and `load-ised-special`, log prefixes `[ised]` and `[ised-special]`,
      joined on shutdown); add `INBOUND_ISED_LICENSES` and `INBOUND_ISED_SPECIAL` to the
      Dockerfile's `--allow-env` (`modules.test.ts` checks them).
- [x] `deno task coverage` (inbound stays at 80% and `ised_licenses.ts` is loaded by a test),
      `deno task check`, `deno task lint`, `deno fmt --check`, `eslint`. Commit.

## Task 5: Profile page

Files: edit `web/src/profile/types.ts`, `format.ts`, `format.test.ts`, `CallsignPage.tsx`,
`CallsignPage.test.tsx`, `LookupPage.tsx`, `LookupPage.test.tsx`, `fixtures.ts`.

- [x] `types.ts`: `caPrefix?: boolean` (absent in profiles cached before the migration), with a
      comment; `License.authority` comment `"FCC" | "ISED"`.
- [x] Failing tests: `noLicenseMessage` for US, Canadian and other calls; the subheader by
      authority, and by prefix with no license; an ISED license shows Name, Qualifications and
      Province and no Status, Granted or Expires rows; a profile without `caPrefix` reads as not
      Canadian; the footer and the lookup intro name ISED.
- [x] Implement with the spec's copy word for word (and the attribution line if Brad confirmed
      one). `sx` stays layout only. Add an ISED fixture (a synthetic `VE3TSS`).
- [x] `cd web && npm test && npm run build && npm run lint && npm run coverage`. Commit.

## Task 6: Documentation

- [ ] `docs/ARCHITECTURE.md`: "Licenses (FCC)" becomes "Licenses (FCC and ISED)" with an ISED
      subsection (cadence, floor, clubs, the shared apply); the inbound worker summary names it.
- [ ] `docs/OPERATIONS.md`: "Licenses (ISED)": how to read the ISED loads in `license_loads`,
      `INBOUND_ISED_LICENSES=off`, and running one load by hand locally.
- [ ] `CLAUDE.md`: in "Inbound worker rules" add the weekly ISED load (`inbound/ised_licenses.ts`,
      parsed by `_shared/ised.ts`, floor and swap SQL's, never stage address fields, fixtures
      synthetic); in "Delivery rules" the First/Last name line names ISED too; in "Conventions"
      `callsign_licenses` is FCC and ISED data.
- [ ] Full gate: `deno task test`, `deno task coverage`, `deno task check`, `deno task lint`,
      `deno task fmt`, `npm run lint`, `npm run typecheck`, `supabase test db`,
      `cd web && npm run test:all`. Commit and open the PR.

## Task 7: Special Callsigns UI Integration (follow-up)

- [ ] Design and confirm profile JSON shape and UI copy for time-bounded special callsigns from
      `ised_special_callsigns` (active vs. historical windows evaluated at query time, bilingual
      `event_en`/`event_fr`, and sponsoring station `use_by`). Historical records are already
      preserved in `ised_special_callsigns` and available for future display.
- [ ] Surface active/historical special callsigns in `callsign_profile` and the profile page with
      pgTAP and Vitest coverage.

## Deploy order (Brad)

A merge to main deploys the inbound worker and the web app at once, so:

1. From the PR branch before merging: `supabase db push`, then
   `supabase functions deploy load-ised-licenses` and `supabase functions deploy load-ised-special`.
2. Merge. The inbound worker starts its daily check; the first load stages about 92,000 rows and
   `apply-license-loads` swaps it in at the next :50.
3. Check: `select authority, status, licenses, error from license_loads order by id desc limit 3;`
   and a Canadian profile on longlines.io.
