# Outbound sender, Phase 2

Date: 2026-10-31

Status: Piece 1 (LISTEN) and Piece 2 (permanent-failure pause) built, in review; Piece 3
planned. Each PR appends to the Progress log.

This spec supersedes section 9 ("Phase 2 outline") of `2026-10-15-outbound-sender-design.md`.
Read that spec for how the sender, the claim and the outcome RPCs work today; this one only adds
to them. If the design changes during a PR, update this file in that PR.

## Goal

Phase 1 of the outbound sender finished on 2026-10-16. Its section 9 listed Phase 2 as items A to
F, "planned separately after Phase 1", but no separate plan was written. Since then the webhook,
Discord, `/health` and Local DX cluster work changed the ground: A shipped under the webhook spec,
parts of C and D shipped as the webhook pause and the `/health` page, and the webhook spec
recorded "No email" (2026-10-17). B, E and F were never built and nothing tracked them.

Phase 2 is three pieces, each its own PR:

1. **LISTEN.** The sender wakes from its idle sleep when the matcher notifies `deliveries`, so a
   matched spot goes out within about a second instead of up to one poll later. Polling stays.
2. **Permanent-failure pause.** A webhook that answers 410 and a Discord webhook that Discord says
   no longer exists pause at once, on the existing pause mechanism (`enabled = false` plus
   `auto_disabled_at`).
3. **Queue backlog and Clear queue.** Per-destination queue figures for the owner (the
   Destinations page) and the operator (a view), a "backed up" signal decided in SQL, and a Clear
   queue action in the web app and the management API.

Labels: **[DECIDED]** Brad stated or confirmed it; **[OPEN]** not decided, Brad's call. Numbers
called "knob" are starting values in one SQL function, never hardcoded in TypeScript.

## Where section 9 stands

Brad confirmed this scope on 2026-10-31.

| Section 9 item | Status on 2026-10-31 | Decision |
| --- | --- | --- |
| A. Per-event webhooks, push without summary | Done (webhook spec, `webhook_claim_max` 5) | Nothing to do |
| B. In-memory retry layer, cycle pipelining | Not built | Dropped |
| C. Uniform health model, `disabled` state, `failing_since`, `resume_destination`, 410/404/401 split | Webhook pause only (`enabled = false` plus `auto_disabled_at`); resume is `update_destination(enabled = true)` | Build the permanent-failure part on the existing pause (Piece 2). No `disabled` health state |
| D. Queue depth: user email, clear queue, samples table, operator view | `/health` aggregate only | Build per-destination backlog figures (app and operator view) and Clear queue (RPC, web, API) (Piece 3). No email, no samples table |
| E. System emails, `email` destination type | Not built; "No email" decided 2026-10-17 | Dropped. Notices stay in the app |
| F. LISTEN | Not built; the matcher already does `pg_notify('deliveries', '')` | Build (Piece 1) |
| F. Per-destination lease, second machine | Not built | Dropped |
| F. Test sends through the sender (VAPID leaves Edge env) | Not built | Dropped |

## Decisions

### Dropped items

- **[DECIDED]** No email of any kind (section 9 C, D and E). Notices are in-app: the Destinations
  page's banners and the editors' alerts. This confirms the webhook spec's decision 3
  (2026-10-17). No `email` destination type, no provider, no `notice` column on deliveries.
- **[DECIDED]** No in-memory retry layer and no cycle pipelining (section 9 B). Webhook retries are
  a SQL policy the user picks (`webhook_retry_delay`, `webhook_retry_max_attempts`); Discord and
  push keep `backoffSeconds` through `mark_deliveries_failed`. The webhook claim cap (5 requests a
  claim for one request per spot) and the stop-at-first-failure rule already bound head-of-line
  delay to about one request timeout, so a buffer between send and ack would add state that a
  restart loses for no gain.
- **[DECIDED]** No per-destination lease and no second machine (section 9 F). One machine stays
  the rule (CLAUDE.md "Sender rules"); nothing in Phase 2 needs a second.
- **[DECIDED]** Send test does not move into the sender (section 9 F). A test needs a synchronous
  answer in the editor, which the queue cannot give. The VAPID pair stays in both Edge env and the
  sender's secrets, as CLAUDE.md "Push rules" documents.
- **[DECIDED]** No uniform health model, no `disabled` health state, no `failing_since`, no
  `resume_destination` (section 9 C). A pause is `enabled = false` plus `auto_disabled_at`, never
  `health` (CLAUDE.md "Webhook rules"); resuming is `update_destination(..., enabled = true)` or a
  type's save RPC with Enabled on, as it is for the webhook pause today.
- **[DECIDED]** No `destination_queue_samples` table and no queue-growth metric (section 9 D).
  The backlog figures are read live from `deliveries`; loss is `dropped_at`, which exists.

### Piece 1: LISTEN

- **[DECIDED]** LISTEN only wakes the idle sleep between polls. Polling every `SENDER_POLL_MS`
  stays as the safety net, because postgres.js can lose a re-subscribe silently after a
  reconnect, and Supavisor session-mode LISTEN had a 2024 bug report (supabase/supavisor#332,
  status unknown).
- **[DECIDED]** A notify is never watchdog progress. Only a successful claim, a finished send or a
  successful bookkeeping RPC is.
- **[DECIDED]** Notifies coalesce: any number of them during a cycle skips the next idle sleep
  once. A notify during a claim backoff does not shorten the backoff.
- **[DECIDED]** A failed LISTEN is logged and reported once per streak, retried with the claim
  backoff (`RETRY_MIN_MS` doubling to `RETRY_MAX_MS`), and never makes the sender exit.
- **[DECIDED]** No new env knob. The channel is the constant `DELIVERIES_CHANNEL = "deliveries"`.
- **[DECIDED]** `/healthz` gains `listening: boolean`; it never changes the status code.

### Piece 2: permanent-failure pause

- **[DECIDED]** A "gone" reply pauses the destination at once: a webhook's HTTP 410, Discord's 404
  with JSON `code` 10015 ("Unknown Webhook") and Discord's 401 with `code` 50027 ("Invalid Webhook
  Token"). Any other 404 or 401 stays an ordinary failure. Push (404/410 already prune the device)
  and `local_cluster` are unchanged.
- **[DECIDED]** The pause goes through a new sender RPC, `pause_destination`, and uses the
  existing mechanism: `enabled = false` and `auto_disabled_at`, never `health = 'paused'`. The
  claim's unwanted sweep then drops the queue with `dropped_at`, as it does for the webhook count
  pause.
- **[DECIDED]** `pause_destination` takes the delivery ids that failed, so the URL-generation guard
  of `20261021000600` applies: a 410 from the old URL that arrives after the owner replaced the URL
  must not pause the destination at its new URL. When none of the rows was claimed at the current
  `url_generation`, the call only makes those rows visible again.
- **[DECIDED]** Send test never pauses. `handlers/test_delivery.ts` never reads `gone`.
- **[OPEN]** A webhook pauses on 410 whatever its "Pause this destination after repeated failures"
  switch says. Recommended, because 410 is the receiver saying the URL is gone for good, and the
  switch's sentence is about repeated failures. Brad's product call; the alternative is to pause on
  410 only while the switch is on.
- **[DECIDED]** The Discord editor gets the webhook editor's rule: it sends Enabled only when the
  switch changed from what it loaded, null otherwise, so saving a paused destination for another
  reason never resumes it silently. Today `discordModel.ts` sends `enabled` on every save.
- **[DECIDED]** The failing banner on the Destinations page is hidden while `auto_disabled_at` is
  set; the paused alert in the editor and the Paused chip cover it. (Health stays `failing` after a
  count pause, pinned by `webhook_destinations.test.sql`; that is unchanged.)

### Piece 3: queue backlog and Clear queue

- **[DECIDED]** `backed_up` is SQL's: an enabled destination with at least
  `destination_backlog_waiting()` (knob, 100) rows waiting or whose oldest waiting row is at least
  `destination_backlog_age()` (knob, 10 minutes) old. A disabled or paused destination is never
  backed up. The web only words it.
- **[DECIDED]** "Waiting" is a delivery with status `pending` or `failed` (not yet sent, not
  dropped). The figures are `waiting`, `oldest_waiting_seconds` and `dropped_24h` (rows whose
  `dropped_at` is in the last 24 hours: loss, since unwanted and cleared rows keep `dropped_at`
  null).
- **[DECIDED]** Clear queue drops only the destination's waiting rows whose queue message is
  visible now (`vt <= clock_timestamp()`). Rows whose vt is ahead are left: they are in flight in
  the sender, in webhook retry backoff or held by a throttle. Dropping an in-flight row and then
  receiving its `mark_deliveries_failed` would leave a `failed` row with no queue message. The
  confirmation copy says so.
- **[DECIDED]** Cleared rows become `dropped` with `dropped_at` null (the owner chose to drop
  them, so they are not loss) and their messages are archived, the same shape as the claim's
  unwanted sweep.
- **[DECIDED]** CLAUDE.md's "the claim's expiry sweep is the only thing that drops a delivery" is
  already loose (`update_destination`'s resume drops rows in `20261029000700`). Piece 3 rewords it:
  a delivery is never dropped in TypeScript; in SQL it is dropped by the claim's sweeps,
  `update_destination`'s resume and `clear_destination_queue`.
- **[DECIDED]** `GET /v1/destinations/{id}` does not gain queue figures. A later `queue` object
  would be additive. The API gains only `POST /v1/destinations/{id}/clear`.
- **[DECIDED]** The operator's view is `destination_queue_status`, `service_role` only. The sender
  role gets nothing new in Piece 3.
- **[OPEN]** The paused-alert wording for the two gone pauses and the backed-up banner, dialog and
  toast copy. Drafts are in the Copy section, each marked "draft, Brad's call".

### Cross-cutting

- **[DECIDED]** Migration versions: Piece 2 is `20261031000300_pause_destination.sql` and Piece 3
  is `20261031000400_destination_queues.sql`. Open PR #337 (branch `aprs-connections`) owns
  `20261031000100`, and `20261031000200` is left free in case that PR needs a second migration.
  Before pushing a PR with a migration, check `origin/main` for a migration of the same version
  and renumber on a hit.
- **[DECIDED]** PR #337 also redefines `match_pending_spots`. It must keep the
  `pg_notify('deliveries', '')` that Piece 1 listens for; `matcher.test.sql` pins the notify.
- **[DECIDED]** Merge order is 0 (this spec), 1, 2, 3. Pieces 2 and 3 both touch
  `docs/openapi.yaml` and `supabase/tests/management_api.test.sql`, so Piece 3 rebases on Piece 2.
- **[DECIDED]** Applied migrations are never edited. The matcher migration's comment "the sender
  polls today and will LISTEN later" (`20261029000100`) stays; Piece 1 fixes the docs and
  `sender/db.ts` instead.
- **[DECIDED]** `docs/ARCHITECTURE.md` counts the sender's RPCs ("exactly seven"; eleven today,
  twelve after Piece 2). Piece 2 names the allowlist (`SENDER_RPCS`) instead of a count.

## 1. LISTEN in the sender (Piece 1, no migration)

### `sender/db.ts`

- The header comment and the pool comment say the sender LISTENs. postgres.js's listener opens a
  connection of its own outside the pool (`max: 1`, no idle timeout), so the sender holds three of
  the role's four connections (`connection limit 4`, pinned by `sender_role.test.sql`).
- `export const DELIVERIES_CHANNEL = "deliveries"`.
- `SqlClient` gains postgres.js's `listen(channel, onNotify, onListen)` slice, returning
  `PromiseLike<{ unlisten(): Promise<void> }>`. Callers pass all three arguments (no optional
  parameters).
- `SenderDb` gains `listen(channel: string, onNotify: () => void): Promise<{ error: string | null }>`.
  `senderDb(sql)` implements it the way `rpc` handles errors: an `Error` becomes `{ error }`, a
  non-Error rethrows. `close()` is unchanged; `sql.end()` ends the listener too.

### `sender/sender.ts` (`pollLoop`)

- New loop state: `notified`, the current idle wait's `AbortController`, and `listening`.
- `wake()` sets `notified = true` and aborts the current idle wait. It never touches
  `lastProgressAt`.
- The idle sleep becomes `idle(config.pollMs)`: when `notified` is set, clear it and return at
  once; otherwise sleep on a per-wait `AbortController` chained to the loop's `signal`, which
  `wake()` aborts. The injected `sleep(ms, signal)` and the tests' fake clock already honour an
  abort, so there is no new test seam.
- `notified = false` at the top of each cycle, before the claim: a notify during a claim backoff
  is stale once the claim runs, and a notify during the cycle skips the next idle once. The
  backoff sleeps after a failed claim or mark are not wakeable.
- `listenLoop()`: `deps.db.listen(DELIVERIES_CHANNEL, wake)` under `withTimeout`
  (`PROBE_TIMEOUT_MS`). On success it logs `listening for deliveries`, sets `listening` and
  returns. On failure it logs, reports once per streak (its own flag), sleeps `RETRY_MIN_MS`
  doubling to `RETRY_MAX_MS`, and retries. It joins `runLoops`. The start log names the channel.
- `SenderStatus.listening`, and `/healthz`'s body gains `listening` (`sender/health.ts`). The
  deep-equal health fixtures in `sender.test.ts` gain the key.

### Tests

- `sender/__tests__/sender.test.ts`: `fakeDb` gains `listen` (stores the callback, answers
  `{ error: null }` unless the answer table says otherwise) and a `notify()` helper. Cases: a
  notify wakes the idle sleep without the clock moving; a notify during a cycle skips the next idle
  once and only once (the blocked-send pattern); a notify is not progress (the watchdog still
  rejects after `staleMs`); a failed LISTEN is logged and reported once per streak while claims
  keep coming; a notify during a claim backoff does not shorten it.
- `sender/__tests__/db.test.ts`: `fakeSql` gains `listen`; cases for subscribing and relaying a
  notify, and for a rejection's message. A real-database case, gated on
  `SENDER_TEST_DATABASE_URL` like the file's other real cases: `openSenderDb`, `db.listen`, then a
  second raw `postgres` client (test only, as in `profile_lock_db.test.ts`) runs
  `select pg_notify('deliveries', '')`, and the test awaits the callback under a timeout. CI
  already runs this file against the fresh stack.
- Unchanged and passing: `modules.test.ts` (no new env variable), `sender_role.test.sql`,
  `matcher.test.sql` (pins the notify).

### Docs

`docs/ARCHITECTURE.md` (the sender section and the RPC count), `docs/OPERATIONS.md` (the sender
setup, `/healthz` and troubleshooting passages that say the sender only polls). CLAUDE.md "Sender
rules": replace "LISTEN on the matcher's `deliveries` channel is planned, not done" with the rule:
the sender listens through `SenderDb.listen` (pool of 2 plus the listener), a notify only wakes the
idle sleep and coalesces, it is never progress, polling is the safety net, and a failed LISTEN is
logged and reported once per streak, never an exit.

## 2. Permanent-failure pause (Piece 2, migration `20261031000300_pause_destination.sql`)

### Migration

1. `pause_destination(p_destination_id uuid, p_delivery_ids bigint[], p_msg_ids bigint[], p_error text) returns void`,
   plpgsql, security definer, `set search_path = public, pgmq`, modelled on
   `mark_deliveries_failed` in `20261021000600`:
   - lock the destination `for update`; none raises `'Destination not found.'`;
   - the rows in `p_delivery_ids` that belong to this destination become `status = 'failed'`,
     `attempts + 1`, `last_error = p_error`;
   - generation guard: when none of those rows was claimed at the destination's current
     `url_generation`, set their messages' vt to now and return (the new URL gets them next
     cycle), touching nothing on the destination;
   - otherwise the destination gets `enabled = false`,
     `auto_disabled_at = coalesce(auto_disabled_at, now())`, `consecutive_failures + 1`,
     `last_error`, `last_error_at`, and health by the usual rule (`paused` stays, `failing` from 5
     failures), never `health = 'paused'`;
   - every queued `pending`/`failed` message of the destination gets vt now (the statement shape
     `mark_deliveries_failed` uses for the count pause), so the claim's unwanted sweep drops them
     with `dropped_at`;
   - `revoke all ... from public`; `grant execute ... to service_role, delivery_sender`.
2. `get_discord_destination` redefined to return `auto_disabled_at` (it does not today, and the
   Discord paused alert needs it).
3. `api_destination_json`: the `discord` branch gains `auto_disabled_at`, as the `webhook` branch
   has it.

No change to `claim_deliveries`, `update_destination`, `mark_deliveries_failed` or the `save_*`
RPCs: resuming is already `update_destination(..., true)` or a save with Enabled on, which clears
`auto_disabled_at`.

### TypeScript

- `_shared/delivery/send.ts`: `SendResult` gains `gone?: boolean`. `sendWebhook`: status 410
  returns `webhookFailure(..., "Webhook HTTP 410 (gone)", null, true)`; `webhookFailure` gains a
  `gone` argument and every other call passes `false`. `sendDiscord`: for a 404 or a 401, read the
  body with a loose Zod schema beside the 429 one; 404 with `code` 10015 and 401 with `code` 50027
  are `gone`, anything else keeps today's error. Push and `local_cluster` are unchanged.
- `_shared/delivery/run.ts`: when a destination's result has `gone` and failed rows, call
  `pause_destination({ p_destination_id, p_delivery_ids, p_msg_ids, p_error })` in place of
  `mark_deliveries_failed`. It counts (not in `REPEATABLE_RPCS`), so it is tried once; `failed` is
  counted as today; the log line says `is gone: ...; paused`. Per CLAUDE.md "Error reporting
  rules" a user's destination failing is not reported to Sentry; a failed `pause_destination` call
  is a bookkeeping error like a failed `mark_deliveries_failed`.
- `sender/db.ts`: `SENDER_RPCS` gains `pause_destination` with its four typed parameters; the
  comment names the migration.
- `handlers/test_delivery.ts`: unchanged.

### Web

- `web/src/lib/api.ts`: `DiscordDestination.auto_disabled_at`;
  `DiscordDestinationInput.enabled: boolean | null`.
- `discordModel.ts`: `toInput(form, loaded)` sends `enabled` only when the switch differs from
  what was loaded, null otherwise (the rule in `webhookModel.ts`); `discordModel.test.ts` pins it.
- `DiscordDestinationPage.tsx`: load and keep `autoDisabledAt` as `WebhookDestinationPage.tsx`
  does, pass `loaded` to `toInput`, and render the paused `Alert` where the webhook page has it.
- Both editors pick the alert's wording from the destination's `last_error` (which
  `DESTINATION_COLUMNS` already loads): a gone pause has the gone wording, the webhook count pause
  keeps today's "after repeated failed requests" line.
- `DestinationsPage.tsx`: skip the failing banner while `auto_disabled_at` is set.

### API and docs

- `docs/openapi.yaml`: `DiscordSettings` gains `auto_disabled_at` (as `WebhookSettings` has it),
  and the PATCH description names Discord among the types that pause. `openapi.test.ts` needs no
  change.
- `docs/WEBHOOKS.md`: a paragraph on 410 (the destination pauses at once, its queue is dropped,
  turn Enabled on to resume).
- docs-site: `destinations/webhook.md`, `destinations/discord.md`, `destinations/index.md`.
- `docs/OPERATIONS.md`: the paused-destination passage names the gone pause and how to tell it
  from the count pause (`last_error`).
- CLAUDE.md: "Delivery rules" RPC list gains `pause_destination`, plus the gone rule (which
  replies, `SendResult.gone`, `run.ts` calls `pause_destination`, the generation guard applies, it
  pauses whatever the pause switch says if Brad decides so, Send test never pauses). "Webhook
  rules": "A pause is ... never `health`" applies to webhook and Discord. "Discord rules": a
  Discord destination pauses only on a gone reply, and the editor sends Enabled only when the
  switch changed from what it loaded.

### Tests

- pgTAP `deliveries_rpc.test.sql` (about 10 more): the RPC's effect on the rows, the destination
  and the queue (vt now), the next claim dropping the queue with `dropped_at`; `'Destination not
  found.'`; the generation guard after `update_destination` with a new URL (the destination stays
  enabled, the rows are visible); resume through `update_destination(..., true)`.
- pgTAP `discord_destinations.test.sql` (about 4 more): `get_discord_destination` and
  `api_destination_json` carry `auto_disabled_at` (update the exact json pin);
  `save_discord_destination` with Enabled true resumes, with null keeps the pause.
- pgTAP `sender_role.test.sql`: the allowlist gains `pause_destination`; the plan count and the
  header comment follow.
- pgTAP `management_api.test.sql`: the Discord json pin gains the key; PATCH `enabled: true`
  resumes a paused Discord destination. `advisor.test.sql` is unchanged (not client callable).
- Deno `delivery_send.test.ts`: 410 is gone; Discord 404/10015 and 401/50027 are gone; a bare 404
  and a 401 with another code are not. `delivery_run.test.ts`: gone calls `pause_destination` with
  the right ids and no `mark_deliveries_failed`; a failed `pause_destination` is recorded, not
  retried. `sender/__tests__/db.test.ts`: the allowlist list, an `rpcStatement` case, and a
  real-database call with the zero uuid raising `Destination not found.`.
- Web: `DiscordDestinationPage.test.tsx` (alert shown and hidden; an untouched switch sends
  `enabled: null`, a flipped one the boolean), `discordModel.test.ts`, `DestinationsPage.test.tsx`
  (no failing banner for a paused destination).

## 3. Queue backlog and Clear queue (Piece 3, migration `20261031000400_destination_queues.sql`)

### Migration

1. Knobs, one-expression SQL functions, immutable, `set search_path = ''` (the pattern of the
   webhook knobs in `20261018000300`): `destination_backlog_waiting()` returns 100;
   `destination_backlog_age()` returns `interval '10 minutes'`.
2. View `destination_queue_status`, `security_invoker = true`: every destination with lateral
   counts over `deliveries`. Columns: `destination_id, user_id, type, name, enabled, health,
   auto_disabled_at, throttled_until, waiting, oldest_waiting_seconds, dropped_24h`. `waiting` and
   `oldest_waiting_seconds` read status `pending`/`failed` (served by
   `deliveries_destination_status_idx`); `dropped_24h` counts `dropped_at` in the last 24 hours
   (served by `deliveries_destination_dropped_at_idx`). Select granted only to `service_role`;
   not to `delivery_sender` (`sender_role.test.sql` pins that the role selects no view), not to
   `anon` or `authenticated`.
3. `list_destination_queues() returns table (destination_id uuid, waiting int, oldest_waiting_seconds int, dropped_24h int, backed_up boolean)`,
   stable, security definer, `set search_path = public`: a null `auth.uid()` raises
   `'Not signed in.'`; returns the caller's rows from the view, with
   `backed_up = enabled and (waiting >= destination_backlog_waiting() or oldest_waiting_seconds >= extract(epoch from destination_backlog_age()))`.
   Granted to `authenticated`.
4. `clear_destination_queue(p_destination_id uuid) returns int`, security definer,
   `set search_path = public, pgmq`: a null `auth.uid()` raises `'Not signed in.'`; a destination
   the caller does not own raises `'Destination not found.'`; the destination's `pending`/`failed`
   rows whose message is visible (`vt <= clock_timestamp()`) become `status = 'dropped'` with
   `dropped_at` null and their messages are archived (the exact shape of the claim's unwanted
   sweep in `20261028000500`); returns the number of rows dropped. Granted to `authenticated`.
5. `api_call` redefined from `20261029001300`: `clear_destination_queue` in the write list and in
   the destination 404 pre-check; its result is `{"cleared": n}`.
6. Every new function: `revoke all ... from public`, then the grants above.

### API

- `_shared/api/routes.ts`: `["POST", "/v1/destinations/:id/clear", write("clear_destination_queue", "none", {})]`
  after the `/test` route.
- `docs/openapi.yaml`: path `/destinations/{id}/clear`, `operationId: clear_destination_queue`,
  write scope, 200 `{cleared: integer}`, 401, 403, 404, 429 and 500, modelled on
  `/rotate-secret`. `api_routes.test.ts` and `openapi.test.ts` compare automatically.
- docs-site `api-tokens.md`: the route table gains the row.

### Web

- `web/src/lib/api.ts`: a `DestinationQueue` type from the generated `Functions`,
  `listDestinationQueues()` and `clearDestinationQueue(id): Promise<number>`. Regenerate
  `database.types.ts` against the local stack.
- `DestinationsPage.tsx`: load the queues beside the settings summaries and read them again after a
  clear. A `warning` banner per `backed_up` row, after the failing banners, with a Clear queue
  action behind a confirmation. Each card gets its `waiting`. A failed queues load is a toast and
  the page keeps working, because the web deploys before Brad pushes the migration.
- Confirmation: `ConfirmDeleteDialog` (`web/src/layout/`) is delete-specific. Add a generic
  `ConfirmDialog` (title, body, confirm label, confirm color) and have `ConfirmDeleteDialog` render
  through it, so the copy never forks.
- `cardMeta.ts`: `cardMeta(dest, usedBy, waiting, now)` appends `· {N} waiting` when `waiting` is
  above 0; `DestinationCard` takes `waiting`.

### Docs and rules

- CLAUDE.md "Delivery rules": reword the drop sentence (never in TypeScript; in SQL the claim's
  sweeps, `update_destination`'s resume and `clear_destination_queue`); add the queue-figures rule
  (the view and the RPC, `backed_up` decided by the two knobs, the web only words them; Clear drops
  visible `pending`/`failed` rows with `dropped_at` null and leaves rows whose vt is ahead).
  "Web app rules" (or "Delivery rules"): this spec's Copy section is the copy source for the
  backed-up banner and the Clear queue dialog.
- `docs/ARCHITECTURE.md`: a paragraph in the Delivery section.
- `docs/OPERATIONS.md`: an "A destination is backed up" runbook
  (`select * from destination_queue_status order by waiting desc`; the owner's Clear queue; the
  operator's alternative of setting `throttled_until` to hold a queue).
- docs-site `destinations/index.md`: the banner, the card's waiting count and Clear queue.

### Tests

- New pgTAP `supabase/tests/destination_queues.test.sql` (`\ir helpers/users.psql`; purge the
  queue and delete deliveries first, as `claim_expiry.test.sql` does; rows and `pgmq.send_batch`
  as its fixture does): the view's figures, including a backdated `created_at` and `dropped_at`
  counting; `list_destination_queues` (`'Not signed in.'`, only the caller's rows, `backed_up`
  false at 99 waiting and true at 100, true with one 11-minute-old row, false when disabled);
  `clear_destination_queue` (`'Not signed in.'`, another user's id raises `'Destination not
  found.'`, visible rows dropped with `dropped_at` null and their messages archived, the count
  returned, a row whose vt is 50 s ahead left alone, a second call returns 0); `anon` and
  `authenticated` have no select on the view.
- `management_api.test.sql` (3 more): `{"cleared": 0}`; a read token gets LL403; another user's
  id gets LL404. `advisor.test.sql`: the authenticated list gains the two RPCs.
  `sender_role.test.sql` unchanged and passing.
- Deno: `api_routes.test.ts`, `openapi.test.ts`.
- Web: `DestinationsPage.test.tsx` (mock `listDestinationQueues` and `clearDestinationQueue` in the
  explicit `vi.mock` factory; banner only for `backed_up`; confirm, RPC, toast, reload; the card
  meta says "3 waiting"); `cardMeta` cases; a `ConfirmDialog` render test.

## Copy

Every line here is a **draft, Brad's call** ([OPEN]) until a Progress log entry records his
answer. `{…}` marks a value; ages read as "14 minutes ago", as elsewhere in the app. Anything not
listed keeps its current copy.

**Paused alert, editors (Piece 2)**
- Discord, gone pause *(draft, Brad's call)*: Paused {ago}: Discord says this webhook no longer
  exists. Create a new webhook in Discord, select Replace URL, paste it, turn Enabled on and save.
- Webhook, 410 pause *(draft, Brad's call)*: Paused {ago}: the receiver answered HTTP 410 (gone).
  Check the URL, then turn Enabled on and save to resume.
- Webhook, count pause: unchanged, "Paused {ago} after repeated failed requests. Spots waiting to
  be sent were dropped. Turn Enabled on and save to resume."

**Backed-up banner, Destinations page (Piece 3)**
- Title *(draft, Brad's call)*: {name} is backed up
- Body *(draft, Brad's call)*: {N} spots are waiting to be sent, the oldest for {age}. Narrow the
  connections that send to it, or clear the queue.
- Button *(draft, Brad's call)*: Clear queue

**Card meta (Piece 3)**
- *(draft, Brad's call)* `· {N} waiting` after the existing meta, only when {N} is above 0.

**Clear queue dialog (Piece 3)**
- Title *(draft, Brad's call)*: Clear the queue for {name}?
- Body *(draft, Brad's call)*: {N} spots waiting to be sent will be dropped. Spots already being
  sent, or waiting to be retried, are not affected. New spots keep coming.
- Buttons *(draft, Brad's call)*: Cancel · Clear queue

**Toasts (Piece 3)**
- *(draft, Brad's call)* Cleared {n} spots from {name} | Nothing to clear

## Verification

Every PR: `npm run lint`, `npm run typecheck`, `deno task fmt`, `deno task lint`,
`deno task check`, `deno task test`, `deno task coverage` (three roots, each at least 80%, no
unloaded module), `supabase db reset && supabase test db`, `supabase db lint`, and
`cd web && npm run test:all`. A docs-only PR runs the lint and typecheck gates only.

- Piece 1: `deno test -P sender/__tests__/sender.test.ts`; the real LISTEN/NOTIFY round trip with
  `SENDER_TEST_DATABASE_URL="<local DB_URL>" deno test -P sender/__tests__/db.test.ts`. Locally:
  `cd web && npm run sender` against the stack, ingest a spot that matches, and see the claim land
  before the 5 s poll.
- Piece 2: the db gates and the sender's real-database test. Locally: run the sender with
  `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1` and a webhook pointed at a loopback receiver that
  answers 410; watch the destination pause, the editor show the alert, the next claim drop the
  queue, and Enabled on plus save resume it. The same with a Discord URL stubbed to answer 404
  `{"code": 10015}`.
- Piece 3: the db gates; the regenerated `database.types.ts` diff is additions only. Locally:
  queue 100 or more rows for a throttled destination, see the banner, clear, see the count and the
  card.

## PR plan

Each PR is built from its own worktree off `origin/main` (never a branch switch in the main
checkout), appends a Progress log entry, lists Brad's hand steps in its body, and stops. No PR
runs `supabase db push`, `supabase functions deploy`, `fly deploy` or `fly secrets set`.

| # | PR | Worktree and branch | Migration | Gate |
| --- | --- | --- | --- | --- |
| 0 | This spec | `../longlines-sender-phase-2-spec`, `sender-phase-2-spec` | none | none |
| 1 | LISTEN | `../longlines-sender-listen` | none | 0 merged |
| 2 | Permanent-failure pause | `../longlines-pause-gone` | `20261031000300_pause_destination.sql` | 1 merged |
| 3 | Queue backlog and Clear queue | `../longlines-queue-clear` | `20261031000400_destination_queues.sql` | 2 merged (rebase on it) |

## Hand steps for Brad (hosted; never run by a session)

- Piece 0: none.
- Piece 1: nothing before the merge; the merge deploys the sender through Fly's GitHub
  integration. Afterwards: `fly logs -a longlines-sender` shows `listening for deliveries`;
  `/healthz` says `listening: true`; a matched spot is claimed within about a second. If LISTEN
  never establishes through Supavisor, polling carries on and the Progress log records it.
- Piece 2: `supabase db push` right after the merge. The sender deploys on the same merge; until
  the migration lands, a gone reply makes `pause_destination` a logged bookkeeping error and the
  rows reappear after the visibility timeout. Confirm with
  `select proname from pg_proc where proname = 'pause_destination'`. The `send-test` and `api`
  functions bundle `send.ts` but never read `gone`, so redeploying them is optional (the API's
  Discord `auto_disabled_at` comes from SQL's `api_destination_json`).
- Piece 3: `supabase db push` right after the merge (the web deploys on the same merge and shows a
  toast for the queues load until then); `supabase functions deploy api` for the new route.
  Verify with `select * from destination_queue_status limit 5` and one
  `POST /v1/destinations/{id}/clear` with a write token.
- Every piece: answer the [OPEN] items (the 410 call and the copy drafts) on the PR; the PR that
  lands an answer records it in the Progress log.

## Progress log

Append one entry per PR: date, piece, what landed, PR, deviations from this spec, notes for the
next PR. Earlier entries are never edited.

- 2026-10-31, Piece 0 (PR #338, branch `sender-phase-2-spec`): this spec, planning only; no code, no
  migration. Records Brad's 2026-10-31 scope: no email (notices stay in the app), no in-memory
  retry or pipelining, no lease, no Send test through the sender; build LISTEN, the
  permanent-failure pause, and the queue backlog with Clear queue. The 2026-10-15 spec's Status
  line now points here as superseding its section 9, and CLAUDE.md "Sender rules" names this file.
  Deviation from the approved plan: the migrations are `20261031000300` and `20261031000400`, not
  `20261031000100` and `20261031000200`, because open PR #337 owns `20261031000100` and
  `20261031000200` is held for it. Open for Brad: the 410-pauses-whatever-the-switch call and every
  line in the Copy section. Notes for Piece 1: PR #337 also redefines `match_pending_spots` and
  touches `sender/__tests__/sender.test.ts` and `docs/openapi.yaml`; expect a rebase, and check
  that the `pg_notify('deliveries', '')` survives it.
- 2026-10-31, Piece 1 (PR #341, branch `sender-listen`, on `main` after #337 and #338 merged): LISTEN in
  the sender, no migration. #337's `match_pending_spots` (`20261031000100`) keeps the
  `pg_notify('deliveries', '')`. `sender/db.ts` gains `DELIVERIES_CHANNEL`, `SqlClient.listen` (postgres.js's
  three-argument slice) and `SenderDb.listen`, which answers a failed LISTEN as `{ error }` like
  `rpc`. `sender/sender.ts`: `wake()` sets `notified` and aborts the idle wait; `idle(pollMs)`
  replaces the poll sleep and returns at once when a notify came in during the cycle; `notified`
  is cleared before each claim; the two backoff sleeps keep the loop signal, so a notify never
  shortens them; `listenLoop` tries once, then on failure logs, reports once per streak and
  retries at `RETRY_MIN_MS` doubling to `RETRY_MAX_MS`, and never exits. `SenderStatus.listening`
  and `/healthz` `listening`; the start line names the channel. Tests: six new `sender.test.ts`
  cases (a notify wakes the idle sleep without the clock moving; notifies during a cycle skip the
  next idle once and only once; a notify is not progress; a notify does not cut a claim backoff
  short; a failed LISTEN is retried with backoff, reported once and claims keep coming; a LISTEN
  that never answers counts as failed after `PROBE_TIMEOUT_MS` and does not hold up shutdown), and
  in `db.test.ts` the fake's `listen`, a relay case, a rejection case, a non-Error rethrow, and the
  real LISTEN/NOTIFY round trip against `SENDER_TEST_DATABASE_URL`. Docs: ARCHITECTURE.md (the
  matcher paragraph, the allowlist named instead of "exactly seven", `/healthz`, "Reaching the
  queue"), OPERATIONS.md (overview, `SENDER_POLL_MS`, `/healthz` and a `listening` paragraph,
  the cutover note) and CLAUDE.md "Sender rules". Deviations: (1) the LISTEN attempt is raced
  against the injected `sleep(PROBE_TIMEOUT_MS)` and the loop signal instead of `withTimeout`, so
  the fake clock drives the timeout in tests and shutdown never waits up to 30 s for a hung
  attempt; same limit, same message shape. (2) The round trip's second session is
  `postgres(clientOptions(...))`, not a URL, because a bare URL makes postgres.js read PG*
  variables the test permissions deny. (3) Found while reading postgres.js 3.4.9: a failed
  `listen()` keeps its listener, and the listener connection's `onclose` re-subscribes every kept
  listener, so each retry after a failure can add one more `wake` callback; `wake` is idempotent,
  so the cost is a closure per retry (at most one a minute during an outage). Documented on
  `SenderDb.listen`; not worked around. Notes for Piece 2: `SENDER_RPCS` is unchanged here; the
  docs now name the allowlist, so adding `pause_destination` means adding it to the
  ARCHITECTURE.md list as well.
- 2026-10-31, Piece 1 review (PR #341): an independent review found no code defect. It changed
  one sentence in ARCHITECTURE.md, which said a matched spot "is claimed within about a second":
  a notify makes the claim run at once, but a destination's batch hold and claim interval still
  decide when its rows are claimable. Checked against postgres.js 3.4.9 that a LISTEN failing at
  start recovers once the database answers (postgres.js retries on its own, the next attempt
  resolves) and that each failed attempt leaves one extra `wake` callback, as recorded above.
- 2026-10-31, Piece 2 (branch `pause-gone`, stacked on `sender-listen`): the permanent-failure
  pause, migration `20261031000300_pause_destination.sql`. `pause_destination(destination,
  delivery ids, msg ids, error)` locks the destination, marks the rows of that destination failed
  (attempts + 1, `last_error`), and then either pauses it (`enabled = false`,
  `auto_disabled_at = coalesce(auto_disabled_at, now())`, `consecutive_failures + 1`, `last_error`,
  `last_error_at`, health by the usual rule, never `paused`; every queued pending or failed row of
  it made visible for the unwanted sweep) or, when none of the rows was claimed at its current
  `url_generation`, only makes those rows visible again. Granted to `service_role` and
  `delivery_sender`. `get_discord_destination` and `api_destination_json`'s `discord` object gain
  `auto_disabled_at`. `send.ts`: `SendResult.gone`; `sendWebhook` answers a 410 with
  `Webhook HTTP 410 (gone)`; `sendDiscord` reads a 404 or 401 body with a loose schema and answers
  code 10015 with `Discord HTTP 404 (Unknown Webhook)` and code 50027 with
  `Discord HTTP 401 (Invalid Webhook Token)`, every other 404 or 401 keeping `Discord HTTP 404`
  or `401`. `run.ts` calls `pause_destination` in place of `mark_deliveries_failed` for a gone
  result with failed rows (tried once) and logs `is gone: ...; paused`. `SENDER_RPCS`,
  `db.test.ts` and `sender_role.test.sql` (`plan(23)`) gain it. Web: `DiscordDestination.auto_disabled_at`,
  `DiscordDestinationInput.enabled: boolean | null`, `discordModel.toInput(form, loaded)` with the
  webhook editor's keep-Enabled rule, the Discord editor's paused alert, the webhook editor's
  alert worded by the row's `last_error`, and no failing banner on the Destinations page while
  `auto_disabled_at` is set. `database.types.ts` regenerated (adds `pause_destination`). Docs:
  openapi (`DiscordSettings.auto_disabled_at`, the PATCH description, `WebhookSettings`'
  description), WEBHOOKS.md (a 410 paragraph), ARCHITECTURE.md (the allowlist, the gone reply),
  OPERATIONS.md ("A destination paused itself"), the docs site's webhook, Discord and index pages,
  and CLAUDE.md ("Delivery rules", "Webhook rules", "Discord rules", "Sender rules"). Built as the
  recommended answer to the [OPEN] 410 call: a webhook pauses on 410 whatever its pause switch
  says; still Brad's call. The two paused-alert lines are the Copy section's drafts, word for word.
  Deviations and additions: (1) the webhook editor's wording keys on `WEBHOOK_GONE_ERROR` in
  `webhookModel.ts`, and a Vitest case checks that `send.ts` still contains that text; the page
  reads `last_error` from the list's row, since `get_webhook_destination` does not return it.
  (2) The Discord editor always uses the gone wording, because a Discord destination has no count
  pause. (3) `pause_destination` with an empty delivery id list changes nothing (it reads as
  claimed before a URL change); the sender never calls it without failed rows. (4) pgTAP grew by
  17 in `deliveries_rpc.test.sql` (a paused destination keeps its first `auto_disabled_at`, a row
  of another destination is ignored, clients cannot call it), 5 in
  `discord_destinations.test.sql` and 2 in `management_api.test.sql`. (5) `HealthChip`'s comment
  now names Discord. Notes for Piece 3: `docs/openapi.yaml` and `management_api.test.sql`
  (`plan(108)`) changed here; rebase on this branch.
