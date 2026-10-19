# Webhook Destinations: Page 7, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 1, 2026-10-18. Brad approved the plan of 2026-10-17 (six decisions) before the Discord
work merged; this revision re-plans it against main at `710098f` (Discord PRs #215 to #217 merged).
Revision 2, same day: the review's findings (attempted rows, empty pairs, spaced pause count,
header order, existing pgTAP suites, Source catalog in PR 2, CLAUDE.md and copy fixes).
Revision 3, same day, from PR 2's review: the masked URL hides the last non-empty segment (a
trailing slash kept); a pause makes the destination's whole queue visible so the sweep drops rows
in backoff too; the default pause is null in PR 2 and PR 3 carries a migration that makes it 20.

**Goal:** Give webhook destinations the editor **Page 7 of Brad's design canvas** draws: a card
with Edit and Duplicate, a full-page editor (Endpoint with Replace URL, signing secret and extra
headers; Payload as an ordered pick of fields with key style, time format, frequency unit and
missing values; Delivery with grouping, a retry policy and pause after repeated failures; a live
Request preview with Send test request), and the "Destination added" dialog that shows the signing
secret once.

**Architecture:** Discord's model. A `webhook_destination_settings` row per webhook and a
`webhook_destination_headers` table whose values live in Supabase Vault. SQL renders the spot
(`webhook_spot_fields`) as ordered `[{key, value}]` pairs, and the claim hands them to the sender
with the connection name and the header values; the preview and the service-role test RPC call
the same renderer. Policy is SQL: the grouping window reuses Discord's batch hold, the retry
schedule and attempt limit are knob functions read by `mark_deliveries_failed` and the claim's
expiry sweep, and pausing (a pause count spaced 30 s apart) sets `enabled = false` with
`auto_disabled_at`. The sender only builds the body in order, signs it and posts it, marks failed
only the rows whose request was made, and falls back to today's body when the claim lacks the
new keys, so the sender and the migration ship in either order. The claim's and
`mark_deliveries_failed`'s signatures, `SENDER_RPCS`, the sender role's grants and its env list do
not change.

**Tech Stack:** Postgres (plpgsql, pgTAP, pgmq, supabase_vault 0.3.1), the sender (Deno on Fly,
postgres.js), Deno Edge Functions (`send-test`, `api`), React 19, MUI 9, react-router, Vitest +
Testing Library.

**Design sources:**
- `docs/superpowers/specs/2026-10-18-webhook-destination-design.md`: decisions 1 to 21, Schema,
  Rendering, Request bodies, Extra headers, Delivery policy, Sender, API, Web and **Copy** (page 7
  transcribed with the amendments). Sessions never read the canvas.
- `docs/superpowers/specs/2026-10-18-discord-destination-design.md`: the precedent for every
  pattern (settings table, hold, Replace URL, test RPC, editor skeleton).
- `docs/superpowers/specs/2026-10-15-outbound-sender-design.md`: sections 2, 3, 9 and 10 are the
  constraints on anything that touches delivery. Section 9A's "envelope kept" is superseded.

## Where things stand

| Area | State |
| --- | --- |
| Discord editor (page 8): `discord_destination_settings`, the batch hold, `destination_claim_interval`/`_max`, `FieldPicker`, `fieldList.ts`, `SettingSwitch`, `DiscordDestinationPage` | Merged (#215, #216, #217) |
| Push editor (page 5) | Merged (#211, #212) |
| Webhooks today | Name and URL in step 2 of the Add destination dialog; body `{deliveries: [...]}` of up to 50 with stored keys; TypeScript retry schedule; never paused; card has Send test, Rotate secret, Delete; `duplicate_destination` refuses them |
| Latest SQL to recreate from | `claim_deliveries`, `duplicate_destination`, `api_destination_json`: `20261018000100`. `mark_deliveries_failed`: `20261006000010`. `update_destination`: `20261016000400`. `rotate_signing_secret`: `20261006000002`. `destination_url_display`: `20261014000100` |
| Highest migration on main | `20261018000200_discord_link_brackets.sql`; this plan's is `20261018000300` |
| Vault | `supabase_vault 0.3.1` installed locally; the `postgres` role has execute on `vault.create_secret`, select on `vault.decrypted_secrets`, delete on `vault.secrets` (checked 2026-10-17). Hosted not yet probed |

## How to run this plan: three parts, three PRs

Each part runs in a fresh Claude Code session in its own worktree. Stacked branches, like Discord.

| Part | Tasks | Produces | Branch | PR |
| --- | --- | --- | --- | --- |
| 0 | Task 0 | The spec, this plan, one line in the sender spec's 9A | `webhook-spec` | PR 1 → main |
| 1 | Tasks 1 to 6 | Migration `20261018000300`, pgTAP, sender TypeScript (incl. `run.ts`), send-test, docs, generated types, the Source catalog | `webhook-schema` (from `webhook-spec`) | PR 2 → `webhook-spec`, retargeted to main |
| 2 | Tasks 7 to 11 | `api.ts`, model, list cards, editor, dialog, preview, CLAUDE.md, the pause-default migration | `webhook-ui` (from `webhook-schema`) | PR 3 → `webhook-schema`, retargeted to main |

PR 2 is safe to merge alone: it deploys the sender, which sends today's body until Brad pushes the
migration; after the push receivers get the new body. PR 3 needs PR 2's migration on hosted.

### Branches and PRs

- `git worktree add ../longlines-webhook-schema -b webhook-schema origin/webhook-spec` (or
  `origin/main` once PR 1 is merged), and likewise `webhook-ui` from `webhook-schema`. Never switch
  branches in the main checkout or in a worktree another session holds.
- `git push -u origin <branch>`; `gh pr create --base <base>`. The repo deletes merged branches and
  GitHub retargets stacked PRs. Say in the PR text that it is stacked and on what.
- Before pushing PR 2, check `origin/main` for a migration numbered `20261018000300` or later;
  renumber and merge main in if so.
- PR text follows the Discord PRs: what it does, what is still to come, testing with real numbers,
  Brad's steps, and whether merging applies a migration or deploys the sender.
- Nothing is pushed to hosted, merged or deployed by a session. Don't run pgTAP in two sessions at
  once; the local stack is shared.

## Brad's steps (no part does these)

1. Before PR 2 merges, probe Vault on hosted once (SQL editor, as `postgres`):
   `select vault.create_secret('probe', 'longlines_probe');`, `select decrypted_secret from
   vault.decrypted_secrets where name = 'longlines_probe';`, `delete from vault.secrets where name
   = 'longlines_probe';`. All three must work.
2. After PR 2 merges (the sender redeploys itself through Fly): `supabase db push`, then
   `supabase functions deploy send-test` and `supabase functions deploy api`.
3. Tell anyone with a webhook about the body change (`docs/WEBHOOKS.md`, "Changed 2026-10").
4. After PR 3 merges: `supabase db push` (the pause default, one statement), and Vercel builds
   main; no new env.

## Global Constraints

- Work only in the part's worktree on its branch. Never `supabase db push`, `functions deploy`,
  `fly deploy`, `fly secrets set`, `supabase secrets set` or `vercel`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Applied migrations are never edited. `claim_deliveries`, `mark_deliveries_failed`,
  `update_destination`, `rotate_signing_secret`, `duplicate_destination`, `api_destination_json`
  and `destination_url_display` keep their signatures and are recreated from their **latest**
  definitions (Where things stand). The claim's result columns never change; new policy is a
  column or a knob function.
- Behaviour goes in SQL: rendering every value, key names, order, the hold, the per-claim cap, the
  retry schedule and attempt limit, dropping, pausing, header checks, URL masking. The sender,
  `send-test` and the web never format a value, cap, age-check, delay or drop a delivery.
- `destinations.url`, `signing_secret` and header values never appear in an RPC result, view, log
  or API response, except the one-time secret from create and rotate. Header values leave Vault
  only inside `claim_deliveries`, `webhook_test_delivery` and `duplicate_destination`.
- Nothing sets `destinations.health = 'paused'`. Pause is `enabled = false` plus
  `auto_disabled_at`.
- `sender/` code is not changed (`_shared/delivery/run.ts` is, for decision 14's `attempted`).
  `_shared/delivery/*` must load under `deno run --no-config` and
  work with and without the migration (legacy body without `destination.webhook`).
- `delivery_sender` gets nothing new; `sender_role.test.sql` passes unchanged.
- `web/src/lib/api.ts` stays the only supabase-js module. `FieldPicker` is extended, never forked.
- Copy is word for word from the spec's Copy section. Users see "connection", never
  "subscription".
- No new runtime dependency.
- MUI 9 rules from CLAUDE.md: `sx` for layout only; `Grid size`; `slotProps`; no `fontWeight`
  prop; MUI icons only; monospace through a bare `<code>` as `DestinationCard` does.
- Gates per part: `deno task fmt`, `deno task lint`, `deno task check`, `deno task coverage`;
  `supabase db reset && supabase test db`; `psql "$DB_URL" -v ON_ERROR_STOP=1 -f
  scripts/smoke-test.sql`; `supabase db lint`;
  `SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts`;
  `cd web && npm run coverage`, `npm run build`, `npm run lint`; `npm run test:all` once before a
  PR is marked ready.

## Review Focus

- Secrets: header values only in the three named functions; `get_webhook_destination`,
  `list_webhook_destination_settings`, `api_destination_json` and the preview carry names only.
  Deleting a destination (directly or through account deletion) deletes its Vault rows.
- The sweep is the only drop: `mark_deliveries_failed` never drops; an exhausted row gets vt 0 and
  the next claim's expiry sweep drops it with `dropped_at`; `ready` uses the same
  `webhook_retries_exhausted`.
- Both merge orders: the new sender with the old claim sends the legacy body; the old sender with
  the new claim sends the legacy body plus two ignored spot keys.
- Existing webhooks: backfilled to every field, grouped every 10 s, `day` retries, pause off.
- Key order: pairs, `Object.fromEntries`, and the preview's `json`; one pgTAP and one Deno test
  pin it.
- A cycle stays bounded: at most 5 requests a claim for one request per spot, at most 4 grouped
  (the head-of-line cost, decision 13).
- Only attempted rows are marked failed (`SendResult.attempted`); `none` never drops an unsent spot.
- A spot with no picked values renders `[]` / `{}` / `"spot": {}`, never null or the legacy body.
- The pause count is spaced (`webhook_pause_spacing`), and a pause's dropped backlog has
  `dropped_at`.

---

## Part 0: Spec and plan (PR 1, branch `webhook-spec`)

### Task 0: Write the spec and the plan

**Files:** `docs/superpowers/specs/2026-10-18-webhook-destination-design.md` (new),
`docs/superpowers/plans/2026-10-18-webhook-destinations.md` (new),
`docs/superpowers/specs/2026-10-15-outbound-sender-design.md` (one line in section 9).

- [x] Spec in the Discord spec's structure, with page 7's Copy and the amendments marked.
- [x] This plan.
- [x] Sender spec section 9A: a line saying the webhook body is superseded by the new spec.
- [ ] Commit `Spec: webhook destinations follow canvas page 7`, push `webhook-spec`, open PR 1.

---

## Part 1: Schema and sender (PR 2, branch `webhook-schema`)

Template for every SQL object: `20261018000100_discord_destinations.sql` (settings table, defaults
trigger, validation, rendering, claim additions, test RPC, client RPCs, duplicate, API json, grants
at the end). One migration file, `supabase/migrations/20261018000300_webhook_destinations.sql`,
built up over Tasks 1 to 4, each with its tests.

### Task 1: Destinations columns, URL masking, catalog, settings

**Files:** the migration (sections 1 and 2); `supabase/tests/webhook_destinations.test.sql` (new);
`supabase/tests/destinations.test.sql`; `supabase/tests/advisor.test.sql`.

- [x] Write the failing tests first in `webhook_destinations.test.sql` (include
  `helpers/users.psql`; `pg_temp.as_user`): a new webhook gets a settings row equal to
  `webhook_default_settings()`; an existing-style row backfilled by the migration's statement has
  all 14 fields, batch 10, `day`, pause null; `secret_rotated_at` is set on create and moves on
  `rotate_signing_secret`; `url_display` for `https://logger.example.org/hook/abc123?k=v` is
  `https://logger.example.org/hook/••••••`, for `https://hooks.zapier.com/hooks/catch/123456/abcdef/`
  is `https://hooks.zapier.com/hooks/catch/123456/••••••/` (the last non-empty segment, the
  trailing slash kept), for `https://example.org/` stays
  `https://example.org/`; `authenticated` can select `auto_disabled_at` but not
  `secret_rotated_at`; RLS on `webhook_destination_settings` with no client privileges.
- [x] `alter table destinations add column secret_rotated_at timestamptz`, backfill from
  `created_at` for webhooks; trigger `destinations_secret_rotated_at` (before insert, `when
  (new.type = 'webhook' and new.secret_rotated_at is null)`). `add column auto_disabled_at
  timestamptz`; `grant select (auto_disabled_at) on destinations to authenticated`. `add column
  pause_failures int not null default 0, add column pause_failure_at timestamptz` (no grant).
- [x] `destination_url_display(p_type, p_url)` from `20261014000100` with the webhook branch
  masking the last path segment; `update destinations set url_display = ... where type =
  'webhook'`. `rotate_signing_secret` from `20261006000002` plus the stamp (keep its grants:
  `create or replace`).
- [x] `webhook_fields()`, `webhook_fields_valid(text[])`, `destination_batch_full(text)`,
  `webhook_claim_max(int)`, `webhook_retry_max_attempts(text)`,
  `webhook_retries_exhausted(text, int)`, `webhook_retry_delay(text, int)` (spec, Delivery
  policy), `webhook_pause_spacing()` (30 s), all immutable, `search_path = ''`.
- [x] `webhook_destination_settings` with the spec's columns and checks; `webhook_default_settings()`;
  trigger function `webhook_destination_settings_default()` and trigger
  `destinations_webhook_settings`; the backfill with the decision 10 overrides.
- [x] `check_webhook_setting_keys(jsonb)`, `validate_webhook_fields(text[])`,
  `validate_webhook_settings(webhook_destination_settings)` with the spec's Errors.
- [x] Update `destinations.test.sql` (its webhook `url_display` assertion; it creates 51
  webhooks, so re-read every assertion that could see the new settings row, columns or masking)
  and the advisor lists.
- [x] `supabase db reset && supabase test db`.
- [ ] Commit `Webhook destinations: settings, masked URL and secret rotation time`.

### Task 2: Extra headers in Vault

**Files:** the migration (section 3); `webhook_destinations.test.sql`.

- [x] Tests first: saving two headers creates two Vault rows whose decrypted values match;
  `webhook_header_names` returns names only, in order; saving the same names without values keeps
  the secret ids; a new value replaces the secret (the old Vault row is gone); reordering keeps
  ids; a renamed header without a value raises "Give the {name} header a value."; an 11th raises
  "Up to 10 headers."; `Content-Type`, `x-longlines-anything`, `Proxy-Foo` raise "{name} is set by
  Long Lines."; `Authorization` twice in different case raises "Add each header once."; a value
  with `\r\n` or `é` raises "Header values can only use printable ASCII characters."; 1,025
  characters raises the length message; `[]` removes all and their Vault rows; deleting the
  destination as its owner (`delete from destinations` under `as_user`) and deleting the auth user
  both remove the Vault rows; `authenticated` has no privilege on the table.
- [x] `webhook_header_name_valid(text)`; table `webhook_destination_headers` (spec, Schema); RLS on,
  revokes; the deferrable unique on position and the unique index on `lower(name)`.
- [x] Trigger function `webhook_destination_headers_drop_secret()` (`security definer`,
  `search_path = ''`, deletes `old.secret_id` from `vault.secrets`), triggers after delete and
  after update of `secret_id`.
- [x] `webhook_header_names(uuid)`, `webhook_header_values(uuid)`,
  `set_webhook_headers(uuid, jsonb)` as the spec's Extra headers section describes: validate the
  whole list, then delete, update, insert.
- [ ] Commit `Webhook destinations: extra headers stored in Vault`.

### Task 3: Rendering, client RPCs, test RPC, duplicate, API

**Files:** the migration (sections 4, 6 to 8); `webhook_destinations.test.sql`;
`management_api.test.sql`; `advisor.test.sql`; `scripts/smoke-test.sql`.

- [x] Tests first, rendering: the default 11 pairs in order for `push_sample_spot()`; camel keys
  (`placeName`, `frequencyKhz`); `mhz` gives key `frequency_mhz` and `14.062`, `hz` gives
  `frequency_hz` and `14062000`, kHz `10123.900` renders `10123.9`; `iso_utc` gives
  `2026-10-17T17:42:09Z` and `unix_seconds` gives `1792258929` for that time; a DX Cluster spot
  omits `reference`, `place_name`, `state` and `url` with `omit` and sends them as JSON null with
  `null`; `country` is null with no cty.dat rows and the entity name with one inserted; `url` for
  POTA, SOTA and WWFF; `comment` with quotes and a newline survives as a JSON string; the keys of
  `webhook_spot_object(...)::text` (parsed with `json_object_keys`) equal the pairs' keys in order;
  `webhook_request_body` is the single body with batch 0 and `{"spots": [item]}` otherwise;
  fields `[reference]` with `omit` on a DX Cluster spot gives pairs `[]` (not null), object `{}`
  and a body with `"spot": {}`.
- [x] Tests first, RPCs: `save_webhook_destination` creates (secret returned once, `whsec_` and 48
  hex characters), refuses a blank URL with "Use an https URL.", updates without returning a
  secret, keeps the URL on null or blank, merges settings key by key, raises "Unknown setting x."
  and each validation message, name clash message, another user's id is "Destination not found.";
  `get_webhook_destination` never has `url`, `signing_secret` or a value (check the jsonb's keys);
  `list_webhook_destination_settings` counts fields and shows the window for the caller's webhooks
  only; `preview_webhook_request` matches `webhook_request_body` for the same inputs, names the
  connection when one uses the destination and "Example connection" otherwise, and refuses another
  user's destination id by falling back to "Example connection"; `webhook_test_delivery` returns
  header values, `webhook_connection` "Test", null for a Discord id or an unknown spot, and is not
  executable by `authenticated`; `duplicate_destination` on a webhook gives "Copy of {name}",
  disabled, the same `url`, `signing_secret` and `secret_rotated_at`, equal settings, headers with
  new Vault ids and equal decrypted values, and still works for push and Discord;
  `api_destination_json` of a webhook has `webhook` with names only; `update_destination(id, null,
  null, true)` on an auto-disabled webhook clears `auto_disabled_at` and `pause_failure_at` and
  zeroes `consecutive_failures` and `pause_failures` but leaves health.
- [x] `webhook_field_key`, `webhook_field_value`, `webhook_spot_fields`, `webhook_spot_object`,
  `webhook_request_body` (spec, Rendering).
- [x] `save_webhook_destination`, `get_webhook_destination`, `list_webhook_destination_settings`,
  `preview_webhook_request` (`authenticated`), `webhook_test_delivery` (service role).
- [x] `update_destination` from `20261016000400` plus the resume rule; `duplicate_destination` from
  `20261018000100` plus the webhook branch and no type check; `api_destination_json` from
  `20261018000100` plus `webhook`.
- [x] Grants at the end of the file; advisor lists.
- [x] `scripts/smoke-test.sql`: a webhook block after Discord's, asserting trigger
  `destinations_webhook_settings` exists, that `webhook_spot_fields(jsonb_populate_record(null::
  webhook_destination_settings, webhook_default_settings()), push_sample_spot())` gives the 11
  default keys in order, and that `webhook_request_body` of it has `delivery_id`, `connection` and
  `spot`.
- [ ] Commit `Webhook destinations: rendering, editor RPCs, test RPC, duplicate and API`.

### Task 4: The claim and failures

**Files:** the migration (section 5); `supabase/tests/deliveries_rpc.test.sql`;
`supabase/tests/claim_expiry.test.sql`; `webhook_destinations.test.sql`;
`sender_role.test.sql` (unchanged, must pass); and every suite that uses
`create_destination('webhook', ...)` as the generic destination: `matcher`, `management_api`,
`discord_destinations`, `push_destinations`, `push_devices`, `dxcluster`, `wwff`, `rbn`,
`subscriptions`, `subscription_rules` (and `destinations`, Task 1).

- [x] Audit the existing suites first. After the migration a new webhook gets `three_10m`, batch
  0 (5 a claim) and (from PR 3) pause 20, so a test that meant "a generic destination" can change meaning.
  Where it means generic, pin today's behaviour in its transaction (`update
  webhook_destination_settings set retry_policy = 'day', pause_after_failures = null`); where it
  claims more than 5 rows from one webhook, either expect the cap (it is now the behaviour) or set
  `batch_seconds = 10` and queue the rows with `created_at` over 10 s old so the hold releases.
  Known breaks: `deliveries_rpc.test.sql`'s `mark_deliveries_failed(..., 300)` then "vt > now() +
  200 s" (line ~53; SQL's schedule wins for webhooks, so move the `p_delay_seconds` assertion to
  its Discord destination `dd` and assert the webhook's SQL delay separately), its five failures
  in a row (exhausted under `three_10m`), and its `fair`/`fair2`, budget and `big` sections;
  `claim_expiry.test.sql`'s webhooks (it claims exactly 5). Run each suite before and after and
  account for every changed assertion in the commit message.
- [x] Tests first, claim: a claimed webhook row's destination jsonb has `webhook.batch_seconds` and
  `webhook.headers` with values, its spot has `webhook_fields` (the pairs) and
  `webhook_connection` (the subscription's name); Discord and push rows are unchanged; with batch
  10 a 3 s old row is held and a 12 s old one is claimed, 50 young rows are claimed at once, 49 are
  held; Discord still releases at 10 (`destination_batch_full`); with batch 0 a webhook with 12
  ready rows is handed 5, and with batch 30 (old enough) up to the budget; webhooks have no claim
  interval (two claims 1 s apart both hand rows).
- [x] Tests first, failures: `three_10m` rows get vt +60, +180, +360 on failures 1 to 3 (check
  `pgmq.q_deliveries_queue.vt` against `now()`) whatever `p_delay_seconds` says; after the fourth
  failure the vt is now and the next claim drops the row with `dropped_at`; `none` drops after one
  failure; `day` follows 30, 60, 120, 300, 900, 1800, 1800; a Discord or push row still gets
  `p_delay_seconds`; an exhausted row past the sweep's batch of 500 is not claimed (`ready`);
  `mark_deliveries_sent` resets `consecutive_failures` as before.
- [x] Tests first, pause: with pause 3, three failures less than 30 s apart (`pause_failure_at`
  stays) count once while `consecutive_failures` counts three; three failures with
  `pause_failure_at` moved back 31 s each time set `enabled = false` and `auto_disabled_at`, and
  health follows `consecutive_failures` as today (`ok` at 3, `failing` from 5), never `paused`; a success between counted failures restarts the count at 1 (`last_success_at >
  pause_failure_at`); the next claim's unwanted sweep drops the queued rows **with** `dropped_at`
  while `auto_disabled_at` is set, including the row that just failed and a row in retry backoff
  at pause time (the pause makes the whole queue visible), so none is queued after resume; a
  destination disabled by hand still drops them without it; pause null never counts.
- [x] `mark_deliveries_failed` from `20261006000010` (grants kept by `create or replace`):
  deliveries, then destinations with the spaced pause count, then per-message vt from `unnest(
  p_delivery_ids, p_msg_ids)`, then vt 0 for every queued row of a destination the pause turned
  off (spec, Delivery policy, step 4).
- [x] `claim_deliveries` from `20261018000100`, keeping everything, with only: the unwanted sweep
  (0a) sets `dropped_at = v_now` for rows of a destination with `auto_disabled_at` set; `ready` also selects
  `dest.type` and leaves out `webhook_retries_exhausted(ws.retry_policy, d.attempts)` rows (left
  join `webhook_destination_settings ws`); the 0b sweep drops those rows too; `held` joins both
  settings tables and uses `destination_batch_full(type)` (the `c_batch_full` constant goes);
  `budget.claim_max` per the spec; step 7 gains a `webhook_dests` CTE (settings coalesced to the
  defaults, `{"webhook": {"batch_seconds", "headers": webhook_header_values(id)}}`), a join to
  `subscriptions` for the name, and the two spot keys. Update the function's header comment with
  the additions.
- [x] `supabase db reset && supabase test db`; `scripts/smoke-test.sql`; `supabase db lint`;
  `SENDER_TEST_DATABASE_URL="$DB_URL" deno test -P sender/__tests__/db.test.ts`.
- [ ] Commit `Webhook delivery policy in SQL: grouping, per-claim cap, retry policies and pause`.

### Task 5: The sender and send-test

**Files:** `supabase/functions/_shared/delivery/types.ts`, `format.ts`, `send.ts`, `run.ts`;
`supabase/functions/_shared/handlers/test_delivery.ts`; tests
`supabase/functions/_shared/__tests__/delivery_format.test.ts`, `delivery_send.test.ts`,
`handlers_test_delivery.test.ts`, `handlers_api.test.ts`; `sender/__tests__/sender.test.ts`.

- [x] Tests first, `delivery_format.test.ts`: `webhookRequests` with batch 0 gives one
  `{delivery_id, connection, spot}` per delivery and `JSON.stringify` writes the spot's keys in the
  pairs' order; batch 30 with 120 deliveries gives `{spots}` requests of 50, 50 and 20 with counts;
  a missing `destination.webhook` or one row without `webhook_fields` gives the legacy body, whose
  spots carry no `webhook_*`, `push_*` or `discord_*` keys; `webhook_fields: []` is new-style and
  gives `"spot":{}`, not the legacy body; `webhook_fields: null` is legacy and does not throw; `extraHeaderAllowed` refuses every
  reserved name in both cases and `x-longlines-*`, `proxy-*`; `webhookExtraHeaders` drops a value
  with a control character.
- [x] Tests first, `delivery_send.test.ts` (a local `Deno.serve` receiver, `allowInsecure`): the
  receiver sees the headers in the spec's order (fixed five, then `X-LongLines-Test`, then the
  extras by position; read the raw request), the fixed five unchanged even when an extra header
  tries `Content-Type`, `X-LongLines-Test: true` only on a test delivery, a valid signature over the
  exact body, five requests for five deliveries at batch 0 with `sent` 5; a 500 on the third
  returns `sent` 2, `attempted` 3 and `status` 500; a grouped 500 on the second of three requests
  returns `attempted` 100; a 204 returns `status` 204; the legacy path still works.
- [x] Tests first, `delivery_run.test.ts`: five one-spot deliveries with a 500 on the first call
  `mark_deliveries_failed` with one delivery id and leave four untouched (`unattempted` 4);
  Discord and push results without `attempted` mark the whole rest, as today; a 429 still
  throttles every unsent row.
- [x] Tests first, `handlers_test_delivery.test.ts` (`fake_supabase`): a webhook test calls
  `webhook_test_delivery` with the spot id, sends with `test: true`, answers `{ok: true, status}`,
  or 502 `{error, status}`; null data gives the 404 messages; an RPC error gives 500.
  `handlers_api.test.ts`: `POST /destinations/{id}/test` passes `status` through.
  `sender/__tests__/sender.test.ts`: a claim with the new keys reaches the receiver in the new
  shape (keep the legacy case).
- [x] `types.ts`, `format.ts`, `send.ts`, `run.ts`, `test_delivery.ts` per the spec's Sender
  section. Remove
  `sampleSpot` and its tests; comment `backoffSeconds` (SQL's schedule wins for webhooks) and
  `webhookPayloads` (legacy, goes once the migration is hosted).
- [x] `deno task fmt && deno task lint && deno task check && deno task coverage` (three roots, no
  unloaded module).
- [ ] Commit `Webhook sender: page 7 body in picked order, extra headers, test marker and status`.

### Task 6: Docs, types and PR 2

**Files:** `docs/WEBHOOKS.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`,
`web/src/lib/database.types.ts`, `web/src/sources/sources.ts`, `web/src/sources/SourceDetailPage.tsx`
(+ tests).

- [x] `docs/WEBHOOKS.md` rewritten: request headers (the fixed five, extra headers,
  `X-LongLines-Test`), both bodies (the spec's examples), the field table with keys per style and
  unit, values as stored, missing values, ordering, the grouping window and the 50-spot cap, one
  request per spot sustaining about 50 a minute and the head-of-line cost of a slow receiver,
  retry policies with their schedules (only spots that were in a request count an attempt), the
  10 s timeout, 429s, pause (failures counted at most once per 30 s, so 20 take at least about 10
  minutes; the waiting spots are dropped) and how to resume, Send test, signature verification (the Express example
  parses both shapes), rotating, address rules, and a "Changed 2026-10" section showing the old
  `{deliveries}` body and how to migrate.
- [x] `docs/API.md`: the `webhook` object, `POST /destinations/{id}/test` returning `status`, PATCH
  `"enabled": true` resuming a paused webhook, a webhook created by the API getting defaults.
- [x] `docs/ARCHITECTURE.md` Delivery section: webhook rendering in SQL, Vault headers, the retry
  policy in `mark_deliveries_failed`. `CLAUDE.md`:
  - Delivery rules: `mark_deliveries_failed` takes SQL's delay for webhooks; the attempts
    predicate shared by the sweep and `ready`; pause is `enabled = false` with `auto_disabled_at`,
    counted at most once per `webhook_pause_spacing()`, and the unwanted sweep sets `dropped_at`
    while `auto_disabled_at` is set; only attempted rows are marked failed (`attempted`); the
    reserved header list lives in SQL and `format.ts`. Extend the knob sentence ("its knobs are
    `destination_budget`, ...") with `destination_batch_full(type)`,
    `webhook_claim_max(batch_seconds)`, `webhook_retry_delay`, `webhook_retry_max_attempts`,
    `webhook_retries_exhausted`, `webhook_pause_spacing`, and "the Discord and webhook batch hold".
  - Subscription rules: "the webhook body's `connection_id`" becomes "the webhook body's
    `connection` (the connection's name)".
  - Source catalog rules: the Schema and Example cards describe the delivered spot as the webhook
    field catalog with its default keys (`COMMON_FIELDS` in `webhook_fields()` order).
- [x] `sources.ts` and `SourceDetailPage` (spec, Web, Sources; moved here from PR 3 so
  `/sources/:id` changes with the delivered spot): `COMMON_FIELDS` becomes the catalog in
  `webhook_fields()` order with default keys and types; per-source wording for `source`,
  `reference`, `place_name`, `state` and `url`; each `example` is that source's default `spot`
  object; the Schema card note (Copy). Update their tests.
- [ ] `supabase gen types typescript --local > web/src/lib/database.types.ts`; `cd web && npm run
  build` still passes.
- [ ] `npm run test:all` against a reset stack. Commit `Webhook docs: page 7 body, retries, pause
  and headers`, push `webhook-schema`, open PR 2 stacked on `webhook-spec`. PR text: **merging
  deploys the sender**; it sends today's body until `supabase db push`; Brad's steps 1 to 3.

---

## Part 2: Web (PR 3, branch `webhook-ui`)

### Task 7: `api.ts`, the model and FieldPicker

**Files:** `web/src/lib/api.ts` (+ test), `web/src/destinations/webhookModel.ts` (new, + test),
`web/src/destinations/FieldPicker.tsx` (+ test for the new props).

- [ ] `api.ts`: types `WebhookField`, `WebhookSettings`, `WebhookHeaderInput {name: string;
  value?: string}`, `WebhookDestination`, `WebhookDestinationInput`, `WebhookSettingsSummary`;
  `saveWebhookDestination(input) → {id, signingSecret: string | null}`,
  `getWebhookDestination(id)`, `listWebhookDestinationSettings()`,
  `previewWebhookRequest(settings, spotId | null, destinationId | null) → unknown` (the parsed
  body, key order kept); `sendTest` returns `{status: number | null}`; `Destination` and its column
  list gain `auto_disabled_at`. Tests: RPC names and arguments for each.
- [ ] `webhookModel.ts`: `WEBHOOK_FIELDS` (ids and the spec's labels), `FIELDS_MIN` 1,
  `FIELDS_MAX` 14, `DEFAULT_WEBHOOK_SETTINGS`, `PAUSE_AFTER` 20, `webhookKey(field, keyStyle,
  unit)`, the option lists (`KEY_STYLES`, `TIME_FORMATS`, `FREQUENCY_UNITS`, `MISSING_VALUES`,
  `REQUEST_OPTIONS`, `RETRY_POLICIES`) with the Copy labels, `timeExample(format)`,
  `missingHelper(value)`, `WebhookForm`, `blankForm`, `formOf`, `toInput`, `dirty`, header row
  helpers (`addHeader`, `removeHeader`, `headerInput`: saved rows send no value unless typed),
  `webhookCardLine(count, batchSeconds)`. Reuse `sendTestBlocker` from `discordModel.ts` (move it
  to `fieldList.ts` or a shared module if both import it).
- [ ] A migration (next free number after `20261018000300`) that `create or replace`s
  `webhook_default_settings()` with pause 20 (spec, decision 10), a pgTAP case in
  `webhook_destinations.test.sql` (and `management_api.test.sql`'s API-created webhook) updated
  to 20, and `docs/WEBHOOKS.md`'s "off by default for now" changed to "on by default for new
  destinations".
- [ ] `webhookModel.test.ts` (node): `DEFAULT_WEBHOOK_SETTINGS` equals the jsonb in
  `webhook_default_settings()` read from the latest migration that defines it (the pause-default
  migration above), as `discordModel.test.ts` does;
  `webhookKey` for every field, style and unit equals the spec's key table; card lines, including
  "Webhook · 1 field" and "Webhook · 1 field · grouped every 30 seconds"; header input rules;
  `dirty`.
- [ ] `FieldPicker`: optional `keyOf?: (id: T) => string` (monospace secondary per row) and
  `addAs?: "select" | "chips"` (chips "+ {label}" with aria-label "Add {label}" under "Not
  included"). With every field included the heading and chips are hidden and the helper stays;
  test that case. Push and Discord tests unchanged.
- [ ] Commit `Webhook editor: api wrappers, model and field picker keys and chips`.

### Task 8: Destinations list, dialog and routing

**Files:** `web/src/destinations/DestinationCard.tsx`, `cardMeta.ts`, `HealthChip.tsx`,
`DestinationDialog.tsx`, `DestinationsPage.tsx` (each + test), `web/src/App.tsx` (+ test), the push
and Discord specs (one Copy line each).

- [ ] `cardMeta`: "Used by …" / "Not used by any connection" (spec decision 17; update the push and
  Discord card tests and the function's "per the page 5 copy" comment). Delete tooltip singular and
  plural. Add a one-line amendment to the Copy of
  `docs/superpowers/specs/2026-10-13-push-notifications-design.md` and
  `docs/superpowers/specs/2026-10-18-discord-destination-design.md` pointing the card meta line at
  the webhook spec's decision 17.
- [ ] `DestinationCard`: webhooks editable and duplicable; Rotate secret goes; the type line from
  `webhookCardLine` with the page's one `listWebhookDestinationSettings()` (called only when a
  webhook exists, like `listDiscordDestinationSettings`); `HealthChip` gets `paused` when
  `auto_disabled_at` is set.
- [ ] `DestinationsPage`: a webhook's Send test toasts "{name} answered HTTP {status}."; the rotate
  `SecretDialog` and its state go.
- [ ] `DestinationDialog`: only the type step; Continue navigates to `/destinations/new?type={id}`
  for all three; `onCreated` and the details step go (update its test and the page's).
- [ ] `App.tsx` `DestinationRoute`: `webhook` → `WebhookDestinationPage` (a stub until Task 9 is
  fine inside this commit if the page lands next; otherwise do Task 9 first).
- [ ] Commit `Destinations: webhook cards with Edit and Duplicate, type picker hands off to the editor`.

### Task 9: Editor page, Endpoint card and the secret dialog

**Files:** `web/src/destinations/WebhookDestinationPage.tsx`, `WebhookEndpointCard.tsx`,
`SigningSecretDialog.tsx` (new, each + test).

- [ ] `WebhookDestinationPage`: the Discord page's gatekeeper, Loader and Editor; the paused alert
  ("Paused {ago} after ...", from `auto_disabled_at`) whenever it is set, whatever the pause
  switch says; save through `saveWebhookDestination`; new → the created
  `SigningSecretDialog`, and on Done toast "Added {name}" and go to `/destinations`; edit → toast
  "Saved changes" and go to `/destinations`; the name-taken message on the Name field.
- [ ] `WebhookEndpointCard`: Webhook URL with "Must start with https://"; on edit the masked URL,
  Replace URL, "The URL is hidden after saving.", Keep current URL while replacing; the signing
  secret block (`whsec_••••••••`, Rotate → `rotateSigningSecret` → the rotated dialog, "Rotated
  {ago}" from `timeAgo`; the new-destination sentence instead); header rows (Header, Value with the
  saved placeholder, Remove header, Add a header disabled at 10) and the sentence.
- [ ] `SigningSecretDialog`: both variants (Copy); Copy writes to the clipboard and shows Copied;
  Done disabled until the checkbox; no `onClose` on the `Dialog`.
- [ ] Tests: new and edit modes, a non-webhook id redirect, Replace URL and Keep current URL, an
  empty URL keeps the stored one in the saved input, header add/remove/rename-needs-value, the
  10-header limit, Rotate opens the dialog with the new secret and, after Done, the page stays
  with unsaved edits kept and the secret line reads "Rotated 1 minute ago"; Done gating; the
  paused alert, including with the pause switch off; the phone layout (`setMobile(true)`, Save).
- [ ] Commit `Webhook editor: page, endpoint, headers and the signing secret dialog`.

### Task 10: Payload, Delivery and the Request preview

**Files:** `web/src/destinations/WebhookPayloadCard.tsx`, `WebhookDeliveryCard.tsx`,
`WebhookPreviewCard.tsx` (new, each + test).

- [ ] `WebhookPayloadCard`: the Always sent box; `FieldPicker` with heading "Included, in this
  order", `keyOf` from `webhookKey` with the current style and unit, `addAs="chips"`, min 1, max
  14, the Comment note as helper; the four selects with their helpers; Reset to default fields
  (only `fields` back to the defaults, as Discord's; the selects keep their choices).
- [ ] `WebhookDeliveryCard`: Requests and Retry selects with helpers (the Requests helper names
  the other choice, Copy); the pause `SettingSwitch`
  (on is `PAUSE_AFTER`, off is null) with its aria-label.
- [ ] `WebhookPreviewCard`: the spot select from `useRecentSpotPicker`; the request line (typed URL
  path when new or replacing, else `url_display`'s path), the five fixed headers in the sent order
  (`Accept` first), each extra header name with `••••••••`, then `previewWebhookRequest(...)` pretty-printed with two spaces, debounced
  300 ms; Send test request with `sendTestBlocker` captions; the result line from `sendTest`.
- [ ] Tests: field add (chip), move, remove, the minimum; Reset leaves the selects alone; keys
  follow style and unit; each select round-trips, and the Requests helper switches with it; the pause switch maps to 20 and null; the preview RPC is called with the settings,
  the chosen spot and the destination id, and its keys show in order; the request line in new,
  edit and replacing modes; masked header names; Send test states and the status line.
- [ ] Commit `Webhook editor: payload fields, delivery settings and request preview`.

### Task 11: Sources, CLAUDE.md, gates and PR 3

**Files:** `CLAUDE.md`, `docs/superpowers/specs/2026-10-18-webhook-destination-design.md`, `README.md` if it
describes the webhook body.

- [ ] CLAUDE.md: a "Webhook rules" section after "Discord rules" (settings and headers tables,
  Vault, SQL renders pairs, the preview's `json`, the hold and `destination_batch_full`,
  `webhook_claim_max`, the retry knobs and the shared predicate, pause as `enabled = false`, the
  reserved header list in two places, the editor copy source). (The Source catalog wording went
  in with PR 2.)
- [ ] Spec status line: shipped.
- [ ] Gates, then the end to end from the spec's Verification (local receiver, `psql` to point the
  URL at it, `npm run sender` with `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1`). Record in the PR
  which steps ran.
- [ ] Commit `Webhook editor: rules and spec status`, push `webhook-ui`, open
  PR 3 stacked on `webhook-schema`. Run /code-review and fix what it finds.

---

## Out of scope

- Email on pause; the sender spec's Phase 2 C health model.
- Grid square, Latitude, Longitude, Spotter grid.
- Changing webhook settings or headers through the management API.
- A pause threshold other than 20 in the editor.
- Templates (page 6).
- Moving Discord's and push's retry schedule into SQL; LISTEN; per-request watchdog progress.

## Session prompts

### Part 1 prompt

```
Create the worktree: git fetch origin && git worktree add ../longlines-webhook-schema -b webhook-schema origin/webhook-spec (origin/main if PR 1 is merged). Work only there.

Read docs/superpowers/specs/2026-10-18-webhook-destination-design.md in full, and docs/superpowers/plans/2026-10-18-webhook-destinations.md: "Where things stand", "Global Constraints", "Review Focus", "Brad's steps" and Tasks 1 to 6. Read CLAUDE.md's Delivery, Discord, Sender, Phase 2 schema, Subscription, Source catalog and Conventions rules, supabase/migrations/20261018000100_discord_destinations.sql, and the latest definitions the plan names. Don't read the canvas.

Do Tasks 1 to 6 in order, tests first, one commit each, ticking the boxes. One migration file, 20261018000300_webhook_destinations.sql (check origin/main for a newer number before pushing). Run the gates in Global Constraints before the PR. Push with git push -u origin webhook-schema and open PR 2 stacked on webhook-spec. Don't merge. Never run supabase db push, functions deploy, fly deploy, fly secrets set or vercel.
```

### Part 2 prompt

```
Create the worktree: git fetch origin && git worktree add ../longlines-webhook-ui -b webhook-ui origin/webhook-schema (origin/main if PR 2 is merged). Work only there; run supabase db reset first so the local stack has the migration.

Read the spec's Decisions, Web and Copy sections, the plan's "Global Constraints", "Review Focus" and Tasks 7 to 11, and CLAUDE.md's Web app, Discord, Subscription and Source catalog rules. Read web/src/destinations/ (the Discord page, cards and model are the pattern), web/src/lib/api.ts and web/src/test/render.tsx. Don't read the canvas.

Do Tasks 7 to 11 in order, tests first, one commit each, ticking the boxes. Copy word for word from the spec's Copy section. Gates after each task: cd web && npm run coverage, npm run build, npm run lint. Push with git push -u origin webhook-ui and open PR 3 stacked on webhook-schema. Don't merge.
```
