# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Long Lines ingests ham radio spots from POTA, SOTAwatch and the Reverse Beacon Network into
Supabase. Phase 1 was ingest-to-storage only; the scope exclusions in `docs/ARCHITECTURE.md` and the
original spec are deliberate. Do not add auth, RLS, UI, consumers, notifications, cross-source
dedup, or new sources without being asked.

Everything runs on Supabase: Postgres (pg_cron, pg_net, pgmq) plus Deno Edge Functions in
strict TypeScript. The one exception is `relay/`, a Deno process on Fly.io that holds telnet streams
(see "Relay rules"). No JavaScript files, no `any` without a justifying comment, no new runtime
dependencies without a comment saying why.

## Commands

```sh
deno task test        # unit tests; -P loads the permission set from deno.json (net/env/read for http + fixture tests)
deno test -P supabase/functions/_shared/__tests__/pota.test.ts --filter "hashes"   # one test
deno task coverage    # tests + coverage; fails below 80% lines or if a module is never loaded (CI runs this)
deno task check       # type-check the Edge Function entrypoints
deno task lint
deno task fmt

supabase start                # local stack, applies all migrations
supabase db reset             # re-apply migrations from scratch locally, then load supabase/seed.sql
supabase functions serve      # serve both functions against the local stack
docker exec -i supabase_db_longlines psql -U postgres   # psql is not installed; use the container

psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke-test.sql   # schema smoke test, also run by CI
supabase test db                       # pgTAP suites in supabase/tests/*.test.sql (local db must be running)

cd web && npm run dev:full             # stack + web/.env.local + Vite + functions serve (README lists all npm shortcuts)
cd web && npm run test:all             # every CI check against the local stack, with a summary; :fresh resets the db first
cd web && npm run dev                  # web app on http://localhost:5173 (needs web/.env.local)
cd web && npm test                     # Vitest: *.test.ts in node, *.test.tsx in jsdom
cd web && npm run coverage             # same, failing below 80% on any metric (CI runs this)
cd web && npm run build                # tsc -b + vite build; zero TS errors required
cd web && npm run lint                 # oxlint
supabase gen types typescript --local > web/src/lib/database.types.ts   # after schema changes

supabase db push                       # hosted: apply migrations
supabase functions deploy ingest-pota  # hosted: deploy one function

docker build -f relay/Dockerfile .     # relay image; build context is the repo root
fly deploy --ha=false                  # hosted relay from the root fly.toml; normally Fly's GitHub integration
```

Local invocation: `curl -X POST http://127.0.0.1:54321/functions/v1/ingest-pota -H "Authorization: Bearer <service_role key printed by supabase start>"`.

## Architecture

- `supabase/functions/_shared/ingest.ts` is the orchestrator; `ingest-pota/index.ts` and
  `ingest-sotawatch/index.ts` are three-line shells around `serve.ts`. The other entrypoints are
  `Deno.serve` shells around `_shared/handlers/*.ts`, which take their clients and sender as
  arguments so tests can pass fakes (`__tests__/fake_supabase.ts`). Behavior changes go in
  `_shared`, never in the entrypoints.
- Every function directory needs its own `deno.json`: `supabase functions deploy` bundles with it
  as the import map, not the root one. `__tests__/function_config.test.ts` fails CI without it.
- Source adapters (`pota.ts`, `sotawatch.ts`) implement `SourceAdapter` from `types.ts`:
  `parseFeed` and `normalize` are pure and tested against fixtures; only `fetchSpots`/`fetchEpoch`
  do I/O. `normalize` returns `{kind: "skip"}` for intentional drops and throws for unprocessable
  spots; the orchestrator turns throws into `ingest_failures` rows without aborting the run.
- `IngestDb` (`types.ts`) is the only database surface the orchestrator sees. `db.ts` implements
  it over supabase-js; tests use an in-memory fake.
- All writes go through security-definer RPCs in `supabase/migrations/*_ingest_functions.sql`.
  `ingest_spots(jsonb)` is one SQL statement: a data-modifying CTE does the insert with
  `ON CONFLICT DO NOTHING RETURNING`, and a second CTE calls `pgmq.send_batch`. The second CTE
  is cross-joined into the result on purpose; an unreferenced CTE would never run.
- Dedup is the unique constraint `(source, source_spot_id, content_hash)`. The hash field order
  per source is fixed (see `ARCHITECTURE.md`); changing it would make every existing spot look
  new on the next run.
- Cron jobs read the project URL and service-role key from Vault
  (`scripts/setup-db-settings.sql` creates them once). Migrations never contain secrets.

## CI

`.github/workflows/ci.yml` runs on every PR and push to main: Deno fmt/lint/check/test, then
`supabase db start` + `supabase db lint` + `scripts/smoke-test.sql` on a fresh Postgres.
Migrations already applied to the hosted project must not be edited; add a new migration instead
(see `20261005000009_*`). Fly's GitHub integration (configured in the Fly dashboard) deploys the
relay on pushes to main; nothing else deploys automatically.

## Phase 2 schema rules

- Client writes to `destinations` and `subscriptions` go through RPCs (`create_destination`,
  `rotate_signing_secret`, `save_subscription`, `delete_subscription`). Direct insert/update is
  revoked on purpose; the only direct client write is `subscriptions.enabled`.
- `destinations.url` and `signing_secret` are excluded from the column grant. Never add them to a
  view or RPC result except the one-time return from `create_destination`/`rotate_signing_secret`.
- `recent_spots` is the only client view over `raw_spots`; keep `raw_payload` out of it. It and
  `ingest_health` are invoker views with no client grants; clients read them through the definer
  RPCs `list_recent_spots` / `list_ingest_health`. Never make a view `security_invoker = false`
  (the Supabase linter flags it).
- Service-role-only tables (`deliveries`, `subscription_quiet`, `sign_in_attempts`) have RLS on and
  no policies. Functions that touch `auth.users` are `security definer` with execute granted only
  to `service_role`.
- pgTAP tests include `helpers/users.psql` (not `.sql`, so the runner skips it) and use
  `pg_temp.as_user(uuid)` to assert RLS from a user's point of view.

## Phase 3 stats rules

- `stats_snapshots` is written only by `refresh_stats_snapshot()` from pg_cron; clients have
  `select` only. It is the one table `anon` may read: the Stats page (`/stats`) is public and
  renders in `PublicShell` when signed out, `AppShell` when signed in. RBN figures come from the
  `rollup_rbn_day` tables, never from `rbn_spots` directly: the refresh runs hourly and the
  firehose is ~1.5M rows a day. The payload shape is `StatsPayload` in `web/src/stats/types.ts` and is pinned by
  `supabase/tests/stats_snapshot.test.sql`; change the SQL, the type and the test together.
  A trigger on `stats_snapshots` (`stats_snapshots_drop_hidden`) removes calls in
  `hidden_callsigns` from `topActivators` and `rbn.topStations`, so a top list can hold fewer than eight.
- The Stats page is deliberately fixed: no controls beyond tooltips, one request per hour of use
  (`web/src/stats/cache.ts` keeps a snapshot until the next refresh is due; never poll).
  Do not add filters, date pickers, sorting or MUI X Pro components.

## Delivery rules

- `deliver` and `archive` authorize with `isServiceRole` (`_shared/auth.ts`): the runtime's
  `SUPABASE_SERVICE_ROLE_KEY` (now the `sb_secret_` key) or a JWT with `role: service_role`, which
  is what pg_cron sends from Vault. The JWT is trusted only because the gateway verified it, so both
  functions keep `verify_jwt = true` in `config.toml`.

- Matching lives in SQL (`spot_matches`, `match_pending_spots`); never re-implement the predicate in
  TypeScript. The preview RPC and the matcher must stay on the same function.
- A DX Cluster spot matches only subscriptions whose `sources` lists `dxcluster`; an empty sources
  list ("any source") does not include it. The rule lives in `source_matches`. RBN spots match only subscriptions that name callsigns.
- The worker (`supabase/functions/deliver`) only talks to the database through the
  `claim_deliveries` / `mark_deliveries_*` / `delay_deliveries` RPCs so delivery rows, queue
  messages and destination health change atomically.
- Formatting, signing and URL safety are pure modules under `_shared/delivery/` with tests;
  `send.ts` is the only place that calls `fetch` for destinations. `allowInsecure` exists for tests
  and local development only.
- Rate limits are not failures: a 429 or the per-run cap delays messages via `delay_deliveries`
  without touching `consecutive_failures`.

## Web app rules

- `web/src/lib/api.ts` is the only module that touches supabase-js; pages call its typed
  functions. Edge Functions are called with plain `fetch` there so non-2xx bodies surface as
  messages.
- Stock MUI theme, `palette.mode` from `prefers-color-scheme` only. MUI 9: `Grid` uses `size`,
  `Stack` takes flex alignment through `sx`, there is no `fontWeight` prop (use a variant such as
  `subtitle2`), `slotProps` replaces `InputProps`/`secondaryTypographyProps`.
- `sx` is for layout only (spacing, sizing, display, flex/grid placement, overflow, position).
  Colors, fonts, borders and shadows come from component props and variants.
- Copy comes from `docs/ui-mock.html`; keep it word for word.
- Matching previews come from the `preview_subscription` RPC, never from TypeScript.
- Database types in `web/src/lib/database.types.ts` are generated; regenerate after migrations.
- Env: `web/vite.config.ts` maps `SUPABASE_URL`/`SUPABASE_ANON_KEY` (what the Supabase Vercel
  integration provides) onto `import.meta.env.VITE_*` with an explicit allowlist. Never widen
  `envPrefix` or add the service-role key to that mapping.
- `web/scripts/*.ts` are local-dev helpers behind the npm scripts, run by Node's built-in type
  stripping (erasable syntax only, `.ts` import extensions). They only talk to the local stack;
  `local-stack.ts` refuses a non-local API URL. Never add a script that deploys or pushes.
- The guided tour lives in `web/src/tour/`. All tour copy is in `model.ts`: the steps, the
  "Take the tour" menu label and the ended toast (the mock has no tour section).
  `TourProvider.tsx` is the only module that imports react-joyride. Pages and dialogs only add
  `data-tour` attributes, call `useTour().report(...)` and read `useTour().active`; never drive
  Joyride from a page.

## Testing

- Both suites gate at 80% in CI. The Deno gate (`scripts/check-coverage.ts`) checks
  `supabase/functions` and `relay/` separately and also lists any module no test imports, since
  `deno coverage` silently omits those.
- Deno excludes modules whose names end in `test.ts` from coverage, so never name a source file
  `*_test.ts` (hence `handlers/test_delivery.ts` for the send-test function).
- Web component tests render through `web/src/test/render.tsx` (theme, MemoryRouter, stub App and
  Tour contexts) and `vi.mock("../lib/api")` with explicit factories. `setMobile(true)` from
  `test/media.ts` switches `useMediaQuery` to the phone layout. Pure `*.test.ts` files stay in node:
  jsdom applies Vite's browser file guard, which blocks `states.test.ts` reading the migrations.

## Relay rules

- `relay/main.ts` is only the process shell (env, signals, exit code); behavior goes in
  `relay/relay.ts`, which tests run against a local telnet server and a local functions server.
- `relay/` holds one telnet session per feed in `relay/feeds.ts` and pushes to an
  `ingest-<source>` function built with `servePush` in `_shared/serve.ts`. Parsing lives in the
  source adapter under `_shared` (the relay imports `parseRbnLine`); never parse spots in `relay/`.
- The relay holds only `LONGLINES_RELAY_SECRET`, never a Supabase key. Push functions have
  `verify_jwt = false` and check `x-relay-secret` themselves.
- The relay forwards every spot line. `ingest-rbn` stores all of them in `rbn_spots` (partitioned by
  UTC day; partitions live in the `partitions` schema and come from `create_rbn_spots_partition`,
  never `create table ... partition of`) and runs `runIngest` only over watched callsigns. A
  migration that indexes `rbn_spots` partition by partition first takes
  `lock table rbn_spots in share update exclusive mode`, so `maintain_rbn_spots` cannot add or drop a
  partition mid-build; that lock does not block inserts. `spot_matches` lets an RBN spot match only
  subscriptions that name callsigns; keep that guard if the predicate changes.
- Be polite: exactly one machine (`fly scale count 1`), reconnect backoff never below 30 s, no
  tests that connect to RBN. Tests use the captured fixture or a local TCP server.
- Merges to main deploy the relay through Fly's GitHub integration (set up in the Fly dashboard,
  not in this repo); a merge that changes `relay/` or `_shared/*.ts` ships to production. Never run
  `fly deploy` or `fly secrets set` yourself unless asked.
- The relay also runs the weekly FCC license load (`relay/licenses.ts`, `relay/zip.ts`): it reads
  `l_amat.zip` by HTTP Range and stages HD/EN/AM rows through `load-licenses`. Record parsing is
  `_shared/uls.ts`; the join and the swap into `callsign_licenses` are SQL
  (`apply_license_loads`, pg_cron), because the swap outlasts the API's 8 s statement timeout.
  Never stage or store ULS address, city, ZIP, PO box, phone, email or FRN fields. No test
  downloads from the FCC; tests build a zip and serve it locally (`relay/__tests__/zip_server.ts`).

## Archive rules

- Slice length lives only in `archive_slice_minutes(source)` (RBN 10 minutes, others 60). NDJSON is
  built in SQL (`archive_ndjson`), never in TypeScript; the `archive` function only gzips, uploads
  and logs.
- A slice is logged in `archive_log` only after its upload succeeds. Nothing leaves `rbn_spots`
  unless `rbn_day_archived` finds every slice of the day logged with a matching count; `raw_spots` is
  never pruned by the archive.
- Storage S3 access keys never go in the web app, the relay or an Edge Function.

## Callsign rollup rules

- Profiles and rollups read `spot_stream`, never a source table by name. A source writing
  `raw_spots` needs nothing; a new firehose table needs one `union all` arm in the view.
- `rollup_callsign_day` runs exactly once per completed UTC day (its marker goes in first):
  references, seen and variants are running totals. Never delete a marker to re-roll a day. It
  refuses a day it cannot roll up whole (no cty.dat, RBN rows already retired) rather than mark it.
- The rollups run in their own hourly cron job (`rollup-callsign-days`), never inside
  `maintain_rbn_spots`, so a slow rollup cannot hold partition locks or undo retention.
- Group a day by `callsign`/`spotter` before calling `base_callsign()` or `cty_lookup()`; the
  RBN arm computes base calls per row. Profiles use `mode_bucket(mode, mode_family)`;
  `refresh_stats_snapshot` still has its own copy of the same CASE until callsign profiles PR 7
  moves it over, so change both together until then.
- `base_callsign()` output is now permanent in the rollups: changing it splits history. If it
  must change, the same migration rewrites `raw_spots.base_callsign`, runs
  `reindex index rbn_spots_base_callsign_time_idx` (Postgres never rebuilds an expression index when
  its function changes) and fixes any `hidden_callsigns` row its check would now reject.

## Profile rules

- `callsign_profile(call)` builds the whole profile in SQL. Its shape is `CallsignProfile` in
  `web/src/profile/types.ts`, pinned by `supabase/tests/callsign_profile.test.sql`; change the SQL,
  the type and the test together. It is not granted to clients: the public `callsign-profile`
  function reads it through `cached_callsign_profile` after `record_profile_lookup`.
- Live reads of `spot_stream` filter on `base_callsign` and `spot_time`, so `raw_spots` and the
  `rbn_spots` expression index both serve them. Group by spotter before calling `base_callsign()`
  or `cty_lookup()` on spotters.
- The rate limit keys on a header the edge proxy sets (`LONGLINES_CLIENT_IP_HEADER`, its last
  entry), never on the first `x-forwarded-for` entry. It accepts only a parsed IP, keys IPv6 by /64,
  and stores only an HMAC (`_shared/hmac.ts`, key imported once per isolate).
- A `verify_jwt = false` function never imports `isServiceRole`, which trusts an unverified JWT
  claim; `function_config.test.ts` walks every such function's imports and fails if one does.

## Conventions

- Time-dependent functions take `now: Date` so tests pin the clock. The POTA and SOTAwatch
  fixtures were captured 2026-10-05 ~13:45Z, the RBN telnet fixture 2026-10-11 14:54-14:56Z; tests
  set `NOW` inside the five-minute window of the spots they expect to keep.
- Mode canonicalization, the comment hint and `mode_family` live in `_shared/modes.ts`. SQL only
  compares strings against `mode` and `mode_family`; never re-derive the family in SQL or the web.
  `resolveDxMode` (comment, then band plan) is for DX Cluster only, whose lines have no mode
  field; the other sources keep `resolveMode`.
- POTA `spotTime` has no timezone; `parseUtc` appends `Z`. SOTAwatch `type` may be null and is
  treated as NORMAL. The QRT fixture spot has a null frequency, so the type check must stay ahead
  of frequency parsing.
- Tables, the view and the RPCs have `anon`/`authenticated` grants revoked; keep that on any new
  object. The exception is `select` on `stats_snapshots` (anon). `callsign_licenses` is public FCC
  data but stays service-role only, so `hidden_callsigns` cannot be read around; clients get
  licenses from the `callsign-profile` function.
- `supabase/seed.sql` is a synthetic week relative to `now()` (made-up calls ending in `S`) for
  preview branches and local resets; it ends with a stats refresh. pgTAP suites that count rows
  delete from those tables first, inside their rolled-back transaction, so they pass seeded or not.
- Be polite to upstreams: User-Agent on every fetch, no polling faster than the cron schedule,
  no tests that hit live APIs.
- Spotter countries come from `cty_lookup(call)` in SQL over the weekly cty.dat import
  (`import-cty`); TypeScript only parses the file (`_shared/cty.ts`) and never resolves a call.
