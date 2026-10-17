# Push Notifications: Page 5 on the Sender, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 3, 2026-10-16. Revision 1 (#181) planned page 5 on the Edge `deliver` worker; revision 2
(#187) replaced templates with field picks; this revision re-plans everything left against the
outbound sender, which replaced the Edge worker on 2026-10-16. Parts 0 and 1 are done and stay
recorded below; Parts 2 to 5 are re-planned.

**Goal:** Finish push notifications so the web app matches **Page 5 of Brad's design canvas**: a
Destinations card grid with push cards, an Add destination type picker, a full-page push
destination editor (devices, notification fields, delivery settings, live preview), an Add a device
dialog with its iPhone variant, on top of the installable PWA (merged) and the sender (merged).

**Architecture:** The sender (`sender/` on Fly.io) polls `claim_deliveries` and sends what it is
handed; every decision is in Postgres. So page 5's per-destination settings reach the sender inside
the claim's `destination` jsonb (`push`, `quiet_now`, member `devices`) and `spot` jsonb
(`push_title`, `push_body`, `push_url`, `push_source_url`), built by SQL from an ordered pick of
fields, never a template. The budget (3 a minute per push destination, newest first, no summary)
and expiry already live in SQL knobs; the per-destination "drop if offline" is a column the expiry
sweep reads. The sender's RPC allowlist, grants and env list do not change. `send-test` stays an
Edge Function until the sender spec's Phase 2 F.

**Tech Stack:** Postgres (plpgsql, pgTAP, pgmq), the sender (Deno on Fly, postgres.js), Deno Edge
Functions (`send-test`, `api`), React 19, MUI 9, react-router 8, Vitest + Testing Library, Web Push.

**Design sources:**
- Canvas page 5 (`https://claude.ai/artifact/JyDdSRy1MCxeHJbYLgz7xh#page-a34d51868905`), seven
  artboards, transcribed in the **Copy** section below; sessions never read the canvas.
- `docs/superpowers/specs/2026-10-13-push-notifications-design.md`: its "Amendment, 2026-10-15:
  page 5" (model, schema, decisions 1 to 15, copy) and "Amendment, 2026-10-16: the sender" (what
  the sender changes). The later amendment wins.
- `docs/superpowers/specs/2026-10-15-outbound-sender-design.md`: sections 2, 3, 9 and 10 are the
  constraints on anything that touches delivery.

## Where things stand

| Area | State |
| --- | --- |
| Part 0, spec amendment for page 5 | Merged (#183), field picks (#187); the sender amendment is in this revision's PR |
| Part 1, PWA shell: manifest, icons, `sw.ts` (already displays `actions`, `silent`, `renotify`, `sourceUrl`), `register.ts`, `/sw.js` headers | Merged (#184) |
| PR 1 (#157): `push_devices`, device RPCs, `webpush.ts`, `sendPush`, `prune_push_devices`, `record_push_results` | Merged; the sender calls the last two through its allowlist |
| Outbound sender, Phase 1 | Merged (#188 to #204), hosted; `deliver` deleted. The sender holds `SENDER_DATABASE_URL` only: **no VAPID pair exists yet** |
| Part 2, schema and delivery for page 5 | PR 3 (`push-schema-3`): migration `20261016000400`, delivery on the sender, send-test, API, docs. The `push-schema-2` draft was quarried, not merged |
| Parts 3 to 5, the web | Not started. `DEST_TYPES` has Discord and webhook; the Destinations page is a `List` |
| `VAPID_PUBLIC_KEY` on Vercel | Not set |

## What the sender changes for this plan

1. **Policy is SQL; the sender only sends.** Anything page 5 lets a user set about delivery
   (urgency, drop-after, replace, sound, quiet hours) is a column on `push_destination_settings`
   that `claim_deliveries` reads and hands to the sender inside the jsonb it already returns. The
   claim's signature and result columns never change (sender spec, section 10).
2. **No summary.** The push budget is 3 spots a minute per push destination, newest first
   (`destination_budget`). `pushNotifications` becomes one notification per spot; the summary
   branch and `PUSH_NOTIFICATIONS_PER_RUN` go.
3. **Expiry is the claim's sweep**, keyed on `destination_max_age(type)`. "Drop if the device is
   offline for" overrides it per push destination through `coalesce(settings.ttl_seconds, …)`.
4. **Quiet hours** are decided once per destination per claim (`quiet_now` in the destination
   jsonb). "Don't send" is a `sendPush` that makes no request and reports the batch sent.
5. **No new sender RPCs.** `SENDER_RPCS`, the grants and `sender_role.test.sql` stay as they
   are; `sender/` is untouched. A merge that changes `_shared/delivery/*` deploys the sender
   through Fly's integration, so the TypeScript must work with and without the migration
   (defaults when `destination.push` is absent).
6. **`send-test` stays on Edge** with the VAPID triple in Edge env; the sender has the same pair.
7. **Enabled** is enforced where the sender spec already enforces subscription state: the
   matcher and the claim's "unwanted" sweep.
8. **Migration number** `20261016000400` (the old `…15000200` is the sender role).
9. **Local end to end** uses `npm run sender` (opt in, `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1`),
   not `invoke:deliver`, which is gone.

## How to run this plan: four parts left, three PRs

Run each part in a fresh Claude Code session in its own worktree from `origin/main`
(`git worktree add ../longlines-<branch> -b <branch> origin/main`). The shared worktree
`longlines-push-web` is on `push-schema-2` and is left alone as the quarry.

| Part | Tasks | Produces | Branch | PR |
| --- | --- | --- | --- | --- |
| 2 | Tasks 3–5 | Migration `20261016000400`, delivery changes, send-test, API, tests, docs | `push-schema-3` | PR 3 |
| 3 | Tasks 6–8 | `api.ts`, `pwa/push.ts`, Destinations card grid, type picker | `push-ui` | PR 4 (draft) |
| 4 | Tasks 9–11 | Push destination editor, devices card, Add a device dialog, preview | `push-ui` | PR 4 (draft) |
| 5 | Tasks 12–13 | Install app, refresh on load, sign-out cleanup, docs, gates, end to end | `push-ui` | PR 4 (ready) |

PR 3 is safe to merge alone: existing push destinations keep every device and get default
settings; the sender redeploys with defaults for rows claimed before the migration is pushed, and
nothing user-visible changes until PR 4. PR 4 needs PR 3 merged and pushed to hosted.

### Branches and PRs

- **Part 2** starts `push-schema-3` from `origin/main` once this revision's docs PR is merged.
  **Part 3** starts `push-ui` from `origin/main` once PR 3 is merged; otherwise from `push-schema-3`
  (stacked) and says so in the PR text. Parts 4 and 5 continue on `push-ui` in the same worktree.
- Never `git checkout` or `git switch` in a worktree another session may hold. Always
  `git push -u origin <branch>` with the branch named.
- `gh pr create --base <base>`; the repo deletes branches on merge and GitHub retargets stacked PRs.
  Part 3 opens PR 4 as a draft; Part 5 marks it ready after every gate passes.
- Before pushing a PR with a migration, check `origin/main` for a newer migration with the same
  version; renumber and merge main in if so (it happened twice in the sender sessions).
- PR text follows #157 and the sender PRs: what it does, what's still to come, testing with real
  numbers, Brad's hand steps, and whether merging applies a migration or deploys the sender.
- Nothing is pushed to hosted, merged or deployed by a session. Don't run pgTAP in two sessions
  at once; the local stack is shared.

## Decisions (accepted by Brad, 2026-10-16, before Part 2)

The page 5 amendment's decisions 1 to 15 stand, including decision 4's separator options and title
labels. The sender amendment adds, all *decided 2026-10-16*:

- **S1.** No summary notification; one per spot within the 3-a-minute budget. Withdraws
  decision 16.
- **S2.** "Drop if the device is offline for" overrides the expiry sweep per destination (values
  5 min to 4 hours, default 30 min); the `TTL` header sends the same number.
- **S3.** `quiet_now` per destination per claim; "Don't send" is acked as sent without a request.
- **S4.** A device in several push destinations gets up to 3 a minute from each.
- **S5.** `send-test` stays on Edge with its own copy of the VAPID pair until Phase 2 F.
- **S6.** Enabled is enforced in the matcher and the claim's unwanted sweep, nowhere in TypeScript.

## Brad's steps (no part does these)

1. Generate the VAPID pair once: `deno run scripts/generate-vapid-keys.ts mailto:<contact>`.
2. Set it in three places: `fly secrets set -a longlines-sender LONGLINES_VAPID_PUBLIC_KEY=… LONGLINES_VAPID_PRIVATE_KEY=… LONGLINES_VAPID_SUBJECT=…`
   (the sender restarts), `supabase secrets set` with the same three names then redeploy
   `send-test` and `api`, and `VAPID_PUBLIC_KEY` in the Vercel project env (production and preview)
   once PR 4 lands.
3. After PR 3 merges: `supabase db push` (the sender redeploys itself on the merge), then redeploy
   `send-test` and `api`.
4. For end-to-end checks on a PR's Supabase preview branch, the preview project needs the same
   three Edge secrets.

## Global Constraints

- Work only in the part's worktree on its branch. Never `supabase db push`, `functions deploy`,
  `fly deploy`, `fly secrets set`, `supabase secrets set` or `vercel`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Applied migrations are never edited. The claim's signature and result columns never change; new
  policy is a column or a knob function. `claim_deliveries` and `match_pending_spots` are recreated
  from their **latest** definitions on `origin/main` (`20261016000100` and `20261015001200`),
  never from the drafts on `push-schema-2`.
- Behaviour goes in SQL: field rendering, source URLs, quiet hours, device membership, name
  uniqueness, enabled, expiry. The sender, `send-test` and the web never build notification text,
  work out a base call, cap, order, age-check or drop a delivery.
- `sender/` is not touched by this plan. `_shared/delivery/*` changes must load under
  `deno run --no-config` (no import-map imports) and must behave with and without the migration.
- `web/src/lib/api.ts` stays the only supabase-js module. `web/src/pwa/push.ts` is the only module
  that touches `PushManager`, `Notification` and `PushSubscription`. `register.ts` is the only
  module that calls `navigator.serviceWorker.register`. The service worker is done (#184).
- No endpoint, `p256dh` or `auth` is ever rendered, logged or returned to a client; only
  `claim_deliveries` hands keys to the sender.
- Notification text is an ordered pick of fields (decision 4): no text input, no template, every
  name checked in SQL against `push_fields()`.
- `vite.config.ts`: `VITE_VAPID_PUBLIC_KEY` is the one new `define` entry; `envPrefix` stays.
- Copy is word for word from the **Copy** section below, then the spec's Copy. Say "subscription",
  never "connection".
- No new runtime dependency anywhere.
- MUI 9 rules from CLAUDE.md: `sx` for layout only; colours, borders and shadows from props and
  variants (the preview mock-ups use `Paper` elevation and palette colours, never the canvas's hex
  or gradients); `Grid size`; `slotProps`; no `fontWeight` prop; MUI icons only.
- Web tests render through `web/src/test/render.tsx` with `vi.mock("../lib/api")` factories; pure
  `*.test.ts` stay in node; `setMobile(true)` for the phone layout. Gates per part:
  `cd web && npm run coverage`, `npm run build`, `npm run lint`; `deno task coverage`,
  `deno task check`, `deno task lint`; `supabase db reset && supabase test db`;
  `SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts`; `npm run test:all`
  once before a PR is marked ready.

## Review Focus

- Secrets: the member device list in the claim is the only place keys travel; `get_push_destination`
  and `list_push_devices` return ids, names, descriptors and status only.
- Both merge orders are safe: the new sender code with the old claim (no `push` key) sends with
  today's urgency, TTL and text; the new claim with the old sender is ignored extra keys.
- `sender_role.test.sql` passes unchanged: no new grant to `delivery_sender`, nothing on the new
  tables.
- The user gesture: `Notification.requestPermission()` is the first statement of `enablePush()`.
- Text is built by one SQL function from field names only; the preview RPC and `claim_deliveries`
  both call it; `format.ts` never concatenates spot fields. No free text reaches a notification.
- A quiet-skipped batch is acked as sent, never retried, never a failure, and makes no request.
- The migration is safe on hosted data: existing push destinations keep every device as members,
  get default settings, and duplicate names are renamed before the unique index is created.

---

## Part 0: Spec amendment (done: #183, #187; the sender amendment ships with this revision)

### Task 0: Record the page 5 design in the spec

- [x] Add a section "Amendment, 2026-10-15: page 5" at the top of the spec: the model change, the schema, the decisions, the Copy.
- [x] CLAUDE.md "Push rules" updated for many push destinations, membership, SQL-built text, the web rules.
- [x] Commit `Spec: push destinations follow canvas page 5`, push, open the spec PR.

## Part 1: PWA shell (done: #184)

### Task 1: Manifest, icons and `index.html`

- [x] Manifest, committed icons, `index.html` tags, `manifest.test.ts`.

### Task 2: Service worker, registration, build and headers

- [x] `sw-handlers.ts` (push with `actions`, `silent`, `renotify`, `sourceUrl`; click with `action`; subscription change posting to clients), `sw.ts`, `tsconfig.sw.json`, the Vite input emitting `/sw.js`, `register.ts`, Vercel headers, tests, ARCHITECTURE.

---

## Part 2: Schema and delivery for page 5 on the sender (PR 3, branch `push-schema-3`)

### Task 3: Migration `20261016000400_push_destinations_v2.sql`

**Files:** the migration; `supabase/tests/push_destinations.test.sql` (new); `push_devices.test.sql`, `deliveries_rpc.test.sql`, `advisor.test.sql`, `management_api.test.sql`, `account_delete.test.sql`, `sender_role.test.sql` (must pass unchanged); `supabase/seed.sql`; `scripts/smoke-test.sql` if it lists tables.

- [x] **Quarry, don't merge.** `git show push-schema-2:supabase/migrations/20261015000200_push_destinations_v2.sql` holds a draft of the destinations changes, `push_devices` columns and RPCs, `push_destination_devices`, `push_destination_settings`, `save_push_destination`, `get_push_destination`, `duplicate_destination`, `api_destination_json` and `api_call`, plus `push_destinations.test.sql` and the `push_devices.test.sql` changes. Copy what fits, converting templates to field picks (decision 4). Do **not** take its `claim_deliveries` or `match_pending_spots`: both predate the sender. Recheck the migration number against `origin/main` and every open branch before creating the file.
- [x] **Destinations.** `drop index destinations_one_push_per_user`. `add column enabled boolean not null default true`. Rename hosted duplicates (per user, case-insensitive, oldest keeps its name, then " (2)", " (3)"…), then `create unique index destinations_user_name_key on destinations (user_id, lower(name))`. `create_destination` and `update_destination` (which gains `p_enabled boolean default null`) catch `unique_violation` on it and raise "A destination named {name} already exists. Choose a different name."; `create_destination('push', …)` no longer raises "You already have push notifications."
- [x] **Matcher.** Recreate `match_pending_spots` from `20261015001200` (keep the `pg_notify`, the enabled-subscription and linked-destination checks) so the `subscription_destinations` join also requires `destinations.enabled`.
- [x] **Devices.** `push_devices`: `add column agent text not null default ''`, `standalone boolean not null default false`, `blocked_at timestamptz`; backfill `agent = label`. `register_push_device(p_endpoint, p_p256dh, p_auth, p_label, p_agent, p_standalone)` upserts as before, never creates a destination, clears `blocked_at`, returns the device id; drop the five-argument overload. `rename_push_device(p_id, p_label)`, `report_push_device_blocked(p_endpoint)`. `list_push_devices(p_current_endpoint)` returns `id, label, agent, standalone, created_at, last_success_at, last_error, last_error_at, blocked_at, is_current, destination_ids uuid[]`.
- [x] **Membership.** `push_destination_devices (destination_id, device_id)`, both cascading, RLS on, no policies, client grants revoked, nothing for `delivery_sender`. Backfill: every existing push destination gets every device of its owner.
- [x] **Settings.** `push_destination_settings (destination_id pk → destinations cascade, title_fields text[], body_fields text[], show_field_names bool, body_separator in ('dot','comma','newline'), tap_target in ('profile','source'), action_buttons bool, urgency in ('low','normal','high'), ttl_seconds in (300,900,1800,3600,14400), replace_same_station bool, sound bool, quiet_enabled bool, quiet_from time, quiet_until time, quiet_mode in ('silent','skip'))`, same RLS pattern. `push_fields()` is the fixed list; a check constraint and `save_push_destination` require every name in it, no duplicates, 1 to 4 title fields, 0 to 8 body fields ("Unknown field {name}.", "Pick 1 to 4 fields for the title.", "Pick up to 8 fields for the body."). `push_default_settings()` holds decisions 4 and 7's defaults; a trigger on `destinations` inserts them for every new push row; backfill existing ones.
- [x] **Rendering.** `render_push_field(p_field, p_spot jsonb)` (one fixed rendering per field per decision 4, null when the spot lacks it), `push_field_label(p_field)` (the display name), `render_push_fields(p_fields, p_spot, p_separator, p_labels)` (in order, skips nulls, "Label: value" when `p_labels`, joins with " · " / ", " / a newline), `spot_source_url(p_spot)` (POTA park, SOTA summit, WWFF reference page if one exists, else null), `push_quiet_now(settings, timezone, at)` (ranges across midnight). All immutable with `search_path` pinned, or listed among the inlinable helpers in `advisor.test.sql`.
- [x] **`claim_deliveries`.** Recreate from `20261016000100`, keeping its unwanted sweep, expiry, orphans, budget, rank, claim and debit exactly, with these additions only: the unwanted sweep also drops rows whose destination is not `enabled`; the expiry sweep uses `coalesce(ps.ttl_seconds * interval '1 second', destination_max_age(dest.type))` through a left join on `push_destination_settings`; the return's device list comes from `push_destination_devices` joined to `push_devices` with `blocked_at is null`, aggregated once per destination in a CTE keyed by destination id (this fixes #159 for push); the destination jsonb gains `push` (the settings row as jsonb) and `quiet_now` (`push_quiet_now` with the owner's `profiles.timezone`, once per destination); the spot jsonb gains `push_title`, `push_body`, `push_url` (`/call/<base_callsign>` or `spot_source_url` per `tap_target`, falling back to the profile) and `push_source_url`. Same signature, same result columns, same order.
- [x] **Client RPCs** (security definer, pinned `search_path`, `revoke all from public`, `grant execute to authenticated`, listed in `advisor.test.sql`, "Not signed in." without `auth.uid()`): `save_push_destination(p_id, p_name, p_enabled, p_settings jsonb, p_device_ids uuid[]) returns uuid`, `get_push_destination(p_id) returns jsonb` (settings + `device_ids`), `duplicate_destination(p_id) returns uuid` (push only; "Copy of {name}", `enabled` false, settings and members copied, fresh throttle state), `preview_push_notification(p_title_fields, p_body_fields, p_show_field_names, p_body_separator, p_spot_id bigint default null) returns table (title, body, url, source_url)` (same field checks; against `raw_spots` or `push_sample_spot()`), `rename_push_device`, `report_push_device_blocked`.
- [x] **Sender role.** Nothing: `prune_push_devices` and `record_push_results` are unchanged, and `sender_role.test.sql` must pass as is (it pins the exact function list and no table privileges).
- [x] **API.** `api_destination_json` gains `enabled` and, for push, `push` (settings and `device_count`, never devices). `api_call`'s allowlist and the route table gain `enabled` on PATCH (`api_routes.test.ts`); `POST /destinations` with `type: "push"` always works. `docs/API.md`: the "at most one push destination" paragraph goes; devices stay browser-only.
- [x] **Seed.** One push destination with settings for the synthetic user, no devices.
- [x] **pgTAP** `push_destinations.test.sql`: two push destinations per user; unique names and the error; the hosted-duplicate rename on a fixture; `enabled` false keeps a spot out of `deliveries` and drops a queued one on the next claim (fill the token bucket first, as `push_devices.test.sql` does); membership save/replace and the foreign-device rejection; `render_push_field` for every field and a missing one; `render_push_fields` order, skipping, the three separators and labels; the field checks; `spot_source_url` per source; `push_quiet_now` inside, outside, across midnight in `America/New_York`; `claim_deliveries` returning members only, skipping blocked devices, carrying `push`, `quiet_now`, `push_title`, `push_body`, `push_url`, with the per-destination TTL expiring a 31-minute-old row for a 30-minute destination and keeping it for a 4-hour one; `preview_push_notification` agreeing with `claim_deliveries` for the same spot; `duplicate_destination`; RLS on the new tables; cascades. Update `push_devices.test.sql` for the new `register_push_device`, rename, blocked and `list_push_devices` columns; `deliveries_rpc.test.sql` for the enabled sweep; `advisor`, `management_api` (push POST twice; `enabled` PATCH), `account_delete`.
- [x] `supabase db reset && supabase test db`; `scripts/smoke-test.sql`; `SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts`; `npm run supabase:types` and commit `database.types.ts`.
- [x] Commit `Push destinations: many per account with picked devices, field picks and delivery settings`.
  Done with two deviations, both recorded in the spec: Send test reads `push_test_delivery`
  (service-role only) rather than `preview_push_notification`, which needs `auth.uid()`; and
  `watched_among` gained the matcher's enabled-destination check, as CLAUDE.md asks. The seed is
  unchanged: it has no synthetic user to own a push destination.

### Task 4: Delivery on the sender, and send-test

**Files:** `supabase/functions/_shared/delivery/types.ts`, `format.ts`, `send.ts`, `handlers/test_delivery.ts`, their tests (`delivery_format`, `delivery_send`, `delivery_run`, `handlers_test_delivery`), `docs/WEBHOOKS.md` only if the webhook payload changes (it must not).

- [x] `types.ts`: `PushSettings` (mirror of the settings row); `DeliveryDestination.push?: PushSettings` and `quiet_now?: boolean`; `DeliverySpot` gains optional `push_title`, `push_body`, `push_url`, `push_source_url`; `PushNotification` gains `sourceUrl?`, `actions?`, `silent?`, `renotify?` (the shape `sw-handlers.ts` already parses). `webhookPayloads` strips the `push_*` keys so webhook consumers see the documented shape (test it).
- [x] `format.ts`: `pushNotifications(spots, settings?)` builds **one notification per spot** from `push_title`/`push_body`/`push_url` (falling back to today's text when the keys are absent); tag `spot:<CALL>` when `replace_same_station` (default), else `spot:<CALL>:<id>`; `actions` when `action_buttons` (the source button only when `push_source_url` is set); `silent`/`renotify` from `sound` and `quiet_now` with `quiet_mode === "silent"`. Delete the summary branch and `PUSH_NOTIFICATIONS_PER_RUN`. The worst-case payload stays under 3,000 bytes with both actions (test).
- [x] `send.ts`: `Urgency` and `TTL` from `destination.push` (today's `high` and 900 when absent). When `destination.quiet_now && push.quiet_mode === "skip"`, `sendPush` returns `{ok: true, sent: deliveries.length}` without a request or bookkeeping, so `runDeliveryBatch` acks the batch. Nothing else in `run.ts` changes; `sender/` is untouched; the Dockerfile's `--allow-env` list is unchanged (`sender/__tests__/modules.test.ts` proves it).
- [x] `test_delivery.ts`: devices from `push_destination_devices` for that destination (members, `blocked_at is null`), not the owner's; body `{destination_id, spot_id?}`; the delivery's spot is rendered through `preview_push_notification` with the admin client (saved fields, chosen spot or the sample), and the destination carries `push` from `get_push_destination`'s settings so the test uses the saved urgency and TTL. `api.ts`'s `POST …/test` passes through.
- [x] Tests: `delivery_format.test.ts` (SQL text passes through, tags on and off, actions, silent, no summary at any count), `delivery_send.test.ts` (urgency and TTL per destination; the quiet skip makes no request and reports the batch sent; defaults without `push`), `delivery_run.test.ts` (a skipped push batch is acked with the cycle's `mark_deliveries_sent` and nothing else), `handlers_test_delivery.test.ts` (members only, `spot_id`). `function_config.test.ts` stays green.
- [x] `deno task coverage` (three roots), `deno task check`, `deno task lint`.
- [x] Commit `Push delivery on the sender: field-built text, urgency, TTL, quiet hours and action buttons per destination`.

### Task 5: Docs and PR 3

- [x] `docs/ARCHITECTURE.md`: the push path (editor → `save_push_destination` → `claim_deliveries` builds text and carries settings → the sender's `sendPush` → the service worker → tap target). `docs/OPERATIONS.md`: the new tables in the Push section's queries; the note that a push destination's "drop if offline" overrides the 15-minute default. `docs/API.md` from Task 3. CLAUDE.md "Push rules": the sentence on templates becomes field picks (if #187 didn't already), and add that `push` settings and `quiet_now` travel in the claim's destination jsonb.
- [x] `npm run test:all` against a reset stack. Commit, push `push-schema-3`, open PR 3. PR text: merging applies nothing to hosted by itself but **deploys the sender** (it changes `_shared/delivery/*`); Brad then runs `supabase db push` and redeploys `send-test` and `api`; both orders are safe.

---

## Part 3: API module, push state, card grid and type picker (PR 4 draft, branch `push-ui`)

### Task 6: `api.ts` and `pwa/push.ts`

**Files:** `web/src/lib/api.ts` (+ test), `web/src/pwa/push.ts` (+ test), `web/vite.config.ts`.

- [ ] `api.ts`: `DestinationType` gains `"push"`; `Destination` (a `Pick` of exactly `DESTINATION_COLUMNS`) and `DESTINATION_COLUMNS` both gain `enabled`; `createDestination(type, name, url: string | null)`; `updateDestination` gains `enabled`. New: `registerPushDevice({endpoint, p256dh, auth}, label, agent, standalone) → deviceId`, `unregisterPushDevice(endpoint)`, `listPushDevices(currentEndpoint)`, `deletePushDevice(id)`, `renamePushDevice(id, label)`, `reportPushDeviceBlocked(endpoint)`, `savePushDestination(input) → id`, `getPushDestination(id)`, `duplicateDestination(id) → id`, `previewPushNotification(titleFields, bodyFields, showFieldNames, bodySeparator, spotId | null)`, `sendTest(id, spotId?)`. `signOut(scope, cleanup?)` runs `cleanup` first, best effort. Types `PushDevice`, `PushSettings`, `PushDestinationInput` live here.
- [ ] `vite.config.ts`: `VITE_VAPID_PUBLIC_KEY` from `VITE_VAPID_PUBLIC_KEY` / `VAPID_PUBLIC_KEY` / `LONGLINES_VAPID_PUBLIC_KEY`, with a warning when empty.
- [ ] `push.ts` with an injectable `PushEnv`: `pushSupport()` → `unsupported | ios-needs-install | denied | off | on` (`unsupported` also when the public key is empty); `enablePush(label)` with `Notification.requestPermission()` as its first statement, then `serviceWorker.ready`, `subscribe`, `registerPushDevice(keys, label, deviceAgent(), isStandalone())`, remembering the endpoint in `localStorage` (try/catch); `disablePush()`; `currentEndpoint()`; `refreshPushRegistration()` (re-register when granted and subscribed; when `denied` and a remembered endpoint exists, `reportPushDeviceBlocked`); `deviceAgent()` → "{Browser} on {Platform}" from `userAgentData` with a UA fallback and "This browser"; `isStandalone()`; `isIos()`; `pushCleanup()` (a `disablePush` that resolves even when unsupported).
- [ ] Tests: every wrapper's RPC name and arguments; `signOut` still signs out when cleanup rejects; every `pushSupport` state; permission before any await; denied → report blocked; `deviceAgent` for Chrome/Android, Safari/iPhone, Firefox/Linux, Edge/Windows, fallback.
- [ ] Commit `Push: api wrappers, browser push state and the VAPID public key define`. Push `push-ui`, open PR 4 as a draft.

### Task 7: Destinations as a card grid

**Files:** `web/src/destinations/DestinationsPage.tsx` (+ test), `web/src/destinations/DestinationCard.tsx` (new), `web/src/destinations/HealthChip.tsx`.

- [ ] Replace the `List` with a `Grid` of `Card variant="outlined"` (two columns from `md`, one below), page 1 for Discord and webhook cards, page 5 for push cards: name (`h6`) and chip; type line; the masked URL in a monospace `Paper variant="outlined"` for Discord/webhook, device chips for push (`Chip size="small" variant="outlined"`, blocked ones `color="error"` with " (blocked)"); the meta line "used by {N} subscription(s) · Last delivery {age} ago" / "Never used" / "Last delivery failed {age} ago" from `last_success_at`/`last_error_at`; `Divider`; `CardActions` with Send test, [push: Edit, Duplicate], Delete (disabled with tooltip "Used by {N} subscriptions. Remove it from them first.").
- [ ] Push chip: `HealthChip` as today, except `Chip color="warning" label="{N} device(s) blocked"` when any member is blocked. Devices per card come from one `listPushDevices()` call on the page (`destination_ids`), never per card.
- [ ] Alerts above the grid: the failing alert per page 1 (with a Send test action, replacing today's one-sentence alert) and the blocked alert per page 5 (Manage devices → the editor).
- [ ] Duplicate: `duplicateDestination(id)` then navigate to `/destinations/{newId}`; toast "Duplicated {name}".
- [ ] Tests: both layouts; each card type; chips; meta variants; Delete tooltip; Duplicate navigation; both alerts.
- [ ] Commit `Destinations: card grid with push cards`.

### Task 8: Add destination as a type picker

**Files:** `web/src/destinations/DestinationDialog.tsx` (+ test), `web/src/destinations/types.ts`.

- [ ] `DEST_TYPES` gains push and the page 5 help strings for all three, each with an icon (`ForumOutlined`, `Http`, `NotificationsOutlined`); the list is data so the sender spec's future `email` type is one more entry.
- [ ] Step 1 (page 5 `PushType`): intro sentence, three selectable cards (a `RadioGroup` whose labels are `Card variant="outlined"` rows; the selected card takes the `primary` border through a prop, not `sx`), Cancel and **Continue**. Step 2 for Discord and webhook: today's Name and URL fields with **Add destination**. Continue with push navigates to `/destinations/new?type=push`.
- [ ] Tests: the picker; Continue → step 2 keeps today's assertions; Continue with push navigates (`LocationProbe`).
- [ ] Commit `Destinations: pick a type, then its details`.

---

## Part 4: Push destination editor (PR 4 draft)

### Task 9: Editor page, routes, name, enabled, delivery settings

**Files:** `web/src/destinations/PushDestinationPage.tsx` (new, + test), `web/src/destinations/pushModel.ts` (new, pure, + test), `web/src/App.tsx`.

- [ ] Routes `/destinations/new?type=push` and `/destinations/:id` (a non-push id redirects to `/destinations`). Layout mirrors `SubscriptionEditorPage`: `Breadcrumbs`, `PageTitle` with Cancel and **Add destination** / **Save destination** (phones: **Save**), the Name field with its helper and the taken-name error, the Enabled `Switch`, the type `Chip` and the sentence "Filtering and repeat limits are set on each subscription. This page controls where and how notifications arrive.", then a `Grid` with `size={{xs: 12, md: 7}}` (Devices, Notification content, Delivery) and `size={{xs: 12, md: 5}}` sticky (Preview).
- [ ] `pushModel.ts`: the default settings (pinned by a node test against the seed's push row or a fixture), the field list with display names, `addField`, `removeField`, `moveField(list, index, delta)`, `dirty(initial, current)`, the option lists (Urgency; Drop if offline: 5 min, 15 min, 30 min, 1 hour, 4 hours; During quiet hours; Separate body fields with: A dot, A comma, A new line), `toInput`.
- [ ] Delivery card: Urgency `Select`, Drop if the device is offline for `Select` (helper as in Copy; this overrides the sender's 15-minute default for this destination), Replace the earlier notification `Switch`, divider, Sound and vibration `Switch`, divider, Quiet hours `Switch` with "Uses your account time zone, {profile.timezone}.", From/Until (`TextField type="time"`) and During quiet hours `Select`, the time row disabled while quiet hours are off.
- [ ] Save: `savePushDestination(...)` → toast "Added {name}" / "Saved changes", navigate to `/destinations`.
- [ ] Tests: new and edit modes; redirect; name error; every control round-trips into the saved input; phone layout.
- [ ] Commit `Destinations: push destination editor with delivery settings`.

### Task 10: Devices card, Add a device dialog, rename and remove

**Files:** `web/src/destinations/DevicesCard.tsx`, `AddDeviceDialog.tsx`, `RenameDeviceDialog.tsx` (new, + tests).

- [ ] Devices card (page 5): one row per account device: `Checkbox` (`aria-label="Send to {label}"`, disabled when blocked), phone or laptop icon from `agent`, name with "This device" and "Blocked" chips, caption "{agent}[, installed app] · last delivery {age} ago" / "{agent} · no deliveries yet" / "{agent} · notifications blocked in this browser", Rename and Remove `IconButton`s, then **Add a device**. Empty state: the dashed box with its copy, **Add this device** and **Add my phone**. Checked ids are the form's `deviceIds`; a newly added device is checked automatically.
- [ ] Add a device dialog (page 5 `PushDevice`): **This device** with icon, `{agent}` chip, the permission sentence, the Device name field prefilled with `deviceAgent()`, **Enable notifications** → `enablePush(name)`; `Divider`; **Another device** with the two steps and the iPhone info alert; Cancel. `denied` and `unsupported` show the spec's sentences in place of the button. `fullScreen` on phones with a close button, as drawn.
- [ ] iPhone not installed (`PushDevice-iOS-Mobile`): the same dialog when `ios-needs-install`: warning alert, three steps, disabled **Enable notifications**, its caption.
- [ ] Rename: a one-field dialog, **Rename**; Remove: `deletePushDevice` with "Removed {label}"; removing the current device also runs `disablePush()`.
- [ ] Tests: rows in every state; checkbox round-trip; empty state; the dialog in `off`, `denied`, `unsupported`, `ios-needs-install`; Enable calls `enablePush` with the typed name and checks the new device; rename; remove current and other; phone layout.
- [ ] Commit `Destinations: devices card and the Add a device dialog`.

### Task 11: Notification content and the preview

**Files:** `web/src/destinations/NotificationContentCard.tsx`, `PushPreviewCard.tsx`, `NotificationMockup.tsx` (new, + tests).

- [ ] Notification content card (page 5, as redrawn 2026-10-16): header "Notification content" with its subheader; a two-column grid (one column on phones) with a `FieldPicker` for Title and one for Body: the picked fields as a numbered `List` inside an outlined `Paper` (position, display name, move up / move down / remove `IconButton`s with aria-labels "Move {field} up" / "Move {field} down" / "Remove {field}"; the first row's up and the last row's down disabled), below it an "Add a field" `Select` (placeholder "Choose a field") listing only unpicked fields, and the helper text. No text input anywhere; the title refuses a fifth field and an empty list, the body a ninth. Then the "Show field names" `Switch` with its sentence, the "Separate body fields with" `Select`, the skipped-field sentence, "When tapped, open" `Select`, "Show action buttons" `Switch`, **Reset to default fields**.
- [ ] Preview card: "Preview" overline; "Preview with this spot" `Select` of the last 10 recent spots from `listRecentSpots` across sources, labelled "{CALL}, {Source} {reference}, {kHz} {MODE}" (display only), plus "Sample spot"; `previewPushNotification(titleFields, bodyFields, showFieldNames, bodySeparator, spotId)` debounced 300 ms; three `NotificationMockup` variants (android, iphone, desktop) with their captions, from `Paper` elevation, `Avatar` and palette colours only; **Send test notification** (`variant="outlined"`, full width) with the caption rules from decision 10, calling `sendTest(id, spotId)`.
- [ ] Tests: add, remove, move (and the disabled ends), limits, reset, field names, separator, tap target and action switch round-trip; the preview RPC called with the picked lists, labels, separator and the chosen spot, mock-ups showing its result; the Send test states.
- [ ] Commit `Destinations: notification content and live preview`.

---

## Part 5: Install, refresh on load, docs and the end-to-end check (PR 4 ready)

### Task 12: Install app, refresh, sign-out cleanup

**Files:** `web/src/pwa/install.ts` (+ test), `web/src/layout/InstallDialog.tsx`, `web/src/layout/AppShell.tsx` (+ test), `web/src/account/AccountPage.tsx`, `web/src/app/AppContext.tsx`, `web/src/pwa/register.ts`, `web/src/main.tsx`.

- [ ] `install.ts`: capture `beforeinstallprompt` from `main.tsx` before render; `installState()` → `prompt | ios | none`; `promptInstall()`; a subscribe/notify pair.
- [ ] AppShell: **Install app** between Account and Sign out when state isn't `none`; `ios` opens `InstallDialog` (spec Copy).
- [ ] With a session, `refreshPushRegistration()` once per load. `register.ts` listens for `push-subscription-changed` and calls it again (the service worker already posts it).
- [ ] Every local sign-out (`AppShell`, both in `AccountPage`) passes `pushCleanup`; "Sign out others" passes nothing.
- [ ] Tests for each.
- [ ] Commit `Install app, re-register on load and on subscription change, unregister on sign out`.

### Task 13: Docs, rules, gates and end to end

- [ ] README: local push needs the `LONGLINES_VAPID_*` lines in `supabase/functions/.env` (for `send-test`), the same three in the environment of `npm run sender`, and `LONGLINES_VAPID_PUBLIC_KEY` in `web/.env.local`. OPERATIONS: the Vercel `VAPID_PUBLIC_KEY` step. ARCHITECTURE: the browser side. CLAUDE.md: the web push rules from Global Constraints if missing. Spec: both amendments' Status → shipped.
- [ ] Gates: `npm run coverage`, `npm run build` (`dist/sw.js` check), `npm run lint`, `npm run test:all` on a reset stack.
- [ ] End to end on the local stack, with a generated VAPID pair in `supabase/functions/.env`, the sender's environment and `web/.env.local`; `npm run dev:full` plus `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1 npm run sender` in a second terminal:
  1. Desktop Chrome at `localhost:5173`: Add destination → Push notification → Continue → the editor. Add this device → Enable notifications → the device appears checked with "This device". Save. The card shows the device chip and "Never used".
  2. Edit → Send test notification with the sample spot: "N0CALL · 14.062 MHz · CW" / "POTA · US-0000 · Test Park · TEST"; clicking opens `/call/N0CALL`; Open on POTA opens the park page.
  3. Remove Mode from the title, add Spotter first in the body, turn on Show field names and pick "A new line", watch the preview update, save, Send test again: the new text.
  4. A seeded subscription targeting the push destination: `npm run invoke:pota` (or `npm run db:match` on seeded spots); the sender log shows the push sent within one poll and at most 3 in the first minute, newest first, no summary.
  5. Quiet hours on, From/Until around now, Send silently: the next delivery arrives silent. Don't send: the sender log shows `sent` with no request and `deliveries.status = 'sent'`.
  6. A second push destination with the same device and different fields: both arrive. Duplicate → "Copy of …" disabled, nothing delivered to it.
  7. Drop if offline 5 minutes, then stop the sender, match a spot, wait 6 minutes, start it: the row is `dropped` with `dropped_at` set and nothing arrives.
  8. Revoke the permission in Chrome, reload: Blocked chip and alert; deliver: the device is skipped.
  9. Sign out: the device row is gone.
- [ ] On a Vercel preview with Brad's steps done: Chrome's Installable audit, Android, and an iPhone after Add to Home Screen (the not-installed screen first, then the real flow). Record in the PR text which steps ran.
- [ ] `gh pr ready`; PR text per #157.

---

## Copy (page 5, with substitutions)

Use these word for word. Substitutions applied everywhere: **"connection(s)" → "subscription(s)"**; **"KK4PWJ"** → the signed-in callsign; **"America/New_York"** → `profile.timezone`; `{…}` marks a value. Anything not listed here comes from the spec's Copy section.

**Destinations page (page 1 + page 5)**
- Subtitle: Where matching spots are sent.
- Button: Add destination
- Failing alert: {name} is failing · The last {N} deliveries returned {error}. Spots for {M} subscription(s) are not being sent. Check the URL, then send a test. · Action: Send test
- Blocked alert: {device} cannot receive notifications · Notifications are blocked for longlines.io in {agent} on that device. Allow them in the browser site settings, or remove the device from {destination}. · Action: Manage devices
- Card type lines: Discord channel · Webhook · Push notification
- Card meta: used by {N} subscription(s) · Last delivery {age} ago | not used by any subscription · Never used | Last delivery failed {age} ago
- Push card chip when blocked: {N} device(s) blocked; device chip: {label} (blocked)
- Actions: Send test · Edit · Duplicate · Delete; Delete tooltip: Used by {N} subscriptions. Remove it from them first.
- Toasts: Added {name} · Saved changes · Duplicated {name} · Deleted {name} · Test spot sent to {name}

**Add destination dialog**
- Title: Add destination
- Intro: Pick where matching spots should go. You can add as many of each type as you like, for example one push destination per source or per device.
- Discord channel: Post each spot to a channel through a webhook.
- Webhook: Send each spot as JSON to your own URL.
- Push notification: Notify your phone or computer. Works in the browser, no app to install.
- Buttons: Cancel · Continue (step 2 for Discord/webhook: Add destination, as today)

**Push destination editor**
- Breadcrumb: Destinations › New destination | {name}
- Titles: New destination · Edit destination; buttons: Cancel · Add destination | Save destination (phones: Save)
- Name helper: Names are unique. A name can be reused after the destination that has it is deleted.
- Name taken: A destination named {name} already exists. Choose a different name.
- Switch: Enabled
- Type chip: Push notification · Sentence: Filtering and repeat limits are set on each subscription. This page controls where and how notifications arrive.
- Devices card: Devices · Pick which devices receive notifications. Each device is a browser you have allowed.
  - Row caption: {agent}[, installed app] · last delivery {age} ago | {agent} · no deliveries yet | {agent} · notifications blocked in this browser
  - Chips: This device · Blocked; icon buttons: Rename device · Remove device; button: Add a device
  - Empty: No devices yet · Add the device you are on now, or open Long Lines on your phone to add it. A destination needs at least one device to deliver. · Add this device · Add my phone
- Notification content card: Notification content · Choose which fields appear and in what order. Notifications cannot contain custom text.
  - Lists headed Title and Body; rows numbered 1, 2, 3…; row buttons: Move {field} up · Move {field} down · Remove {field}
  - Under each list a select: Add a field · placeholder Choose a field; field names: Callsign · Frequency · Band · Mode · Source · Reference · Place name · State · Spotter · Comment · Time
  - Title helper: Shown in bold. Phones cut off long titles.
  - Body helper: Place name is the park or summit.
  - Switch: Show field names · Adds a label before each value, such as State: NC.
  - Select: Separate body fields with · A dot · A comma · A new line
  - Sentence: If a spot does not have a field, that field is skipped.
  - When tapped, open: Callsign profile · Source site
  - Show action buttons · Open profile, Open on the source site.
  - Button: Reset to default fields
  - Default title fields: Callsign, Frequency, Mode; default body fields: Source, Reference, Place name, State
- Delivery card: Delivery · How notifications behave on the device
  - Urgency (Low · Normal · High) · High can wake a sleeping phone. Normal fits most subscriptions.
  - Drop if the device is offline for (5 minutes · 15 minutes · 30 minutes · 1 hour · 4 hours) · Old spots are rarely useful. Late notifications are dropped, not queued.
  - Replace the earlier notification for the same station · A station that keeps getting spotted updates one notification instead of stacking many.
  - Sound and vibration · Uses the device default. Custom sounds are not supported.
  - Quiet hours · Uses your account time zone, {timezone}. · From · Until · During quiet hours (Send silently · Don't send)
- Preview card: Preview · Preview with this spot · Android · iPhone · Desktop
  - Captions: Action buttons shown on Android and desktop Chrome. · Action buttons are not shown on iPhone. · Style follows the operating system.
  - Button: Send test notification; captions: Add a device to send a test. · Save your changes to send a test. · Sends this example to the {N} selected device(s).
  - Action buttons in mock-ups and notifications: Open profile · Open on {Source}

**Add a device dialog**
- Title: Add a device
- This device · chip {agent} · Your browser will ask for permission. Choose Allow. You can change this later in the browser site settings. · Field: Device name · Button: Enable notifications
- Another device · 1. Open Long Lines on that device · Go to longlines.io and sign in as {callsign}. · 2. Open Destinations and choose Add this device · Allow notifications when asked. The device appears here when it is ready.
- Info alert: On iPhone and iPad, first add Long Lines to the Home Screen from the Share menu. Safari only allows notifications for installed web apps.
- Button: Cancel
- Toasts: Notifications turned on · Removed {label} · Renamed {label}

**Add a device on iPhone, not installed**
- Warning alert: Add Long Lines to your Home Screen first · Safari on iPhone only allows notifications for web apps added to the Home Screen.
- 1. Tap Share · The square with an arrow, in the Safari toolbar. · 2. Choose Add to Home Screen · Then tap Add. · 3. Open Long Lines from the Home Screen · Sign in, go to Destinations, and choose Add this device.
- Disabled button: Enable notifications · Caption: Available once Long Lines is opened from the Home Screen.

**Device labels** ({agent}): {Browser} on {Platform}; browsers Chrome, Edge, Firefox, Safari, Samsung Internet, Opera; platforms Android, iPhone, iPad, macOS, Windows, Linux, ChromeOS; fallback This browser; suffix ", installed app" when standalone.

## Out of scope

- #158 (per-device retry): the sender spec's Phase 2 B (in-memory retry) is the place for it.
- Phase 2 of the sender spec: per-event webhooks, auto-disable, queue notices, the `email` type,
  LISTEN, routing test sends through the sender (which would move VAPID off Edge). Nothing here
  blocks them: the type picker is data, `enabled` and the settings table are additive, the claim's
  shape is unchanged.
- Discord and webhook editors, the Connections rename, device management through the API.

## Prompts: one per part

Paste the part's block into a new Claude Code session. Each session reads only what its part needs.

### Part 2 prompt

```
Create a worktree: `cd /home/brad-bazemore/Dev/longlines && git fetch origin && git worktree add ../longlines-push-schema-3 -b push-schema-3 origin/main`, and work only there.

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "What the sender changes for this plan", "Decisions still open", "Global Constraints", "Review Focus", and Tasks 3–5. Read the push spec's two amendments (2026-10-15 page 5, 2026-10-16 the sender) in docs/superpowers/specs/2026-10-13-push-notifications-design.md, and sections 2, 3 and 10 of docs/superpowers/specs/2026-10-15-outbound-sender-design.md. Read CLAUDE.md in full, supabase/migrations/20261016000100_claim_drops_unwanted.sql, 20261015001200_sender_cutover.sql, 20261014000100_push_destinations.sql, supabase/functions/_shared/delivery/run.ts and send.ts, and supabase/tests/sender_role.test.sql.

The local branch push-schema-2 (in the worktree /home/brad-bazemore/Dev/longlines-push-web; don't switch branches there) holds a draft written before the sender existed and before templates became field picks. Quarry it with `git show push-schema-2:<path>` as Task 3 says; never merge it and never take its claim_deliveries, match_pending_spots or anything that touched deliver.ts or send.ts.

Do Tasks 3, 4 and 5 in order, one commit each, ticking the boxes. sender/ is untouched; sender_role.test.sql must pass unchanged; the claim's signature and result columns never change. Recheck the migration number against origin/main and every open branch first. Gates: `deno task coverage`, `deno task check`, `deno task lint`, `supabase db reset && supabase test db`, `scripts/smoke-test.sql`, `SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts`, `npm run supabase:types`, then `cd web && npm run test:all`. Run /code-review before opening the PR.

Push with `git push -u origin push-schema-3` and open PR 3 with `gh pr create --base main`. The PR text must say that merging deploys the sender (it changes _shared/delivery), that Brad then runs `supabase db push` and redeploys send-test and api, and that both orders are safe. Don't merge, deploy, push to hosted or set secrets.
```

### Part 3 prompt

```
Create a worktree: `cd /home/brad-bazemore/Dev/longlines && git fetch origin && git worktree add ../longlines-push-ui -b push-ui <start>`, where <start> is origin/main if PR 3 (push-schema-3) is merged, else push-schema-3 (then say in the PR text that PR 4 is stacked on it). Work only there.

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Copy", and Tasks 6–8. Read CLAUDE.md's "Web app rules", "Push rules" and "Testing" sections, web/src/lib/api.ts, web/src/destinations/, web/src/pwa/, web/src/subscriptions/SubscriptionEditorPage.tsx (for the page pattern only), and web/src/test/render.tsx. Canvas page 5 is transcribed in the plan's Copy section; don't read the canvas.

Do Tasks 6, 7 and 8 in order, one commit each, ticking the boxes. Copy word for word from the plan's Copy section ("subscription", never "connection"). Gates after each task: `cd web && npm run coverage`, `npm run build`, `npm run lint`.

Push with `git push -u origin push-ui` and open PR 4 as a draft (`gh pr create --draft --base <base>`). Don't merge.
```

### Part 4 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-ui on branch push-ui (`git fetch origin && git merge origin/main` first if main moved).

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Copy", and Tasks 9–11, plus decisions 4 to 11 in the push spec's 2026-10-15 amendment and S2/S3 in its 2026-10-16 amendment. Read CLAUDE.md's "Web app rules", "Push rules" and "Testing" sections, web/src/lib/api.ts (the push wrappers Part 3 added), web/src/destinations/, web/src/subscriptions/SubscriptionEditorPage.tsx, and web/src/lib/database.types.ts for push_destination_settings.

Do Tasks 9, 10 and 11 in order, one commit each, ticking the boxes. Notification text is an ordered pick of fields, never free text; the web never builds the text: previews come from the preview_push_notification RPC. Mock-ups use Paper elevation and palette colours, never hex. Gates after each task: `cd web && npm run coverage`, `npm run build`, `npm run lint`.

Push to origin push-ui. PR 4 stays a draft. Don't merge.
```

### Part 5 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-ui on branch push-ui (`git fetch origin && git merge origin/main` first if main moved).

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Brad's steps", and Tasks 12–13, plus decisions 12 and 13 in the push spec's 2026-10-15 amendment. Read CLAUDE.md's "Push rules", "Web app rules" and "Sender rules", web/src/pwa/, web/src/layout/AppShell.tsx, web/src/account/AccountPage.tsx, web/src/app/AppContext.tsx and web/scripts/sender.ts.

Do Tasks 12 and 13 in order, one commit each, ticking the boxes. For the end-to-end steps, generate a local VAPID pair with `deno run scripts/generate-vapid-keys.ts mailto:test@example.com`, put the three lines in supabase/functions/.env and web/.env.local (both gitignored) and in the environment of `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1 npm run sender`. Record in the PR text exactly which end-to-end steps you ran and which you couldn't. Run the full gates in Task 13 and /code-review, fix what it finds.

Push to origin push-ui and run `gh pr ready`. Don't merge. Never run supabase secrets set, functions deploy, db push, fly deploy, fly secrets set or vercel.
```
