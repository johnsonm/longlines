# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Long Lines ingests ham radio spots from POTA, SOTAwatch, WWFF, DX Cluster and the Reverse Beacon
Network (plus APRS-IS packets) into Supabase. Phase 1 was ingest-to-storage only; the scope
exclusions in `docs/ARCHITECTURE.md` and the original spec are deliberate. Do not add auth, RLS,
UI, consumers, notifications, cross-source dedup, or new sources without being asked.

Everything runs on Supabase: Postgres (pg_cron, pg_net, pgmq) plus Deno Edge Functions in
strict TypeScript. The exceptions are two Deno processes on Fly.io: `relay/`, which holds the
inbound telnet streams (see "Relay rules"), and `sender/`, which sends outbound deliveries (see
"Sender rules"). No JavaScript files, no `any` without a justifying comment, no new runtime
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
cd web && npm run sender               # the outbound sender against the local stack (opt in; not part of dev:full)
supabase gen types typescript --local > web/src/lib/database.types.ts   # after schema changes

SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts   # the sender's RPC adapter against the local db (CI does this)

supabase db push                       # hosted: apply migrations
supabase functions deploy ingest-pota  # hosted: deploy one function
psql "$DATABASE_URL" -f scripts/setup-sender-role.sql   # hosted, once: the sender role's password (edit the placeholder first)

docker build -f relay/Dockerfile .     # relay image; build context is the repo root
docker build -f sender/Dockerfile .    # sender image, likewise
fly deploy --config relay/fly.toml --ha=false    # hosted relay by hand; normally Fly's GitHub integration (config path relay/fly.toml)
fly deploy --config sender/fly.toml --ha=false   # hosted sender by hand, likewise (config path sender/fly.toml)
```

Local invocation: `curl -X POST http://127.0.0.1:54321/functions/v1/ingest-pota -H "Authorization: Bearer <service_role key printed by supabase start>"`.

## Architecture

- `supabase/functions/_shared/ingest.ts` is the orchestrator; `ingest-pota/index.ts`,
  `ingest-sotawatch/index.ts` and `ingest-wwff/index.ts` are three-line shells around
  `serve_ingest.ts`.
  The other entrypoints are `Deno.serve` shells around `_shared/handlers/*.ts`, which take their
  clients and sender as arguments so tests can pass fakes (`__tests__/fake_supabase.ts`). Behavior changes go in
  `_shared`, never in the entrypoints.
- Every function directory needs its own `deno.json`: `supabase functions deploy` bundles with it
  as the import map, not the root one. `__tests__/function_config.test.ts` fails CI without it.
- Source adapters (`pota.ts`, `sotawatch.ts`, `wwff.ts`) implement `SourceAdapter` from `types.ts`:
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
  per source is fixed (see `ARCHITECTURE.md`; WWFF's is `spot_time, activator, reference,
  frequency_khz, mode, remarks`); changing it would make every existing spot look new on the next
  run.
- Cron jobs read the project URL and service-role key from Vault
  (`scripts/setup-db-settings.sql` creates them once). Migrations never contain secrets.

## CI

`.github/workflows/ci.yml` runs on every PR and push to main: Deno fmt/lint/check/test, then
`supabase db start` + `supabase db lint` + `scripts/smoke-test.sql` on a fresh Postgres.
Migrations already applied to the hosted project must not be edited; add a new migration instead
(see `20261005000009_*`). Fly's GitHub integration (configured in the Fly dashboard, one binding
per app with its own `fly.toml`) deploys the relay and the sender on pushes to main; nothing else
deploys automatically.

## Phase 2 schema rules

- Client writes to `destinations` and `subscriptions` go through RPCs (`create_destination`,
  `rotate_signing_secret`, `save_subscription`, `delete_subscription`). Direct insert/update is
  revoked on purpose; the only direct client write is `subscriptions.enabled`.
- `destinations.url` and `signing_secret` are excluded from the column grant. Never add them to a
  view or RPC result except the one-time return from `create_destination`/`rotate_signing_secret`
  (and `save_webhook_destination` when it creates). `duplicate_destination` copies a webhook's
  secret to the new row without returning it.
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
  renders in `AppShell` either way (signed out, the account sections are disabled). RBN figures come from the
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
- WWFF is a peer of POTA and SOTA: wherever the payload or the page has a POTA and a SOTA figure
  (totals, `daily`/`hourly`/`bands`/`countries` keys, top lists, `in_window`, copy), it has a WWFF
  one too. `wwffPrograms` (top 10 by the reference prefix before `-`) is the counterpart of
  `sotaAssociations`. Snapshots older than WWFF lack its keys; the page reads them with `?? 0` /
  `?? []`.
- The Stats page is deliberately fixed: no controls beyond tooltips, one request per hour of use
  (`web/src/stats/cache.ts` keeps a snapshot until the next refresh is due; never poll).
  Do not add filters, date pickers, sorting or MUI X Pro components.

## Delivery rules

- Outbound delivery is the sender (`sender/`, "Sender rules"), not an Edge Function. The Edge
  `deliver` function is gone: the cutover migration (`20261015001200`) unscheduled its cron job
  and took the pg_net kick out of `match_pending_spots`, which now does `pg_notify('deliveries', '')`
  when it created deliveries, and the cleanup (`20261015001400`) deleted the function, its handler
  and its RPCs `delay_deliveries` and `mark_deliveries_dropped`. Never add a `net.http_post` or a
  delivery Edge Function back.
- `archive` and `import-cty` authorize with `isServiceRole` (`_shared/auth.ts`):
  the runtime's `SUPABASE_SERVICE_ROLE_KEY` (now the `sb_secret_` key) or a JWT with
  `role: service_role`, which is what pg_cron sends from Vault. The JWT is trusted only because the
  gateway verified it, so both functions keep `verify_jwt = true` in `config.toml`.

- Matching lives in SQL (`spot_matches`, `match_pending_spots`); never re-implement the predicate in
  TypeScript. The preview RPC and the matcher must stay on the same function.
- A subscription is live only while `enabled` and linked to at least one destination. Saving with
  none is allowed; `match_pending_spots` and `watched_among` both skip it, and `enabled` is kept
  so it starts once a destination is added. Keep that check in both if either changes.
- DX Cluster and WWFF spots match only subscriptions whose `sources` lists `dxcluster` / `wwff`;
  an empty sources list ("any source") includes neither (WWFF overlaps POTA heavily and there is no
  cross-source dedup). The rule lives in `source_matches`. An RBN spot passes only an AND group of
  rules that names stations (a `callsign` or `group` rule with op `is`, `rules_name_stations`).
- The loop is `_shared/delivery/run.ts` (`runDeliveryBatch` over a `DeliveryRpc`), run only by
  the sender. It talks to the database only through `claim_deliveries`,
  `mark_deliveries_sent`, `mark_deliveries_failed`, `throttle_destination`, `prune_push_devices`
  and `record_push_results`, so delivery rows, queue messages and destination health change
  atomically. One `mark_deliveries_sent` per cycle, before the throttles (the ack clears
  `throttled_until`).
- Policy lives in SQL. `claim_deliveries` is rate-aware per destination and newest first, skips
  paused and throttled destinations, and expires old rows (`dropped_at`) before claiming; its knobs
  are `destination_budget`, `destination_claim_interval` (a schedule in `claim_due_at`, claimable
  half an interval early, so poll-aligned claims average one per interval),
  `destination_claim_max`, `destination_throttle_seconds`,
  `destination_max_age`, `destination_batch_full(type)` (Discord 10, webhook 50),
  `webhook_claim_max(batch_seconds)` (5 for one request per spot, the webhook's per-claim cap),
  `webhook_retry_delay`, `webhook_retry_max_attempts`, `webhook_retries_exhausted` and
  `webhook_pause_spacing`, plus the Discord and webhook batch hold (`batch_seconds` in
  `discord_destination_settings` / `webhook_destination_settings`).
  Never cap, order, age-check or expire deliveries in TypeScript; `DISCORD_MESSAGES_PER_RUN` is a
  safety net the budget and the claim interval keep unreachable. The claim's signature and result columns stay as they are: new
  policy is a column or a knob function, never an argument.
- Formatting, signing and URL safety are pure modules under `_shared/delivery/` with tests;
  `send.ts` is the only place that sends to destinations: `fetch` for Discord and push, and
  `pinned_http.ts` (hand-rolled HTTP/1.1) for webhooks. `allowInsecure` is for tests and local
  development only.
- A webhook connects to an address `assertSafeResolvedHost` checked, never to a fresh lookup of
  its name: `fetch` resolves again, which DNS rebinding can point at an internal address.
- Rate limits are not failures: a 429 from any type, or the Discord cap, calls
  `throttle_destination` (with `Retry-After` when there is one, else null so SQL picks the level's
  backoff), which sets `throttled_until`, `throttle_level` and the messages' vt together and never
  touches `consecutive_failures`. Never delay or drop a message outside those RPCs: the claim's
  expiry sweep is the only thing that drops a delivery. `ready` in `claim_deliveries` applies the
  sweep's age predicate too, so a row past its age is never claimed when more than the sweep's
  batch expire at once; change the two together. The same goes for a webhook row whose attempts
  are used up: the sweep and `ready` share `webhook_retries_exhausted`.
- Retries for webhooks are SQL's: `mark_deliveries_failed` sets a webhook row's vt from its
  destination's `retry_policy` (`webhook_retry_delay`), ignoring `p_delay_seconds` (TypeScript's
  `backoffSeconds`, still used for Discord and push), and an exhausted row gets vt now so the next
  sweep drops it. Only rows that were in a request count an attempt: `sendWebhook` reports
  `SendResult.attempted` and `run.ts` marks failed only `batch.slice(sent, attempted)`; the rest
  wait out the claim's `p_vt` (`DestinationResult.unattempted`).
- A webhook pauses itself, never through `health`: when its `pause_after_failures` is set,
  `mark_deliveries_failed` counts failures toward it at most once per `webhook_pause_spacing()`
  (`pause_failures`, `pause_failure_at`; a success since restarts the count) and on reaching it
  sets `enabled = false` and `auto_disabled_at`, and makes every queued row of it visible (vt 0,
  rows in retry backoff included). While `auto_disabled_at` is set the claim's unwanted sweep drops
  the queue with `dropped_at`, so nothing is left to deliver on resume; `update_destination`
  turning it on clears it, so the editor sends Enabled only when the switch changed from what it
  loaded (null otherwise) and a pause since load is never resumed silently. `webhook_default_settings()` sets the pause to 20 (`20261018000400`,
  shipped with the editor that shows and undoes a pause); backfilled webhooks keep it null.
- The webhook body is rendered in SQL (`webhook_spot_fields`, ordered `[{key, value}]` pairs in
  the claim's `spot.webhook_fields`); `format.ts` only builds the object in that order and never
  formats, converts or names a value. A row without the keys gets the legacy `{deliveries}` body
  (`webhookPayloads`), which goes once the migration is hosted. Extra header values live in Vault
  and leave it only in `claim_deliveries`, `webhook_test_delivery` and `duplicate_destination`.
  The reserved header list is in `webhook_header_name_valid` and `WEBHOOK_RESERVED_HEADERS`
  (`format.ts`); change both together.
- First name and Last name (push, Discord and webhook fields) are the spotted call's license names,
  read only through `spot_license_name` (by base call, none for a club or a call in
  `hidden_callsigns`), never the spotter's. The FCC load stages them apart from the joined `name`
  (`_shared/uls.ts`, `fcc_uls_en`); never split `name` to get them.
- Nothing in the app sets `destinations.health = 'paused'`; it is an operator tool, and the claim
  drops a paused destination's queued rows as unwanted, like `enabled = false`. To hold a queue
  and resume it, set `throttled_until`.

## Discord rules

The design is `docs/superpowers/specs/2026-10-18-discord-destination-design.md` (canvas page 8);
its Copy section is the copy source for the Discord editor.

- A Discord message is an ordered pick of fields, never a template or free text. Settings live in
  `discord_destination_settings` (RLS on, no policies, no client grants) and are written only by
  `save_discord_destination`, validated by `validate_discord_settings`. Fields are push's minus
  Comment (`discord_fields()`).
- SQL renders everything in `discord_spot_fields`: `claim_deliveries` adds its nine `discord_*`
  keys to the spot jsonb and the settings as `discord` to the destination jsonb;
  `preview_discord_message` and `discord_test_delivery` call the same function. `format.ts` only
  shapes those keys into embeds or `content`; never join, format or escape field values in TypeScript.
- Feed values are untrusted markup: callsigns and spotters from DX Cluster are any run of
  non-space characters. Every value is escaped for Discord markdown once, in
  `discord_field_values` (`discord_escape`, which also escapes indented list markers); a callsign
  that is not URL-safe gets no profile link. Push's
  `render_push_field` stays unescaped (notifications are plain text).
- Every Discord message carries `allowed_mentions: {parse: []}`, legacy and test paths included.
  `flags: 4` (SUPPRESS_EMBEDS) is only for plain style; on a card it would hide the card.
- Pacing is SQL's: the batch hold and the claim interval decide when spots go, the budget and
  `destination_claim_max` (50) how many. `discordBatches` groups spots only to stay within
  `DISCORD_MESSAGES_PER_CLAIM` and packs cards in order within Discord's 6,000-character message
  limit (only cards over about 600 characters make a sixth message); it never drops or delays one.
- Profile links are absolute through `app_site_url()`; never hard-code the host elsewhere.
- The web editor (`web/src/destinations/Discord*`) takes its copy from the spec's Copy section,
  not `docs/ui-mock.html`.
- `DiscordMockup` renders only SQL's keys from `preview_discord_message` and never joins fields.
  The escaped values (title, description, grid values, plain line) go through
  `discordMarkdown.ts`, which draws only bold, masked links (http(s) targets only) and backslash
  escapes (a backslash before ASCII punctuation is dropped and the character is literal), as
  Discord does, and matches link text by Discord's grammar, which ignores escapes; its tests pin real `preview_discord_message` output for hostile spots.
- The editor's default settings are pinned to `discord_default_settings()` by
  `discordModel.test.ts`; change the SQL and `discordModel.ts` together.
- The field picker is the generic `FieldPicker`, shared with push's notification content card
  and the webhook Payload card; never fork it per destination type.

## Webhook rules

The design is `docs/superpowers/specs/2026-10-18-webhook-destination-design.md` (canvas page 7);
its Copy section is the copy source for the webhook editor and the "Destination added" dialog.
The delivery side (retries, pause, attempts, rendering, Vault) is in "Delivery rules".

- A webhook body is an ordered pick of fields with fixed key names, never a template or free
  text. Settings live in `webhook_destination_settings` (RLS on, no policies, no client grants,
  a row made by trigger) and are written only by `save_webhook_destination`, validated by
  `validate_webhook_settings`. Extra headers are rows of `webhook_destination_headers` whose
  values are Vault secrets, written only by `set_webhook_headers` (at most 10; an item without a
  value keeps the stored one by name, a renamed header needs one). Clients and the API only ever
  get header names; the editor never receives a value, a URL or the secret.
- SQL names and renders every key and value (`webhook_spot_fields` pairs). The preview
  (`preview_webhook_request`) and the test (`webhook_test_delivery`) call the same renderer and
  build with `json`, not `jsonb`, so key order survives; the editor pretty-prints the parsed body
  as it comes. `webhookKey` in `webhookModel.ts` names keys for display only.
- Pacing and policy are SQL's knobs: the batch hold (`batch_seconds`, released early at
  `destination_batch_full('webhook')`, 50), `webhook_claim_max` (5 a claim for one request per
  spot), the retry policy (`webhook_retry_delay`, `webhook_retry_max_attempts`, and
  `webhook_retries_exhausted` shared by the sweep and `ready`) and the spaced pause count. A pause
  is `enabled = false` plus `auto_disabled_at`, never `health`; the card's chip says Paused and the
  editor says when, whatever the pause switch now says.
- The reserved header list is in `webhook_header_name_valid` and `WEBHOOK_RESERVED_HEADERS`;
  change both together.
- The secret is shown once, from `save_webhook_destination` on create and `rotate_signing_secret`,
  in `SigningSecretDialog` (Done gated by its checkbox, no backdrop or Escape close). Never show
  any part of it again; the editor shows `whsec_••••••••` and `secret_rotated_at`.
- The editor's default settings are pinned to `webhook_default_settings()` by
  `webhookModel.test.ts`; change the SQL and `webhookModel.ts` together. The field list is the
  generic `FieldPicker` with `keyOf` and `addAs="chips"`; never fork it.

## Web app rules

- `web/src/lib/api.ts` is the only module that touches supabase-js; pages call its typed
  functions. Edge Functions are called with plain `fetch` there so non-2xx bodies surface as
  messages.
- Stock MUI theme with both `colorSchemes`; the account menu's Theme switch (signed out, its own app bar
  menu) picks light, dark or automatic (`useColorScheme`, stored by MUI in localStorage). Automatic follows `prefers-color-scheme`. MUI 9: `Grid` uses `size`,
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
  `docs/superpowers/specs/2026-10-14-source-catalog-design.md`, with "connection" for
  "subscription" (see "Subscription rules").
- Rates come only from the stats snapshot's `hourly` series through `useStats()` (`rates.ts`);
  never poll the snapshot or add a rates RPC. A new source with rates needs a key in
  `refresh_stats_snapshot_at`'s `daily`/`hourly`, the `StatsPayload` type and its pgTAP test.
- The Schema and Example spot cards describe the delivered spot as the webhook field catalog
  with its default keys (`docs/WEBHOOKS.md`): `COMMON_FIELDS` follows `webhook_fields()` order with
  snake_case keys, and each source's `example` is its default `spot` object. A field added to the
  catalog goes in `COMMON_FIELDS` too.

## Testing

- Both suites gate at 80% in CI. The Deno gate (`scripts/check-coverage.ts`) checks
  `supabase/functions`, `relay/` and `sender/` separately and also lists any module no test
  imports, since `deno coverage` silently omits those.
- Deno excludes modules whose names end in `test.ts` from coverage, so never name a source file
  `*_test.ts` (hence `handlers/test_delivery.ts` for the send-test function).
- Never name a file after a Windows device (`nul`, `con`, `prn`, `aux`, `com1`, `lpt1`, with any
  extension): the Supabase Preview check refuses to clone the repo (hence `strip_nul.ts`).
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

## Sender rules

- `sender/` is the outbound delivery process on Fly.io (app `longlines-sender`), the counterpart
  of `relay/`. `sender/main.ts` is only the process shell; behavior goes in `sender/sender.ts`,
  `sender/db.ts` (the only module that imports postgres.js) and the shared loop
  `_shared/delivery/run.ts`, which tests run with fakes and a local `Deno.serve` receiver.
- It holds `SENDER_DATABASE_URL` for the `delivery_sender` role (through the Supavisor session
  pooler, TLS) and the VAPID triple, never a Supabase API key. Its whole database surface is the
  RPC allowlist in `sender/db.ts` (`SENDER_RPCS`), the grants in `20261015000200` /
  `20261015000400` and the list in `sender_role.test.sql`; a new RPC changes all three in one PR,
  and the role gets nothing on tables or `pgmq`.
- Exactly one machine (`fly scale count 1 -a longlines-sender`): the claim is a serial consumer
  whose marks land before its next claim. A second machine means duplicates and split counts;
  a per-destination lease comes before any second machine.
- Per-destination caps are per minute, in SQL (`destination_budget`), never per claim or per
  poll in TypeScript. The sender polls every `SENDER_POLL_MS` (5 s, floor 1 s) and re-claims at
  once after a full batch; LISTEN on the matcher's `deliveries` channel is planned, not done.
- The watchdog exits 1 after `SENDER_STALE_MS` without progress (a successful claim, a finished
  send or a successful bookkeeping RPC, reported through `runDeliveryBatch`'s `onProgress`), never
  since the last finished cycle, because a long healthy cycle killed before its ack re-sends the
  batch. Fly restarts only a machine whose process exits; a `/healthz` 503 alone restarts nothing.
  The repeatable bookkeeping RPCs (`mark_deliveries_sent`, `prune_push_devices`,
  `record_push_results`) are retried within the cycle (`BOOKKEEPING_RETRY_MS`); the counting ones
  (`mark_deliveries_failed`, `throttle_destination`) are tried once. A failed claim or mark is then
  logged and the next claim backs off, never an exit. Exit 1 otherwise means bad config, a pool
  that cannot open within `OPEN_DEADLINE_MS` (the start-up probe retries with the claim backoff and
  times out after `PROBE_TIMEOUT_MS`), or an unhandled rejection.
- Knobs are env variables read in `sender/config.ts` (`SENDER_POLL_MS`, `SENDER_CONCURRENCY`,
  `SENDER_STALE_MS`, `SENDER_STATS_MS`, `SENDER_HEALTH_PORT`, `SENDER_DATABASE_CA`).
  `SENDER_STALE_MS` must exceed max(`SENDER_POLL_MS`, `RETRY_MAX_MS`) + `STALE_MARGIN_MS`, and
  every ms knob is capped at `MAX_INTERVAL_MS` (one hour). The Dockerfile's `--allow-env` must
  name every variable the sender reads (`sender/__tests__/modules.test.ts`), and `deno.json`'s test
  permissions mirror it. `LONGLINES_ALLOW_INSECURE_DESTINATIONS` is honoured only with a local
  database host.
- Tests never touch a hosted database: `db.test.ts` runs its RPC half only with
  `SENDER_TEST_DATABASE_URL` pointing at the local stack and skips it otherwise. Never run
  `fly deploy` or `fly secrets set` yourself unless asked; a merge to main deploys the sender, so
  a merge that changes `sender/` or `_shared/delivery/*` ships to production.
- The app lives on its own Fly network (`--network sender`, fixed at creation) and the hostname
  suffix denylist (`.internal`, `.flycast`, `.local`, `.localdomain`, `.home.arpa`, `.arpa`) is in
  both `validate_destination_url` and `urlsafety.ts`; change both together. So are the private
  address ranges (`is_private_host` and `isPrivateIp`, including IPv4 embedded in mapped,
  compatible, NAT64 and 6to4 addresses); both refuse URL userinfo, and SQL refuses a numeric host
  that is not a canonical dotted quad.
- TLS to the pooler is verified only with `SENDER_DATABASE_CA` (PEM); `sslmode=verify-full` or
  `verify-ca` in the URL without it is refused at start. Never fabricate or commit a CA.

## Archive rules

- Slice length lives only in `archive_slice_minutes(source)` (APRS-IS 5 minutes, RBN 10; POTA,
  SOTAwatch, DX Cluster and WWFF 60). `ARCHIVE_ORDER` is pota, sotawatch, dxcluster, wwff, rbn.
  A slice's rows, columns and order are chosen in SQL (`archive_columns`, column arrays), never in
  TypeScript; the `archive` function only encodes Parquet, uploads and logs. One file per slice at
  `<source>/year=YYYY/month=MM/day=DD/HHMM.parquet`. A column change goes in `archive_columns` and
  `ARCHIVE_SCHEMAS` (`_shared/archive.ts`) together; a test compares them.
- A slice is logged in `archive_log` only after its upload succeeds. Nothing leaves `rbn_spots`
  unless `rbn_day_archived` finds every slice of the day logged with a matching count; `raw_spots` is
  never pruned by the archive. `rbn_day_archived` / `aprs_day_archived` reset a log row only when
  the database has more rows than it; a day with no partition and a logged slice holding more rows
  than the database is retired, and its late rows are deleted, never archived again.
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
  Retired is `rbn_day_retired` (some slice of the day logged with more rows than the database
  holds, the per-slice test `rbn_day_archived` uses), shared by the roll-up, `fill_callsign_days`,
  `maintain_rbn_spots` and the status view; never decide "retired" from the partition's existence
  or from zero rows, since a late line would mask a retired day. `without_rbn` means RBN spots
  counted < RBN rows archived, the archive total read before the pass. The first day is
  `first_rollup_day()` (the earlier of the first marker and the first `raw_spots` row with
  `source <> 'rbn'`); never `min(spot_time)` over `spot_stream` while either exists.
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
- `callsign_days` (base, UTC day, source: spots, sorted `modes[]` and `bands[]`) is day grain
  forever and never compacted; heard role only; it stores the canonical modes `modes.ts` wrote
  (readers group `usb`/`lsb`; no SQL mode grouping function until a consumer exists). It is filled
  by `rollup_callsign_day` in the marker's transaction, with `on conflict do nothing` so a row
  rebuilt from the archive wins; `fill_callsign_days` / `backfill_callsign_days` only fill days
  rolled up before it existed: every source but RBN exactly from `spot_stream`, the RBN row from
  `callsign_activity` (only the CW bucket maps back to a mode) when the day is retired or the fresh
  RBN count is below what the roll-up counted, and a retired day (not `without_rbn`) whose day rows
  were compacted into month rows is refused. `compact_callsign_rollups` keeps a day's rows until
  `callsign_rollup_days.days_filled_at` is set.
- A failed day goes through `record_callsign_rollup_failure` into `callsign_rollup_failures`,
  never only a `raise warning`; `rollup_callsign_day` deletes the row itself after its marker, so a
  manual `(day, true)` clears it. `maintain_rbn_spots` records a day it retires without a marker
  the same way, only when the day did not already read as retired and the archive logged RBN rows
  for it (state, not partition existence), decided before any drop: never scan `rbn_spots` under
  a drop's lock.
  `callsign_rollup_status` is the operator's view (order: `fill_failed`, `done_without_rbn`, `done`,
  `rbn_retired`, `failed`, `pending`). All of it is service-role only.
- `backfill_callsign_rollups(p_max_days)` keeps its return shape `(rollup_day, spots, error)`:
  `seed.sql`, `scripts/smoke-test.sql` and pgTAP call it. The fill's rows stay out of it, and it
  runs the fill only when its day loop rolled nothing up, and the fill attempts at most twice
  `p_max_days` days, so a run makes a bounded number of day passes (a statement-timeout cancel is not caught and would undo the run). The cron body stays
  `select count(*) from backfill_callsign_rollups(2)` (raising would roll back the successful
  days).

## Profile rules

- `callsign_profile(call)` builds the whole profile in SQL. Its shape is `CallsignProfile` in
  `web/src/profile/types.ts`, pinned by `supabase/tests/callsign_profile.test.sql`; change the SQL,
  the type and the test together. It is not granted to clients: the public `callsign-profile`
  function reads it through `cached_callsign_profile` after `record_profile_lookup`.
- The year heat map (`heard.calendar`, canvas page 9) reads `callsign_days` plus the live days,
  never `callsign_activity` (compacted) and never APRS-IS. Its periods (past 365 days, then each
  year since first heard) and their figures (days on the air, longest streak, busiest day) are
  SQL's; `web/src/profile/calendar.ts` only places days in week columns and words them. Shading is
  relative to the period shown (`heatScale`: days on the air ranked, about a quarter per level,
  equal counts sharing one), never fixed spot counts; the legend is Less/More swatches with no spot counts.
- Live reads of `spot_stream` filter on `base_callsign` and `spot_time`, so `raw_spots` and the
  `rbn_spots` expression index both serve them. Group by spotter before calling `base_callsign()`
  or `cty_lookup()` on spotters.
- The rate limit keys on a header the edge proxy sets (`LONGLINES_CLIENT_IP_HEADER`, its last
  entry), never on the first `x-forwarded-for` entry. It accepts only a parsed IP, keys IPv6 by /64,
  and stores only an HMAC (`_shared/hmac.ts`, key imported once per isolate). Sign-in uses the
  same key (`rateLimitKey`) and limits failed attempts in SQL per (identifier, client), 10 per 15
  minutes plus 100 per identifier (`begin_sign_in_attempt` / `forget_sign_in_attempt`); an attempt
  is forgotten unless Auth answered `invalid_credentials`, so a right password never counts.
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
- POTA, SOTAwatch and DX Cluster only. Never RBN, APRS-IS or `raw_payload`. WWFF stays off until
  Brad makes that product call. One row per
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

## Group statistics rules

The design is `docs/superpowers/specs/2026-10-19-group-statistics-design.md` (canvas page 10); its
Copy section is the copy source for the group pages.

- `group_statistics_at` builds the whole payload in SQL from `callsign_days`, day-grain
  `callsign_activity` (so periods stop at 30 days), `callsign_seen` and `spot_stream`. Its shape is
  `GroupStatistics` in `web/src/groups/stats/types.ts`, pinned by
  `supabase/tests/group_statistics.test.sql`; change the SQL, the type and the test together.
  Every figure, ranking and list length is SQL's; the web never sums, ranks or filters callsigns.
- `group_member_bases()` is the one statement of which members count: base calls minus
  `hidden_callsigns`. A hidden call counts nowhere, totals included.
- No cron: `cached_group_statistics` serves `group_stats_cache` for an hour, single-flight, and a
  row whose `roster` no longer matches the members is a miss. `list_group_summaries` builds within
  a 3 s budget, then serves older rows; keep it inside the 8 s statement timeout.
- `save_callsign_group` stays the only write path; `public` and `show_callsigns` are optional keys
  it ignores under `longlines.via_api` (set by `api_call`), so the API never publishes a page.
  `public_slug` is made once and never changes.
- A page without callsigns is redacted in SQL (`group_stats_redact`, inside
  `public_group_statistics`), never in the web, which only hides sections whose keys are absent.
- `group-page` is `verify_jwt = false` and never imports `isServiceRole`. It shares the profile's
  rate limit, answers an unknown, private or malformed code with the same 404, never logs a code,
  and sends `Cache-Control: no-store` so turning a page off works on the next load. `/g/*` is
  noindex twice: `X-Robots-Tag` in `web/vercel.json` and a robots meta tag while the page is
  mounted.
- `GroupHeatMap` uses the profile's grid helpers (`profile/calendar.ts`) with the club's fixed
  levels (`groupHeatLevel`), never the profile's per-period levels.
- `GroupStatistics` is shared by the owner's page and the public page. Every callsign it shows
  links to `/call/<base>` (`CallLink`, `CallList`).

## Health page rules

The design is `docs/superpowers/specs/2026-10-21-health-page-design.md` (Brad's "Long Lines health
page" canvas); its Copy section is the copy source for `/health`.

- `/health` is public. Its data comes only from the `health` function, which calls
  `cached_health(range)` (one `health_cache` row per range, rebuilt at most every 30 seconds under
  an advisory lock). The payload is `HealthPayload` (`web/src/health/types.ts`), pinned by
  `supabase/tests/health_snapshot.test.sql`; change the SQL, the type and the test together.
- Numbers and statuses only: never error text, response bodies, URLs, or user or destination ids.
- Every status and threshold is SQL's (`health_snapshot`); the web words them, and the rule copy
  must match the SQL.
- History is `health_samples`, one row a minute from `record_health_sample()` (cron
  `health-sample`), which also copies HTTP statuses into `cron_http_requests` and prunes its tables
  after 8 days. Event counts (sent, failed, expired, latency) come from `deliveries` through its
  partial indexes; `last_failed_at` is set only by the `deliveries_last_failed_at` trigger.
- A cron job that calls a function goes through `cron_call_function(job, function, body,
  timeout)`, never a bare `net.http_post`, so the page can show its HTTP status.
- "Oldest ready delivery" is per destination (the age of each destination's newest ready row, then
  the largest), because deliveries go newest first under a budget. `health_oldest_ready_seconds`
  repeats `claim_deliveries`' `ready` predicate; change them together.
- The workers report in once a minute, best effort: the sender through `record_sender_heartbeat`
  (in its allowlist), the relay by POSTing `relay-status` with its secret (`relay/status.ts`).
  `worker_heartbeats` keeps at most one row per worker per 30 seconds. A failed heartbeat is
  logged, never retried and never counts as sender progress.

## Subscription rules

- Users and API clients call a subscription a **connection**: web copy, web routes (`/connections`;
  `/subscriptions/*` redirects), management API paths (`/v1/connections`), API JSON
  (`connection_count` on groups, through `api_group_json`), the webhook body's `connection` (the
  connection's name), and
  SQL error messages a client can see ("Connection not found."). Tables, columns, RPCs, api_call
  operation names, TypeScript identifiers and file names stay "subscription". Never show the word
  "subscription" to a user; the browser's push subscription is a different thing and keeps its name.
- A subscription's filter is `subscriptions.rules`: AND groups, ORed (`[[A, B], [C]]` is "A and B or
  C"; And binds tighter). Each rule is `{field, op, values}`; the fields and ops are listed at the top
  of `20261014000500_subscription_rules.sql` and in `docs/API.md`. `[]` passes every spot. The
  source stays its own column (`sources`), not a rule.
- `normalize_subscription_rules` is the only validator and normaliser; `save_subscription` and
  `preview_subscription` both go through it. `group_ids` is derived from the rules (every group
  named, `is` or `is_not`) and written only by `save_subscription`; never set it elsewhere.
  `normalize_subscription_sources` is the only check on `sources` (both call it); its list is
  `raw_spots_source_check` without `aprs`, so a new source goes in both. Band values are stored
  lowercase, and a rule takes at most 1,000 values.
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
- Notification text is an ordered pick of fields (`push_fields()`), never a template or free text,
  built by `push_spot_fields` in SQL: `claim_deliveries` hands the sender `push_title`, `push_body`,
  `push_url` and `push_source_url` in the spot jsonb, and `preview_push_notification` (the editor)
  and `push_test_delivery` (Send test, service role) call the same function, so the preview, the
  test and the delivered text agree. Never join spot fields, interpolate text or build a tap URL in
  TypeScript. Each push destination's settings travel in the claim's destination jsonb as `push`,
  with `quiet_now` decided once per destination in SQL in the account time zone; `send.ts` reads
  `Urgency` and `TTL` from `push` and falls back to high and 15 minutes when the key is absent, so
  the sender and the migration can ship in either order. The claim's signature and result columns
  never change for this. "Drop if the device is offline for" is `push_destination_settings.ttl_seconds`,
  read by the claim's expiry sweep; `destinations.enabled` is enforced by the matcher,
  `watched_among` and the claim's unwanted sweep, nowhere in TypeScript.
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
- `format.ts` (`pushNotifications`) only shapes what SQL rendered: one notification per claimed
  spot (the budget is SQL's 3 a minute per push destination; there is no summary), tags, actions,
  `silent`/`renotify`. The service worker only displays it. A "Don't send" destination in quiet
  hours makes `sendPush` return the batch as sent without a request.
- `web/src/pwa/push.ts` is the only module that touches `PushManager`, `Notification` and
  `PushSubscription`; `Notification.requestPermission()` is the first statement of `enablePush()`,
  before any `await`. `web/src/pwa/register.ts` is the only module that calls
  `navigator.serviceWorker.register`. `web/src/pwa/install.ts` is the only module that handles
  `beforeinstallprompt`; `main.tsx` captures it before the first render, and the account menu's
  Install app item sits between Account and Sign out only while `installState()` isn't `none`.
- When the subscription's endpoint differs from the one the browser remembers, the refresh passes
  the remembered one as `p_previous_endpoint`, and `register_push_device` moves the caller's own
  device to the new endpoint in place (same id, name and destinations). It never matches another
  account's device. A failed enable unsubscribes a subscription it just created.
- The registration stays current in three places, nowhere else: `AppProvider` runs
  `refreshPushRegistration()` once per load with a session, `register.ts` runs it again on the
  worker's `push-subscription-changed` message, and every local sign-out passes `pushCleanup` to
  `signOut` ("Sign out other devices" passes nothing). The web never reads an endpoint back; it
  keeps only its own last one in `localStorage`.
- The service worker (`web/src/pwa/sw.ts`, emitted unhashed as `/sw.js` with no `import`
  statements) handles `push`, `notificationclick` and `pushsubscriptionchange` only. It never
  imports app code and never holds a token: on `pushsubscriptionchange` it re-subscribes and
  posts a message to open windows, which re-register. It has no `fetch` handler and caches
  nothing, and `/sw.js` is served `Cache-Control: no-cache`, so a deploy can't strand a stale
  bundle.
- The VAPID pair lives in two places and nowhere else: Edge Function env (`LONGLINES_VAPID_*`, for
  `send-test` and `api`) and the sender's Fly secrets (real deliveries), the same pair in both.
  Never in the web app, the relay or a migration. The public key is the one new `define` entry in
  `web/vite.config.ts` (`VITE_VAPID_PUBLIC_KEY`); never widen `envPrefix`.
- A gone subscription (404/410) is pruned, not counted as a failure; a 429 delays like any other
  rate limit. Zero deliverable devices is a failure, so a push destination nobody can receive goes
  `failing`. A spot skipped for quiet hours ("Don't send") is marked sent, never retried or
  counted as a failure.

## Conventions

- Time-dependent functions take `now: Date` so tests pin the clock. The POTA and SOTAwatch
  fixtures were captured 2026-10-05 ~13:45Z, the RBN telnet fixture 2026-10-11 14:54-14:56Z, the
  WWFF fixture (`wwff-spots.json`) 2026-10-15 ~18:27Z; tests
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
  licenses from the `callsign-profile` function. Every `public` table has RLS on
  (`advisor.test.sql` checks it).
- `runIngest` bound-checks every spot (`assertStorableSpot`: spot time at most a day ahead and not
  before 2000, calls and references at most 64 characters, `source_spot_id` at most 256); the
  firehose row builders apply the same bounds, and `withoutNul` also makes strings well formed.
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
