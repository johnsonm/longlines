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
  `rollup_rbn_day` tables (today's hours from `rollup_rbn_hours`), never from `rbn_spots` directly: the refresh runs hourly and the
  firehose is ~1.5M rows a day. APRS figures come from `aprs_packet_hours` and the `aprs_daily_*`
  tables, never `aprs_packets`. The payload shape is `StatsPayload` in `web/src/stats/types.ts` and is pinned by
  `supabase/tests/stats_snapshot.test.sql`; change the SQL, the type and the test together.
  A trigger on `stats_snapshots` (`stats_snapshots_drop_hidden`) removes calls in
  `hidden_callsigns` from `topActivators` and `rbn.topStations`, so a top list can hold fewer than eight.
- `countries` (the world map) comes from `country_daily_spots`, which `rollup_country_day` fills once
  per day by `cty_lookup` on each distinct call as spotted, never per refresh. DXCC entities map to
  ISO alpha-2 only in `cty_entity_countries`; `web/src/stats/countries.test.ts` checks it covers
  every entity of the cty.dat fixture, so a new entity needs a row there.
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
  list ("any source") does not include it. The rule lives in `source_matches`. An RBN spot passes only an AND group of rules
  that names stations (a `callsign` or `group` rule with op `is`, `rules_name_stations`).
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
- Stock MUI theme with both `colorSchemes`; the account menu's Theme switch picks light, dark or
  automatic (`useColorScheme`, stored by MUI in localStorage). Automatic follows `prefers-color-scheme`. MUI 9: `Grid` uses `size`,
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

## Testing

- Both suites gate at 80% in CI. The Deno gate (`scripts/check-coverage.ts`) checks
  `supabase/functions` and `relay/` separately and also lists any module no test imports, since
  `deno coverage` silently omits those.
- Deno excludes modules whose names end in `test.ts` from coverage, so never name a source file
  `*_test.ts` (hence `handlers/test_delivery.ts` for the send-test function).
- Web component tests render through `web/src/test/render.tsx` (theme, MemoryRouter, stub App
  context) and `vi.mock("../lib/api")` with explicit factories. `setMobile(true)` from
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
  partition mid-build; that lock does not block inserts. `spot_matches` lets an RBN spot pass only an
  AND group of rules that names stations (`rules_name_stations`); keep that guard if the predicate
  changes, and keep `watched_among` reading only positive callsign and group rules.
- Be polite: exactly one machine (`fly scale count 1`), reconnect backoff never below 30 s, no
  tests that connect to RBN. Tests use the captured fixture or a local TCP server.
- Merges to main deploy the relay through Fly's GitHub integration (set up in the Fly dashboard,
  not in this repo); a merge that changes `relay/` or `_shared/*.ts` ships to production. Never run
  `fly deploy` or `fly secrets set` yourself unless asked.
- APRS-IS (`aprsFeed`, off until `APRS_LOGIN_CALL` is set) is the full feed on port 10152 with a
  receive-only login and no filter; never add one. It is plain TCP (`telnet: false`,
  `TcpLineDecoder`), not telnet. Packets go only to `aprs_packets` (partitions from
  `create_aprs_packets_partition`, kept two days, retired by `maintain_aprs_packets` once archived);
  never send them to `raw_spots`, matching, `spot_stream` or the callsign rollups. The Stats refresh
  rolls them up per day (`rollup_aprs_day` into `aprs_daily_*`), and `maintain_aprs_packets` keeps a
  day in the Stats window until that rollup is final; older days drop without it. `raw_spots`' source check
  leaves `aprs` out on purpose. Its archive runs in its own cron job (`archive-aprs`, body
  `{"sources": ["aprs"]}`); keep it out of `ARCHIVE_ORDER`.
- The relay also runs the weekly FCC license load (`relay/licenses.ts`, `relay/zip.ts`): it reads
  `l_amat.zip` by HTTP Range and stages HD/EN/AM rows through `load-licenses`. Record parsing is
  `_shared/uls.ts`; the join and the swap into `callsign_licenses` are SQL
  (`apply_license_loads`, pg_cron), because the swap outlasts the API's 8 s statement timeout.
  Never stage or store ULS address, city, ZIP, PO box, phone, email or FRN fields. No test
  downloads from the FCC; tests build a zip and serve it locally (`relay/__tests__/zip_server.ts`).

## Archive rules

- Slice length lives only in `archive_slice_minutes(source)` (APRS-IS 5 minutes, RBN 10, others 60). A slice's
  rows, columns and order are chosen in SQL (`archive_columns`, column arrays), never in
  TypeScript; the `archive` function only encodes Parquet, uploads and logs. One file per slice at
  `<source>/year=YYYY/month=MM/day=DD/HHMM.parquet`. A column change goes in `archive_columns` and
  `ARCHIVE_SCHEMAS` (`_shared/archive.ts`) together; a test compares them.
- A slice is logged in `archive_log` only after its upload succeeds. Nothing leaves `rbn_spots`
  unless `rbn_day_archived` finds every slice of the day logged with a matching count; `raw_spots` is
  never pruned by the archive.
- The archive bucket is Backblaze B2, reached only through `_shared/s3.ts` (SigV4, no dependency)
  from the `archive` function, configured by the `LONGLINES_ARCHIVE_S3_*` secrets. Its key is
  restricted to the bucket with `writeFiles` only; B2 keys never go in the web app, the relay or
  any other function. Locally the stack's Storage S3 endpoint stands in, so keep one code path.

## Callsign rollup rules

- Profiles and rollups read `spot_stream`, never a source table by name. A source writing
  `raw_spots` needs nothing; a new firehose table needs one `union all` arm in the view.
- `rollup_callsign_day` runs exactly once per completed UTC day (its marker goes in first):
  references, seen and variants are running totals. Never delete a marker to re-roll a day. It
  refuses a day it cannot roll up whole (no cty.dat, RBN rows already retired) rather than mark it.
- The rollups run in their own hourly cron job (`rollup-callsign-days`), never inside
  `maintain_rbn_spots`, so a slow rollup cannot hold partition locks or undo retention.
- Group a day by `callsign`/`spotter` before calling `base_callsign()` or `cty_lookup()`; the
  RBN arm computes base calls per row. Profiles and the Stats mode chart both use
  `mode_bucket(mode, mode_family)`; never write the CASE out again.
- `base_callsign()` output is now permanent in the rollups: changing it splits history. If it
  must change, the same migration rewrites `raw_spots.base_callsign`, runs
  `reindex index rbn_spots_base_callsign_time_idx` (Postgres never rebuilds an expression index when
  its function changes), fixes any `hidden_callsigns` row its check would now reject and calls
  `rebase_callsign_group_members()`, since `callsign_group_members` stores base calls.

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
- The header flag comes from `web/src/profile/flags.ts`, a table keyed by cty.dat entity name
  (cty.dat has no ISO codes); `flags.test.ts` fails when the cty.dat fixture gains an entity the
  table lacks. Flags are flag-icons SVGs served as separate assets (`assetsInlineLimit` in
  `web/vite.config.ts` keeps them out of the bundle); never import the package's CSS.
- Every callsign the web shows links to `/call/<base>`, with the base call coming from SQL:
  `topActivators[].base` in the Stats payload, `rbn.topStations` ranked by base call, the
  profile's own `callsign`. The web never works out a base call. A link built from a call as typed
  (`lookupPath`) works only because the profile page swaps it for the base the profile returns.

## Band map rules

- `/band-map` is public (`PublicRoute`). Its data comes only from the `band-map` function, which
  calls `cached_band_map()`: one shared row in `band_map_cache`, rebuilt at most every 30 seconds
  under an advisory lock. Never query `raw_spots` per visitor, add a cron job for it, or use
  Realtime. The client polls every 30 seconds, and only while the tab is visible.
- POTA, SOTAwatch and DX Cluster only. Never RBN, APRS-IS or `raw_payload`. One row per
  `base_callsign` per band, and hidden calls are left out. The shape is `BandMapPayload`
  (`web/src/bandmap/types.ts`), pinned by `supabase/tests/band_map.test.sql`; change the SQL, the
  type and the test together.
- Strips are stock MUI X `ScatterChart`s with `ChartsReferenceLine` segments: no custom SVG,
  absolute positioning, canvas, label layout or Pro components (so no zoom). Keep the Voronoi
  click. A crowd (`CROWD_DIVISOR` in `model.ts`) opens the "N stations near" menu. The source
  chips filter on the client and never refetch.
- Source colors and lanes live in `SOURCES` (`model.ts`): DX Cluster `success` at the bottom,
  POTA `primary` in the middle, SOTA `secondary` on top, all from `theme.palette`, never hex. The
  band plan (`web/src/lib/bandplan.ts`) is for display only and never decides a spot's mode.

## Callsign group rules

- Membership is live: a `group` rule stores group ids, never a copy of the calls, so editing a
  group changes every subscription that uses it. Never copy members into a `callsign` rule.
- Members are base calls (`base_callsign()`, enforced by a check constraint), at most 1,000 per
  group. `save_callsign_group` is the only write path and `normalize_group_callsigns` the only
  normaliser; the web never works out a base call or enforces the cap itself.
- A `group is` rule whose groups are all empty passes nothing; never let it fall back to "any station".
- `delete_callsign_group` refuses a group any subscription uses, as with destinations; keep the
  guard and keep Delete disabled in the UI while `subscription_count > 0`.
- `preview_subscription` keeps only the caller's own group ids before matching and counting, so it
  cannot probe another user's groups. Keep that filter on any RPC that takes group ids.
- Membership and station counts are resolved only in SQL (`group_matches`, `watched_among`,
  `station_count` from the preview). The web shows group names and SQL's numbers and never tests
  a call against a group's members.

## Subscription rules

- A subscription's filter is `subscriptions.rules`: AND groups, ORed (`[[A, B], [C]]` is "A and B or
  C"; And binds tighter). Each rule is `{field, op, values}`; the fields and ops are listed at the top
  of `20261014000500_subscription_rules.sql` and in `docs/API.md`. `[]` passes every spot. The
  source stays its own column (`sources`), not a rule.
- `normalize_subscription_rules` is the only validator and normaliser; `save_subscription` and
  `preview_subscription` both go through it. `group_ids` is derived from the rules (every group
  named, `is` or `is_not`) and written only by `save_subscription`; never set it elsewhere.
- Matching is `rule_matches` per rule inside `spot_matches`; never evaluate rules in TypeScript.
  The web's `model.ts` only converts builder rows to rules (`rulesOf` drops rows without values) and
  mirrors the RBN guard as a form check (`needsCallsign`).
- `save_subscription` refuses the old filter keys (`bands`, `modes`, `callsigns`, `reference`,
  `group_ids`) and keeps stored rules when `rules` is left out, so a request can't silently widen a
  subscription to every spot.

## Management API rules

- The `api` function (`docs/API.md`, `_shared/handlers/api.ts`) only routes, checks shapes and maps
  errors. Behavior goes in SQL: `api_call` acts as the token's owner and calls the same RPCs the
  web app calls. A new operation goes in `api_call`'s allowlist and the route table together, with
  the same scope (`api_routes.test.ts` compares them); only `GET` routes are read scope.
- `api_call` sets the request's JWT claims to the owner and must put them back before returning.
  Never call it, or `set_config('request.jwt.claim...')`, anywhere else.
- `api_tokens.token_hash` is never granted, and plaintext tokens come back only from
  `create_api_token` / `rotate_api_token`. Never log a token or its hash.
- The `api` function keeps `verify_jwt = false` and never imports `isServiceRole`.
- API responses never include `destinations.url` or `signing_secret`, except the one-time return
  from create and rotate. Shapes come from `api_destination_json` / `api_subscription_json`.
- Copy for the API tokens page (`web/src/tokens/`) follows Brad's API tokens mockup, which
  isn't in `docs/ui-mock.html` yet.

## Push rules

The design is `docs/superpowers/specs/2026-10-13-push-notifications-design.md`, as amended for
canvas page 5 (its "Amendment, 2026-10-15" section wins where the two disagree). The amendment's
Copy, then the spec's Copy, not `docs/ui-mock.html`, is the copy source for push and install
screens and for notification text.

- An account has many `push` destinations. Devices belong to the account (`push_devices`); each
  push destination picks some of them through `push_destination_devices`, and only its members
  with `blocked_at is null` receive it. A push destination has no URL
  (`check ((type = 'push') = (url is null))`).
- Notification text comes from the destination's templates, rendered by `render_push_template` in
  SQL: `claim_deliveries` hands the worker `push_title`, `push_body` and `push_url`, and
  `preview_push_notification` calls the same function, so the preview and the delivered text agree.
  Never interpolate a template or build a tap URL in TypeScript. Quiet hours are decided in SQL too.
- Device endpoints must be https on an allowlisted push-service host: `fcm.googleapis.com`,
  `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`. The list lives
  in SQL (`validate_push_endpoint`, checked by `register_push_device`) and in
  `_shared/delivery/urlsafety.ts` (checked before every POST); change both together. It is the SSRF
  guard: the worker POSTs to a URL a client chose.
- `push_devices` is service-role only (RLS on, no policies). Endpoints, `p256dh` and `auth` are
  capability secrets and never appear in a client read. `list_push_devices` and
  `get_push_destination` return ids, names, descriptors and status only, and only
  `claim_deliveries` hands keys to the worker. The web never reads an endpoint back; the browser
  keeps its own last endpoint in `localStorage` for `report_push_device_blocked`.
- `_shared/delivery/webpush.ts` (VAPID and RFC 8291 `aes128gcm`) uses WebCrypto only and has no
  dependency. Its tests pin the RFC 8291 Appendix A vector byte for byte. If the vector fails, fix
  the code, never the vector.
- `format.ts` (`pushNotifications`) only shapes what SQL rendered: tags, actions,
  `silent`/`renotify`, and the 3-then-summary limit per run. The service worker only displays it.
- `web/src/pwa/push.ts` is the only module that touches `PushManager`, `Notification` and
  `PushSubscription`; `Notification.requestPermission()` is the first statement of `enablePush()`,
  before any `await`. `web/src/pwa/register.ts` is the only module that calls
  `navigator.serviceWorker.register`.
- The service worker (`web/src/pwa/sw.ts`, emitted unhashed as `/sw.js` with no `import`
  statements) handles `push`, `notificationclick` and `pushsubscriptionchange` only. It never
  imports app code and never holds a token: on `pushsubscriptionchange` it re-subscribes and
  posts a message to open windows, which re-register. It has no `fetch` handler and caches
  nothing, and `/sw.js` is served `Cache-Control: no-cache`, so a deploy can't strand a stale
  bundle.
- The VAPID private key and subject live only in Edge Function env (`LONGLINES_VAPID_*`). The
  public key is the one new `define` entry in `web/vite.config.ts` (`VITE_VAPID_PUBLIC_KEY`); never
  widen `envPrefix`.
- A gone subscription (404/410) is pruned, not counted as a failure; a 429 delays like any other
  rate limit. Zero deliverable devices is a failure, so a push destination nobody can receive goes
  `failing`. A spot skipped for quiet hours ("Don't send") is marked sent, never retried or
  counted as a failure.

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
- New functions start executable by `public`; `revoke all ... from public` leaves only
  `service_role` (default privileges, `20261012000120`), then grant clients explicitly. New
  functions pin `search_path` except one-expression SQL helpers that must stay inlinable.
  `supabase/tests/advisor.test.sql` lists the functions clients may call and the unpinned
  helpers, and fails on anything new.
- `supabase/seed.sql` is a synthetic week relative to `now()` (made-up calls ending in `S`) for
  preview branches and local resets; it ends with a stats refresh. pgTAP suites that count rows
  delete from those tables first, inside their rolled-back transaction, so they pass seeded or not.
- Be polite to upstreams: User-Agent on every fetch, no polling faster than the cron schedule,
  no tests that hit live APIs.
- Spotter countries come from `cty_lookup(call)` in SQL over the weekly cty.dat import
  (`import-cty`); TypeScript only parses the file (`_shared/cty.ts`) and never resolves a call.
