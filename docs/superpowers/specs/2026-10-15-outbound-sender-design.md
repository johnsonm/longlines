# Outbound sender

Date: 2026-10-15

Status: approved design, Phase 1 not started. Each build session appends to the Progress log at the
end; read it before doing anything.

## Goal

Move all outbound delivery (Discord, webhooks, web push) off the `deliver` Edge Function onto a Deno
process on Fly.io, the way `relay/` holds the inbound streams. The sender only sends. Every decision
stays in Postgres: claiming, outcomes, destination health, throttling and, later, disable decisions.
Phase 1 is relocation plus the one change relocation forces (a rate-aware claim, so a process that
polls every few seconds cannot multiply today's per-run caps). Phase 2 (per-event webhooks,
in-memory retry layer, auto-disable, queue-depth notices, system emails) is planned separately after
Phase 1 ships; nothing in Phase 1 may design it out (section 10).

Why: every `deliver` run is an Edge Function invocation (the cron every minute, ~43k a month, plus
one kick from `match_pending_spots` per ingest run that created deliveries). The goal is that
delivery volume stops scaling invocations so growth cannot push the project past the Pro quota of 2M
a month; going slightly over is acceptable. The relay's three 10 s feeds (~777k a month) are
untouched. Latency within about a minute of the spot is fine.

Labels: **[DECIDED]** Brad stated or confirmed it; **[SUGGESTED]** proposed, not confirmed;
**[OPEN]** not decided. Numbers called "example" or "knob" are starting values in one SQL function
or one env variable, never hardcoded in the loop.

## Decisions

- **[DECIDED]** Access: option A, a restricted Postgres role `delivery_sender` through the Supavisor
  shared pooler in session mode (port 5432, IPv4, supports LISTEN), postgres.js with `max: 2`, int8
  parsed to Number. Not Edge Functions behind the relay secret (every poll and mark would be an
  invocation), not PostgREST with a minted JWT, not a public kick URL.
- **[DECIDED]** The sender is dumb and payload-agnostic; policy lives in Postgres.
- **[DECIDED]** Exactly one sender machine until a per-destination lease exists. With one serial
  consumer, marks land before the next claim, so the 60 s visibility timeout cannot produce
  duplicates; a second machine brings duplicates, uncoordinated throttles and split counts back.
- **[DECIDED]** Poll now (`SENDER_POLL_MS`, default 5 s); the matcher gains a `pg_notify` hook for
  LISTEN later.
- **[DECIDED]** Throttle state (level, next-eligible time, token bucket) lives on the `destinations`
  row. The claim is rate-aware per destination and newest first, always. Quarantine alone
  oscillates; the claim must meter.
- **[DECIDED]** A 429 is alive, not dead: it throttles the destination and never counts toward
  health. For every type, including webhooks (today a webhook 429 is a failure).
- **[DECIDED]** Dispatch is non-blocking with bounded concurrency and every response status is read
  ("fire-and-forget" is rejected). Acks are batched: one `mark_deliveries_sent` per cycle. Write
  load scales with problems, not sends.
- **[DECIDED]** Expiry runs in SQL, independent of claiming, and sets `deliveries.dropped_at`. Under
  newest-first the oldest rows are never claimed, so a worker-side age check would never see them
  and the queue would grow without bound.
- **[DECIDED]** Push budget is 3 spots a minute per push destination, newest first, no "and N more"
  summary. Discord keeps 10-embed messages. Webhook payload keeps the `{deliveries:[...]}` envelope
  when it becomes one spot per request in Phase 2.
- **[DECIDED]** Budgets are stated in spots per minute with the request equivalent per type; fixed
  per type now, learned from 429s later once the loss metrics exist.
- **[DECIDED]** Layer-1 in-memory backoff (Phase 2) caps its total hold below the visibility
  timeout; the retry buffer is memory-aware. The worker optimizes, Postgres guarantees.
- **[DECIDED]** Health (Phase 2): one uniform model for every type, detection within 24 to 48 h is
  enough, no sampling (every status counts), a small failure count with time as the blip guard
  (example: `failing_since` at least 48 h old and at least 3 failures), disable plus notify. Webhook
  410 disables at once; 404 drops the message plus one tally; 401/403 tally only.
- **[DECIDED]** System emails are deliveries: an `email` destination type the sender sends, used by
  the disable notice, the backing-up notice and the operator alert, with a 24 h dedup each. Never
  pg_net from SQL (fire-and-forget, silently lost on provider failure).
- **[DECIDED]** Loss metrics, never oldest-pending age: spots expired undelivered over a window and
  sustained growth of queue depth, read from `dropped_at` and an hourly sample table.
- **[DECIDED]** Visibility timeout stays 60 s; `kill_timeout` 30 s, accepting one re-send of a cycle
  cut off by a deploy (as an Edge invocation cut off today); watchdog exit after 2 min without a
  successful claim; VAPID keys in both Edge env and the sender's secrets, documented; custom Fly
  network plus the full SSRF suffix list mirrored in SQL; dashboard GitHub integration first, GitHub
  Actions with a scoped token if a second app cannot bind; one week between cutover and cleanup;
  sender opt-in for local dev; no POTA cadence change; `WEBHOOKS.md` gets one sentence saying
  deliveries are newest first and unordered.
- **[OPEN]** Email provider for the `email` destination type (Phase 2; Brad's pick; it does not
  shape the design).

## 1. How the sender reaches the queue

Migration (session 1):

- `create role delivery_sender nologin`, guarded by `if not exists` on `pg_roles` (roles are
  cluster-wide and survive `supabase db reset`).
- `alter role delivery_sender set statement_timeout = '30s'`,
  `set idle_in_transaction_session_timeout = '30s'`, `set search_path = public`,
  `connection limit 4`.
- `grant usage on schema public to delivery_sender`; `grant execute` on exactly the sender RPC
  allowlist below. All are `security definer`, so the role needs nothing on tables or on `pgmq`.
- pgTAP `supabase/tests/sender_role.test.sql`: the role may execute exactly the allowlist and
  nothing else in `public`, has no table privileges, no usage on `pgmq`. `advisor.test.sql` keeps
  passing.
- Hosted one-time step (hand step): `alter role delivery_sender with login password '<random>'` from
  `scripts/setup-sender-role.sql` (session 5). Local dev uses the stack's `postgres` URL; nothing in
  `seed.sql` (which also runs on preview branches) touches the role.

Sender RPC allowlist (the sender's whole database surface):

| RPC                                                     | Session                | Purpose                                    |
| ------------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `claim_deliveries(int, int)`                            | exists; rewritten in 2 | claim, with expiry sweep and budget        |
| `mark_deliveries_sent(bigint[], bigint[])`              | exists; changed in 2   | ack, reset failures, decay throttle        |
| `mark_deliveries_failed(bigint[], bigint[], text, int)` | exists                 | tally, backoff                             |
| `throttle_destination(uuid, bigint[], int)`             | new in 2               | 429 and the Discord cap                    |
| `delivery_queue_stats()`                                | new in 2               | depth and expired-last-hour for `/healthz` |
| `prune_push_devices(text[])`                            | exists                 | push 404/410                               |
| `record_push_results(text[], jsonb)`                    | exists                 | push bookkeeping                           |

`mark_deliveries_dropped` and `delay_deliveries` stay `service_role` only and are dropped in
session 6.

Connection: `npm:postgres@3.4.9` (postgres.js), imported with the full specifier only in
`sender/db.ts` with the comment the dependency rule requires (TLS, named-parameter calls, LISTEN
later; `jsr:@db/postgres` has no LISTEN). `ssl: "require"`, `max: 2`, `prepare: true`, an `int8`
parser returning `Number` so `msg_id`/`delivery_id` arrive as the numbers `PendingDelivery` expects,
`sql.json()` for the `jsonb` argument of `record_push_results`. Calls are
`select * from public.<fn>(p_x => $1, ...)` over the allowlist. Hosted username is
`delivery_sender.<project-ref>` on the pooler host, session mode.

## 2. The claim: rate-aware, newest-first, throttle state in Postgres (session 2)

Columns on `destinations`: `throttled_until timestamptz`, `throttle_level int not null default 0`,
`claim_tokens numeric not null default 0`, `claim_tokens_at timestamptz not null default now()`.
Client column grants do not widen. On `deliveries`: `dropped_at timestamptz`, index
`(destination_id, dropped_at)`.

Knob functions (immutable SQL; pin `search_path` or list them in `advisor.test.sql`'s inlinable
list):

- `destination_budget(p_type text) returns table (rate_per_minute numeric, burst numeric)`. The
  claim meters spots (delivery rows); the unit is spots per minute, and a comment per row gives the
  request equivalent: discord 300 (= 30 messages of 10 embeds, the figure `DISCORD_MESSAGES_PER_RUN`
  came from), push 3 (3 notifications per device, per push destination), webhook 1000 (= 20 requests
  of 50; effectively uncapped as today, Phase 2 sets a real number). Burst equals the rate.
- `destination_throttle_seconds(p_level int) returns int`: example 60 s doubling to 900 s.
- `destination_max_age(p_type text) returns interval`: push 15 min, everything else 24 h. This
  replaces `MAX_AGE_MS` / `PUSH_MAX_AGE_MS` in TypeScript.

`claim_deliveries(p_limit int default 200, p_vt int default 60)`: **same signature and the same
result columns as today**
(`msg_id, delivery_id, subscription_id, attempts, created_at, destination jsonb, spot jsonb`). Body,
one transaction:

0. `expire`: pending or failed deliveries older than `destination_max_age(type)` (join
   `destinations`) become `status = 'dropped', dropped_at = now()`, their queue messages archived.
   Bounded (example 500 rows per call) so a call never does a huge sweep; it runs every poll whether
   or not anything is claimable.
1. `ready`: `pgmq.q_deliveries_queue q` with `q.vt <= clock_timestamp()`, joined to `deliveries` and
   `destinations`, excluding `health = 'paused'` and `throttled_until > clock_timestamp()`. Orphans
   (no `deliveries` row) are archived as today.
2. `budget`: per destination,
   `available = least(burst, claim_tokens + rate_per_minute * minutes since claim_tokens_at)`.
3. `ranked`:
   `row_number() over (partition by destination_id order by spot_time desc, delivery_id desc)`.
4. `chosen`: `rn <= floor(available)`, **ordered by `rn` first, then `spot_time desc`**,
   `limit p_limit`: every destination's newest spot first, then every destination's second,
   round-robin by rank, so a destination whose freshest spot is slightly older cannot lose its slots
   every cycle.
5. The claim:
   `update pgmq.q_deliveries_queue set vt = clock_timestamp() + p_vt, read_ct = read_ct + 1` (and
   `last_read_at` if the installed pgmq has it)
   `from chosen where msg_id matches and vt <= clock_timestamp() returning`. Postgres re-checks that
   predicate on the latest row version, so an overlapping claimer cannot take the same message.
   (pgmq's own `read` does this with `FOR UPDATE SKIP LOCKED`; with one consumer by rule the lock
   hint is unnecessary, and it cannot be combined with the window function.)
6. Debit: `update destinations set claim_tokens = available - claimed, claim_tokens_at = now()`.
7. Return the rows joined to spot and destination JSON exactly as today.

Check locally that the function owner can update `pgmq.q_deliveries_queue` directly; Brad confirms
the same on the hosted project before `db push`.

`throttle_destination(p_destination_id uuid, p_msg_ids bigint[], p_seconds int)`: sets
`throttled_until = now() + p_seconds`, `throttle_level + 1`, and `pgmq.set_vt` on the messages so vt
and throttle agree. `p_seconds` is `Retry-After` when the sender has one, else null and SQL uses
`destination_throttle_seconds(level)`. `mark_deliveries_sent` clears `throttled_until` and decays
`throttle_level` by one per successful cycle (not a reset, so one success after a 429 storm does not
drop straight back to the base delay); `consecutive_failures` still resets. New RPCs are
`security definer`, `search_path` pinned, revoked from `public`, granted to `service_role` and
`delivery_sender`, listed in `sender_role.test.sql`. `mark_deliveries_failed` is unchanged in Phase
1 (per-destination +1, `failing` at five).

`delivery_queue_stats()` returns queue depth (`pgmq.metrics`) and deliveries with `dropped_at` in
the last hour.

Effects: Discord gets at most 300 spots a minute per webhook, so `discordMessages` never exceeds 30
messages and `DISCORD_MESSAGES_PER_RUN` becomes a safety net; push gets 3 a minute per push
destination and its summary branch is unreachable; webhooks are effectively uncapped. The Edge
`deliver` function runs the same RPC during the overlap, so cron and kicks keep working.

## 3. The sender process (sessions 3 and 4)

`sender/` mirrors `relay/`: `main.ts` (process shell only), `config.ts`, `db.ts`, `sender.ts`,
`health.ts`, `__tests__/`.

- **Loop body** (session 3): `supabase/functions/_shared/delivery/run.ts`,
  `runDeliveryBatch(db: DeliveryRpc, send, now, options)`, extracted from
  `_shared/handlers/deliver.ts`. `DeliveryRpc` is
  `{ rpc(fn, args): Promise<{ data: unknown; error: string | null }> }` so `pushBookkeeping`'s
  tuples keep working; no supabase-js import, so it loads under `--no-config`. Changes from today's
  loop: no age check (SQL expires); groups by destination sent concurrently up to
  `options.concurrency` (default 4; 1 is today's serial behavior), sequential within a destination
  (Discord message order, webhook request order; push devices already parallel); one
  `mark_deliveries_sent` per cycle with every successful id; `mark_deliveries_failed` per
  destination as today; 429 and the Discord cap call `throttle_destination`, never
  `delay_deliveries`; `sendWebhook` returns `retryAfterSeconds` on 429. The Edge handler becomes
  auth + a supabase-js adapter + `runDeliveryBatch` until session 6.
- **Process** (session 4): `startSender(config, deps, options)` returning `{ addr, done, shutdown }`
  like `startRelay`. One serial loop: claim, `runDeliveryBatch`, sleep `SENDER_POLL_MS` or re-claim
  immediately after a full batch. `delivery_queue_stats()` every `SENDER_STATS_MS` (60 s).
  `shutdown()` stops claiming, awaits the in-flight cycle, closes the pool and the health server.
- **Exit 1 means**: (a) invalid config or a pool that cannot open at start; (b) the watchdog: no
  successful `claim_deliveries` for `SENDER_STALE_MS` (default 2 min), which is what a wedged pooler
  connection looks like and would otherwise drop every push after 15 min behind a healthy-looking
  machine; (c) an unhandled rejection. A failed claim or mark alone is logged and retried (5 s
  doubling to 60 s). Fly restarts only on process exit; `/healthz` 503 is for `fly checks list`.
- `/healthz`: 200 while the last successful claim is under `staleMs` (start time counts before the
  first claim); body
  `{ healthy, last_claim_at, last_error, in_flight, totals, queue: { depth, expired_last_hour } }`.
  With a per-cycle log line this is the Phase 1 operator signal: spots actually lost, from SQL.
- `config.ts`: `SENDER_DATABASE_URL` (TLS required unless the host is local), `SENDER_HEALTH_PORT`
  (8080), `SENDER_POLL_MS` (5000, floor 1000), `SENDER_CONCURRENCY` (4), `SENDER_STALE_MS` (120000),
  `SENDER_STATS_MS` (60000), `LONGLINES_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT` via
  `vapidKeysFromEnv`, `LONGLINES_ALLOW_INSECURE_DESTINATIONS` (honoured only for a local DB host),
  `LONGLINES_USER_AGENT_URL`. The Dockerfile `--allow-env` list is enforced by a test copied from
  `relay/__tests__/modules.test.ts`.
- Memory: 200 rows per cycle is small; the Phase 2 retry buffer is what needs the memory-aware bound
  under `--max-old-space-size=160`.
- Cycle-level head-of-line: each cycle waits for its slowest destination before acking and
  re-claiming, so a webhook timing out (4 requests × 10 s) holds every other destination's next
  claim for about 40 s. Inside the one-minute target; Phase 2 B pipelines cycles.

## 4. Response handling

| Response                       | Meaning                      | Action                                                             | Health                  | Phase                  |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------ | ----------------------- | ---------------------- |
| 2xx                            | Delivered                    | batched ack                                                        | no                      | 1                      |
| 429                            | Alive, too fast              | `throttle_destination` with `Retry-After` or the level backoff     | **no**                  | 1, every type          |
| push 404/410                   | Device gone                  | prune the device; zero devices left is a failure                   | terminal for the device | 1 (unchanged)          |
| webhook 410                    | Destination gone             | disable at once (needs the `disabled` state), drop pending, notify | immediate disable       | 2 (a tally until then) |
| webhook 404                    | Probably a botched deploy    | drop the message, one tally                                        | one tally               | 2                      |
| webhook 401/403                | Secret or auth misconfigured | tally only; the queue is kept                                      | one tally               | 2                      |
| 5xx, timeout, connection error | Might be dead                | `mark_deliveries_failed`: tally, backoff, retry                    | yes                     | 1 (as today)           |

## 5. Retry layers

1. In-memory exponential backoff on the worker (Phase 2): total hold under the visibility timeout
   (cap, example 45 s of 60; no vt extension), memory-aware buffer derived from available memory,
   failures go straight back to Postgres when it is near its limit.
2. Hand back to Postgres (exists): `mark_deliveries_failed` with `backoffSeconds`, or the vt lapse
   for anything un-acked. Survives restarts.
3. Health counter and auto-disable (Phase 2).

## 6. Cutover, overlap, rollback

Sessions map to PRs; hosted migrations are pushed by hand, never by CI.

1. Session 1: role, `sender_role.test.sql`, SSRF hardening (SQL and TS). `supabase db push`.
2. Session 2: the claim rewrite and the new RPCs. `supabase db push` after confirming the pgmq table
   access on hosted. The Edge `deliver` keeps running on the new claim.
3. Session 3: `run.ts` and the handler wrapper. `supabase functions deploy deliver` after merge.
4. Session 4: the sender. Hand steps: `fly apps create longlines-sender --network sender`,
   `fly secrets set` (`SENDER_DATABASE_URL` with the role password, the VAPID triple), the role
   password on hosted, first deploy, `fly scale count 1`, `fly checks list`, the dashboard binding
   (working directory `.`, config path `sender/fly.toml`) or the Actions fallback. Overlap with the
   Edge cron is safe: the claim's vt predicate prevents double-claims and the token bucket lives in
   Postgres. Watch `fly logs` and `pgmq.metrics('deliveries_queue')` for a day.
5. Session 5: migration with `cron.unschedule('deliver')` and `match_pending_spots` minus the
   `net.http_post` block plus `perform pg_notify('deliveries', '')`; docs. After push, confirm no
   `deliver` in `cron.job` and no new `/deliver` posts in `net._http_response`.
6. Session 6, one week after 5 is pushed: delete the `deliver` function and its handler, config and
   test entries; drop `delay_deliveries` and `mark_deliveries_dropped`.

Deploys of the sender: `shutdown()` stops claiming on SIGINT and `kill_timeout = 30s` lets most
cycles finish; a cycle cut off mid-send leaves un-acked messages that reappear after 60 s and are
re-sent once.

Rollback before session 6: `fly scale count 0 -a longlines-sender`, then a new migration that
re-schedules the `deliver` cron and restores the kick (bodies copied from
`20261006000009_delivery_cron.sql` and `20261006000008_match_pending_spots.sql`; applied migrations
are never edited). The `deliver` function is still deployed and runs the same `run.ts`.

## 7. SSRF now that the sender sits on Fly (session 1)

What holds already: https only, private IPv4 ranges and `fc00::/7` (which contains Fly's
`fdaa::/16`) rejected, hostnames re-resolved and rejected if any address is private, no redirects,
Discord and push hosts allowlisted. Changes:

- `fly apps create longlines-sender --network sender`: its own 6PN, nothing else on it; `fdaa::3`
  (Fly DNS) is the only private address it can see and it is blocked. Cannot be changed after
  creation.
- Hostname suffix denial for webhooks in `assertSafeDestinationUrl` and in SQL
  `validate_destination_url()` (new migration): `.internal`, `.flycast`, `.local`, `.localdomain`,
  `.home.arpa`, `.arpa`. Tests on both sides; the TS comment that it mirrors SQL stays true.
- Tests pinning `fdaa::1`, `fdaa:0:1::3` and `169.254.169.254` as private.
- Unchanged and documented: the DNS time-of-check/time-of-use window (`fetch` cannot pin an
  address); `--allow-net` unrestricted because destinations are arbitrary public hosts.

## 8. Fly app, build, gates, CI, docs (sessions 4 and 5)

- `sender/Dockerfile`: copy of `relay/Dockerfile` with `sender/`;
  `deno cache --no-config sender/main.ts` (fetches `npm:postgres` at build); `--allow-net`, exact
  `--allow-env` list, `--v8-flags=--max-old-space-size=160`. `.dockerignore` gains `!sender/` and
  `sender/__tests__/`.
- `sender/fly.toml`: `app = "longlines-sender"`, `primary_region = "iad"`,
  `[build] dockerfile = "sender/Dockerfile"` (build context is the repo root so `_shared` is in it),
  `kill_signal = "SIGINT"`, `kill_timeout = "30s"`, `[[vm]] shared-cpu-1x 256mb`, no
  `[http_service]`, `[checks.healthz]` on 8080 every 30 s with a 60 s grace period, a header comment
  stating the one-machine rule and why the file is not at the root.
- Deploys: dashboard integration first; else `.github/workflows/deploy-sender.yml` running
  `flyctl deploy --config sender/fly.toml --dockerfile sender/Dockerfile --remote-only` on pushes to
  `main` filtered to `sender/**` and `supabase/functions/_shared/**`, with a token scoped to the
  sender app (and CLAUDE.md's "nothing else deploys automatically" line changes with it).
- Root `deno.json`: `test`/`coverage` add `sender/__tests__/`; `check` adds `sender/main.ts`;
  `lint`/`fmt` add `sender`; permissions `read` adds `sender/Dockerfile`, `env` adds
  `SENDER_TEST_DATABASE_URL`. `scripts/check-coverage.ts` gets a third root
  `{ name: "Sender", dir: ../sender/, skip: [/^__tests__\//, /^main\.ts$/] }`.
- CI: `ci.yml` fmt line adds `sender`; `web/scripts/check-all.ts` mirrors it. The `migrations` job
  adds `setup-deno` and runs `deno test -P sender/__tests__/db.test.ts` with
  `SENDER_TEST_DATABASE_URL` from `supabase status -o env`. `db.test.ts` is skipped without that
  variable but still loads the module for the coverage gate.
- Local dev: `web/scripts/sender.ts` + `npm run sender`, opt-in, not in `dev:full`; replaces
  `npm run invoke:deliver`.
- Docs (session 5): CLAUDE.md Delivery rules reworded around the sender and the claim (policy in
  SQL, rate-aware and newest first, `throttle_destination` for 429s, knobs in `destination_budget` /
  `destination_throttle_seconds` / `destination_max_age`); a new **Sender rules** section (what it
  holds: `SENDER_DATABASE_URL` for `delivery_sender` and the VAPID triple, never a Supabase API key;
  the RPC allowlist is its whole DB surface; exactly one machine; per-destination caps are per
  minute in SQL, never per claim; the watchdog exits 1 and a 503 alone restarts nothing; knobs via
  env; no tests against a hosted DB; never `fly deploy`/`fly secrets set` unasked); the Push rule on
  where VAPID lives; the Commands block; the "What this is" exception naming both Fly processes.
  OPERATIONS: sender setup, role password script, cron table, Delivery and Push troubleshooting.
  ARCHITECTURE: diagram and Delivery section. README overview and local section. WEBHOOKS: the
  ordering sentence, and 429 now delays.

## 9. Phase 2 outline (planned separately after Phase 1)

A. One webhook request per event (Brad's original ask); envelope kept; Discord stays batched; push
loses its summary branch. B. In-memory retry layer and cycle pipelining. C. Health and auto-disable
with `failing_since`, a `disabled` state, `resume_destination`, `register_push_device` resetting
health (it does not today), the webhook permanent-code split. D. Queue depth as a signal: user email
with options A adjust the filter, B clear the queue (`clear_destination_queue` and
`POST /v1/destinations/{id}/clear`), C do nothing; loss metrics from `dropped_at` and an hourly
`destination_queue_samples` table; a service-role `delivery_health` view; an operator email with 24
h dedup. E. System emails as deliveries: an `email` destination type (one per account, address
resolved from `auth.users` at claim time, never stored), `deliveries.spot_id` nullable with a
`notice jsonb` check, `claim_deliveries` gains one additive `notice` column, `sendEmail` in
`send.ts`, the provider key as a sender secret. F. LISTEN; a per-destination lease before any second
machine; test sends routed through the sender so VAPID leaves Edge env.

## 10. Phase 1 does not block Phase 2

- Claim signature and result columns unchanged; budgets, throttles and order come from columns and
  knob functions, never arguments. Per-destination overrides are new columns the same function
  reads.
- Throttle columns land in Phase 1; health columns sit beside them; `disabled` joins the `health`
  check constraint without touching the claim.
- Newest-first ordering lands in Phase 1 and is what makes queue depth meaningful.
- Batched acks and non-blocking dispatch are the model the in-memory layer builds on;
  `runDeliveryBatch` returns per-destination results so a retry buffer can sit between send and ack.
- New RPCs are one grant line and one pgTAP line each, as `throttle_destination` is in Phase 1.
- `dropped_at` and the SQL expiry sweep land in Phase 1; Phase 2 D's loss figure is a query over
  existing data; `delivery_queue_stats()` reads the same column.
- Phase 1 keeps `deliveries.spot_id not null` and the `discord | webhook | push` type check;
  relaxing both and adding `notice` and `email` are additive. Nothing in Phase 1 assumes a delivery
  is a spot except the SQL expiry sweep, which keys on destination type and `created_at`.
- One machine: the lease is additive; nothing in Phase 1 assumes machine identity.

## Verification (Phase 1 as a whole)

- `deno task fmt && deno task lint && deno task check && deno task coverage` (three roots, each at
  least 80%, no unloaded module). `delivery_run.test.ts`: batched ack per cycle, concurrency bound,
  429 to `throttle_destination` with `Retry-After`, Discord cap never reached under a budgeted
  claim, push prune/record unchanged. `sender.test.ts`: fake clock, watchdog rejects `done` after
  `staleMs`, idempotent shutdown, health 200/503 with queue figures.
- `supabase db reset && supabase test db`: `sender_role.test.sql`; `deliveries_rpc.test.sql` with
  newest-first order, round-robin fairness (two destinations, one busier, both get their newest spot
  in the first `p_limit`), per-destination budget (400 queued gets 300, the rest stay visible),
  token refill (by updating `claim_tokens_at`), throttled destinations skipped,
  `throttle_destination` sets vt and level, `mark_deliveries_sent` decays the level, the expiry
  sweep drops a 25 h old webhook row and a 16 min old push row with `dropped_at` set and their
  messages archived even when nothing is claimable, `delivery_queue_stats()` counts them;
  `push_devices.test.sql`, `matcher.test.sql`, `advisor.test.sql`; `scripts/smoke-test.sql`.
- Local end to end: `supabase start`, `supabase functions serve`, `npm run sender` with
  `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1`, a webhook destination at a local receiver, a POTA
  subscription, `npm run invoke:pota`; the sender log shows `sent > 0` within one poll and
  `deliveries.status = 'sent'`. A local receiver returning 429 shows `throttled_until` set and no
  change to `consecutive_failures`. Repeat with a push device from the local web app.
- `SENDER_TEST_DATABASE_URL=<local DB_URL> deno test -P sender/__tests__/db.test.ts`.
- `docker build -f sender/Dockerfile .`; the image with `SENDER_DATABASE_URL` at
  `host.docker.internal:54322` serves `/healthz` 200.
- Hosted after session 4: `fly checks list -a longlines-sender`; queue depth near zero;
  `last_success_at` advancing. After session 5: no `deliver` in `cron.job`; no new `/deliver` posts
  in `net._http_response`; the dashboard's `deliver` count drops to zero.

## Session plan

Six sequential Claude Code chats, each in a fresh context. Every session: read this spec and
CLAUDE.md first; confirm the previous session's PR is in `origin/main`; work on its own worktree
(`git worktree add ../longlines-sender-s<N> -b sender-s<N> origin/main`; never switch branches in
the main checkout; commit as Brad Bazemore <bankersalgo@gmail.com> via `-c` flags); run the checks;
append a Progress log entry in the same PR; open the PR with `gh`; list Brad's hand steps; stop. No
session runs `supabase db push`, `supabase functions deploy`, `fly deploy` or `fly secrets set`.

| # | Session                                        | Spec sections    | Gate                                            |
| - | ---------------------------------------------- | ---------------- | ----------------------------------------------- |
| 1 | SQL: sender role and SSRF hardening            | 1, 7             | spec merged                                     |
| 2 | SQL: rate-aware claim, throttle, expiry, stats | 2, 3 (stats), 10 | 1 merged                                        |
| 3 | TypeScript: `run.ts`, Edge handler wrapper     | 3, 4             | 2 merged and pushed to hosted                   |
| 4 | Sender process on Fly                          | 1, 3, 7, 8       | 3 merged, `deliver` redeployed                  |
| 5 | Cutover migration and docs                     | 6, 8             | 4 merged, sender deployed and healthy for a day |
| 6 | Cleanup                                        | 6 step 6         | 5 pushed a week earlier, no rollback            |

## Hand steps for Brad (hosted; never run by a session)

- Before session 1: read the `deliver` invocation count for the last 30 days from the dashboard's
  per-function metrics and note it in the Progress log (the cron is ~43k; the rest is kicks).
- After session 1 merges: `supabase db push`.
- After session 2 merges: confirm `postgres` can update `pgmq.q_deliveries_queue` on hosted, then
  `supabase db push`.
- After session 3 merges: `supabase functions deploy deliver`.
- After session 4 merges: `fly apps create longlines-sender --network sender`; set the role password
  with `scripts/setup-sender-role.sql` (session 5 writes it; until then, by hand);
  `fly secrets set SENDER_DATABASE_URL=... LONGLINES_VAPID_PUBLIC_KEY=... LONGLINES_VAPID_PRIVATE_KEY=... LONGLINES_VAPID_SUBJECT=...`;
  first deploy; `fly scale count 1`; `fly checks list`; bind the dashboard integration (working
  directory `.`, config path `sender/fly.toml`) or add the Actions workflow; watch for a day.
- After session 5 merges: `supabase db push`; confirm `cron.job` and `net._http_response`.
- After session 6 merges: `supabase functions delete deliver`; `supabase db push`.

## Progress log

Append one entry per session: date, session number, what landed, PR, deviations from this spec,
notes for the next session. Earlier entries are never edited.

- 2026-10-15, spec: design approved after four review rounds (decisions recorded above; the review
  notes doc is the record). No code yet.
- 2026-10-15, session 1 (PR #188): role and SSRF hardening. Landed: `20261015000200_sender_role.sql`
  (role `delivery_sender` guarded on `pg_roles`, nologin, connection limit 4, the three role
  settings, usage on `public`, execute on `claim_deliveries`, `mark_deliveries_sent`,
  `mark_deliveries_failed`, `prune_push_devices`, `record_push_results`);
  `supabase/tests/sender_role.test.sql`; `20261015000300_destination_url_denylist.sql`
  (`validate_destination_url` refuses the six suffixes after stripping a trailing dot) with ten
  cases in `destinations.test.sql`; `isDeniedHostname` / `DENIED_HOST_SUFFIXES` in `urlsafety.ts`
  with tests, and `fdaa::1`, `fdaa:0:1::3`, `169.254.169.254` pinned private. Deviations: none in
  behavior; `hostOf` now also strips a trailing dot, which only widens the worker-side push check on
  endpoints SQL already validated. Notes for session 2: (1) add
  `grant execute on function public.throttle_destination(uuid, bigint[], int) to delivery_sender`
  and the same for `delivery_queue_stats()` in the migration that creates them, and append both
  names to the `set_eq` list in `sender_role.test.sql`. (2) The runner's `postgres` user is not a
  superuser: `sender_role.test.sql` does `grant delivery_sender to current_user` inside its
  transaction before `set local role`; reuse that pattern for any as-the-role assertion. (3) pg_net
  grants usage on schema `net` and execute on `net.http_delete(...)` to PUBLIC, so the sender role
  inherits both; that cannot be excluded per role and is left for Brad to decide on the hosted `net`
  grants. The role test leaves `net` out of its schema list for that reason. (4) Hand step after
  merge: `supabase db push`. Brad has not yet noted the 30-day `deliver` invocation count from the
  dashboard in this log.
- 2026-10-15, session 2 (PR #191): rate-aware, newest-first claim, throttle, expiry and stats.
  Landed in `20261015000400_rate_aware_claim.sql`: columns `destinations.throttled_until`,
  `throttle_level`, `claim_tokens`, `claim_tokens_at` and `deliveries.dropped_at` with
  `deliveries_destination_dropped_at_idx (destination_id, dropped_at)`; knobs
  `destination_budget(p_type)` (discord 300, push 3, webhook 1000; burst = rate),
  `destination_throttle_seconds(p_level)` (60 s at level 1 doubling to 900 s),
  `destination_max_age(p_type)` (push 15 min, else 24 h), all immutable SQL with `search_path`
  pinned, revoked from public; `claim_deliveries(p_limit int, p_vt int)` rewritten per section 2
  with the same signature and result columns (expiry sweep of 500 per call first, then ready rows
  minus paused and throttled, token bucket, `row_number()` newest first, chosen by rank then
  `spot_time desc`, claim by `update pgmq.q_deliveries_queue ... where vt <= now`, debit, rows
  returned in the chosen order);
  `throttle_destination(p_destination_id uuid, p_msg_ids bigint[],
  p_seconds int) returns int`;
  `delivery_queue_stats() returns table (depth bigint,
  expired_last_hour bigint)`;
  `mark_deliveries_sent` clears `throttled_until` and decays the level by one; grants to
  `service_role` and `delivery_sender` on the two new RPCs, listed in `sender_role.test.sql`. pgTAP:
  `deliveries_rpc.test.sql` now has 80 assertions covering the Verification list (fairness, budget,
  refill, paused and throttled, throttle backoff and decay, expiry, stats, orphans, grants);
  `push_devices.test.sql` fills the buckets before its claim. Deviations: (1) `throttle_destination`
  returns the seconds used (the spec left the return type open) and raises `Destination not found.`
  for an unknown id. (2) `mark_deliveries_dropped` also stamps `dropped_at`, so
  `delivery_queue_stats` counts the Edge worker's drops during the overlap. (3) The expiry sweep
  walks the queue table (every unsent delivery has a message) and skips messages whose vt is ahead,
  so an in-flight delivery is left to its ack; the next poll sweeps it once visible. (4) pgmq 1.5.1
  has no `last_read_at`, so the claim sets only `vt` and `read_ct`. (5)
  `web/src/lib/database.types.ts` was not regenerated: the checked-in file already lags the
  generator on unrelated tables (`country_daily_spots`, `ComputedFields`), so session 3, the first
  TypeScript session, should regenerate it in one go. Notes for session 3: the sender's calls are
  `claim_deliveries(p_limit => $1, p_vt => $2)`,
  `mark_deliveries_sent(p_delivery_ids => $1,
  p_msg_ids => $2)`,
  `mark_deliveries_failed(p_delivery_ids, p_msg_ids, p_error, p_delay_seconds)`,
  `throttle_destination(p_destination_id, p_msg_ids, p_seconds)` with `p_seconds` null when there is
  no `Retry-After`, `delivery_queue_stats()`, `prune_push_devices(p_endpoints)`,
  `record_push_results(p_ok, p_errors)`. A destination's bucket starts empty and refills from its
  creation, so a brand-new push destination can wait up to 20 s for its first token; the TS age
  check in `handlers/deliver.ts` is now unreachable (SQL expires first with the same thresholds) and
  goes away with `run.ts`. Hand step before `supabase db push`: on hosted, confirm
  `pg_get_userbyid(proowner)` for `public.claim_deliveries` is `postgres` and
  `has_table_privilege('postgres', 'pgmq.q_deliveries_queue', 'update')` is true (locally `postgres`
  owns the queue table). Brad confirmed it true on hosted on 2026-10-15, so the only step left after
  merge is `supabase db push`. Brad has still not noted the 30-day `deliver` invocation count.
- 2026-10-15, session 3 (PR #194): the TypeScript delivery loop. Landed:
  `supabase/functions/_shared/delivery/run.ts` with `runDeliveryBatch(db, send, now, options)`,
  `DeliveryRpc`, `DeliverySender`, `RunDeliveryOptions`, `DeliveryBatchResult`, `DestinationResult`,
  `ClaimError` and the constants `CLAIM_LIMIT` (200), `VISIBILITY_SECONDS` (60),
  `DEFAULT_CONCURRENCY` (4); it imports only `./format.ts`, `./send.ts` and `./types.ts` and loads
  under `deno cache --no-config`. `handlers/deliver.ts` is `isServiceRole`, the adapter
  `supabaseDeliveryRpc(client)` and one `runDeliveryBatch`; a `ClaimError` becomes the 500 as
  before, and the entrypoint passes the request clock through to `sendToDestination`'s `now`.
  `sendWebhook` reports a 429 as `retryAfterSeconds` (Retry-After in whole seconds, else null) with
  the error `Webhook HTTP 429 (rate limited)`. Tests: `delivery_run.test.ts` (18 cases over a fake
  `DeliveryRpc`, including the real `sendDiscord` against a local server with a claim of 300 to show
  the cap is never reached), `handlers_deliver.test.ts` (403, cron JWT, claim 500, the adapter, one
  cycle end to end), two webhook 429 cases in `delivery_send.test.ts`. Shapes session 4 must use,
  exactly:

  ```ts
  interface DeliveryRpc {
    rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: string | null }>;
  }
  type DeliverySender = (
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
    now: Date,
  ) => Promise<SendResult>;
  interface RunDeliveryOptions {
    claimLimit?: number; // p_limit, default CLAIM_LIMIT = 200
    visibilitySeconds?: number; // p_vt, default VISIBILITY_SECONDS = 60
    concurrency?: number; // destinations in flight, default DEFAULT_CONCURRENCY = 4
  }
  // Throws ClaimError when claim_deliveries fails (nothing sent); any other throw is a bug.
  runDeliveryBatch(db, send, now, options): Promise<DeliveryBatchResult>
  // { claimed, sent, failed, throttled, skipped_paused, errors: string[], destinations: DestinationResult[] }
  // DestinationResult: { id, type, name, claimed, sent, failed, throttled, skipped_paused, error? }
  ```

  The loop's RPC calls, in cycle order: `claim_deliveries(p_limit, p_vt)`; per push destination
  `prune_push_devices(p_endpoints)` then `record_push_results(p_ok, p_errors)` as `pushBookkeeping`
  yields them; one `mark_deliveries_sent(p_delivery_ids, p_msg_ids)` with every successful row; then
  per destination either `throttle_destination(p_destination_id, p_msg_ids,
  p_seconds)` (p_seconds
  a number or null) or
  `mark_deliveries_failed(p_delivery_ids, p_msg_ids,
  p_error, p_delay_seconds)`. The ack goes
  before the throttles on purpose: `mark_deliveries_sent` clears `throttled_until`, so the other
  order would lose a 429 that followed a partial success. Bookkeeping runs in claim order whatever
  the concurrency, so a cycle's RPCs are deterministic. `rpc(...).data` for `claim_deliveries` must
  be the row array (postgres.js returns it directly; `msg_id`/`delivery_id` must be Numbers),
  `error` the message or null; `record_push_results`'s `p_errors` is an object, so the postgres.js
  adapter wraps it with `sql.json()`. The sender's `send` is
  `(d, b, now) => sendToDestination(d, b, { allowInsecure, vapid, now })`. Deviations: (1) a webhook
  429 without Retry-After sets `retryAfterSeconds: null` rather than leaving it undefined, since
  undefined is what a failure looks like; `SendResult.retryAfterSeconds` is now
  `number | null | undefined` and the loop throttles whenever it is not undefined. Discord and push
  429s and the Discord cap are unchanged and still pass a number. (2) The paused skip stays in the
  loop as a safety net although the claim already leaves paused destinations out. (3)
  `web/src/lib/database.types.ts` was not regenerated: the local stack belongs to the main checkout
  and may not carry `origin/main`'s migrations, so the next session that resets the local database
  should run the generator. Notes for session 4: the Edge handler's summary log line is the whole
  `DeliveryBatchResult` as JSON (`destinations` included, no secrets); the sender's per-cycle line
  can do the same. `ClaimError` is what the watchdog should not count as a successful claim. Hand
  step after merge: `supabase functions deploy deliver`, which needs session 2's migration pushed to
  hosted first (the loop calls `throttle_destination`). Brad has still not noted the 30-day
  `deliver` invocation count.
