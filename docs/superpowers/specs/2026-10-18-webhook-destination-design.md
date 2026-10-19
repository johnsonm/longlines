# Webhook destination editor: design

Date: 2026-10-18. Status: **shipped** (PR 2 the schema and sender, PR 3 the web editor). The
decisions were proposed 2026-10-18 from Brad's approved plan of 2026-10-17; Brad's six (1, 3, 5,
6, 7 and 8 below) were accepted, and the rest were reviewed in the spec PR.
If the design changes during a PR, update this file in that PR.

Source: page 7 of Brad's design canvas, artboards `WebhookList-Desktop` ("Destinations with
webhooks"), `WebhookEdit-Desktop` ("Edit webhook destination"), `WebhookEdit-Mobile` ("Edit
webhook destination, mobile") and `WebhookSecret-Desktop` (the edit page with the "Destination
added" dialog over it). Where the canvas and this file disagree, this file wins; the differences
are listed under Decisions.

## Purpose

Today a webhook is a name and a URL, typed in step 2 of the Add destination dialog, and can never
be edited in the app: its card has Send test, Rotate secret and Delete, and `/destinations/:id`
sends a webhook id back to the list. `duplicate_destination` refuses it. Every request is
`{"deliveries": [{"delivery_id", "connection_id", "spot"}]}` with up to 50 spots and the stored
spot's own keys (`spot_time`, `pota_reference`, `sota_summit_ref` and so on). A failed request is
retried on the TypeScript schedule (`backoffSeconds`: 30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m)
until the spot is 24 hours old. Nothing ever stops a destination that keeps failing. There are no
extra headers, no field picking and no preview.

Page 7 gives webhooks a full-page editor like Discord's (page 8): an Endpoint card (the URL, the
signing secret with Rotate, extra headers), a Payload card (an ordered pick of fields with fixed
key names, key style, time format, frequency unit and what to send for a missing value), a
Delivery card (one request per spot or grouped every 10, 30 or 60 seconds, a retry policy, pause
after repeated failures), a sticky Request preview with Send test request, and a "Destination
added" dialog that shows the signing secret once.

The model is Discord's (#216, #217): a settings table with a defaults trigger, the spot rendered in
SQL and carried in the claim's jsonb, a preview RPC and a service-role test RPC that call the same
renderer, policy (hold, retry, pause) in SQL, a sender that only shapes what SQL rendered, and an
editor whose pure model is pinned to SQL's defaults by a test.

## Decisions

1. **Page 7's body shape.** A request carries one spot as
   `{"delivery_id", "connection", "spot"}`, or, when the destination groups spots, a list of those
   as `{"spots": [...]}`. The spot's keys are the generic ones of the field catalog (decision 6),
   not the stored columns. This is one documented breaking change for existing receivers
   (`docs/WEBHOOKS.md`, "Changed 2026-10"); the outbound sender spec's "envelope kept" (section
   9A) is superseded. *Decided 2026-10-17.*
2. **Values as stored.** `delivery_id` and the spot `id` are integers and `source` and `mode` are
   the lower-case ids Long Lines stores (`pota`, `cw`). The canvas's `"dlv_8f2c1a"`,
   `"spt_4421907"`, `"POTA"` and `"CW"` are illustrative. `connection` is the connection's name.
   *Decided 2026-10-18.*
3. **No email.** The system has no email path. Pausing after repeated failures lands and shows in
   the app only, and the switch's sentence drops "and you get an email". *Decided 2026-10-17.*
4. **Pause turns the destination off.** CLAUDE.md says nothing in the app sets
   `destinations.health = 'paused'`, so pausing does not. When a webhook's
   `pause_after_failures` is set (20 when the switch is on, null when off) and its pause count
   reaches it, `mark_deliveries_failed` sets `enabled = false` and stamps a new column
   `destinations.auto_disabled_at`. The matcher then makes no new deliveries, the same call makes
   every queued row of the destination visible (vt 0, rows waiting out a retry delay included,
   *amended 2026-10-18 in PR 2's review*: the sweep sees only visible rows, so a row in backoff
   would otherwise survive a quick resume), and the claim's
   unwanted sweep drops the queued ones as for any disabled destination, except that it sets
   `dropped_at` on them while `auto_disabled_at` is set: those spots are lost, not unwanted. Health
   keeps its normal rules (it is `failing` from the fifth failure on). Turning Enabled back on (the
   editor's save, or `PATCH` with `"enabled": true`, both through `update_destination`) clears
   `auto_disabled_at`, the pause count and `consecutive_failures`; health stays as it is until the
   next success sets `ok`.
   **The pause count is spaced.** The sender calls `mark_deliveries_failed` once per destination
   per cycle (each call is one failed request, decision 14), and a cycle runs every few seconds
   while spots arrive, so counting every call would turn off a busy webhook after about two
   minutes of receiver downtime, such as a deploy. So the pause has its own count,
   `destinations.pause_failures` with `pause_failure_at`: a failure adds to it only when the last
   counted one is at least `webhook_pause_spacing()` (30 seconds) old, and it starts again from 1
   when a delivery succeeded since the last counted failure (`last_success_at >
   pause_failure_at`), so `mark_deliveries_sent` does not change. Twenty counted failures take at
   least 9.5 minutes of failing, about the span of `three_10m`. `consecutive_failures` still counts
   every call and drives health as today. The card's chip says Paused while `auto_disabled_at` is
   set, and the editor says when and why (Copy). *Decided 2026-10-18.*
5. **Extra header values live in Supabase Vault.** Each header is a row in
   `webhook_destination_headers` holding its name and a Vault secret id; the value goes in with
   `vault.create_secret` and comes back only through `vault.decrypted_secrets`, read by
   `claim_deliveries`, `webhook_test_delivery` and `duplicate_destination`. Clients and the API
   only ever get header names. *Decided 2026-10-17.*
6. **Field catalog.** Spot ID, Time, Callsign, Frequency, Mode, Band, Source, Reference, Place
   name, State, Spotter, Country (the cty.dat entity name from `cty_lookup`), Spot URL
   (`spot_source_url`) and Comment (free text), in that order. The canvas's Grid square, Latitude,
   Longitude and Spotter grid are left out: no source carries them. *Decided 2026-10-17.*
7. **The secret is never shown again, even in part.** The editor shows `whsec_••••••••` and
   "Rotated {ago}" from a new column `destinations.secret_rotated_at`. The canvas's last four
   characters (`0395`) are not built, and no RPC returns any part of the secret except the
   one-time returns of create and rotate (CLAUDE.md, Phase 2 schema rules). *Decided 2026-10-17.*
8. **The URL is never returned.** On edit the Endpoint card shows the masked `url_display` and a
   Replace URL button that opens an empty Webhook URL field, with Keep current URL beside it, as
   Discord decision 10. Saving with the field closed or empty keeps the stored URL; a new URL goes
   through `validate_destination_url` and clears failing health, as `update_destination` does.
   The canvas draws the full URL (`https://logger.example.org/hook/abc123`) in the field; that is
   amended here. `destination_url_display` now masks a webhook's last path segment
   (`https://logger.example.org/hook/••••••`), as the list artboard draws, and existing rows are
   backfilled. The preview's request line uses the typed URL's path on a new destination or while
   replacing, and the masked path otherwise (`POST /hook/••••••`). *Decided 2026-10-17.*
9. **A full-page editor** at `/destinations/new?type=webhook` and `/destinations/:id`, the same
   skeleton as the Discord editor. The Add destination dialog's Continue goes there for webhooks
   too, so the dialog keeps only its type step. Rotate moves from the card into the editor's
   Endpoint card; the card's actions are Send test, Edit, Duplicate and Delete, as the list
   artboard draws. *Decided 2026-10-18.*
10. **Settings live in `webhook_destination_settings`**, one row per webhook destination (RLS on,
    no policies, no client grants), created with defaults by a trigger. Existing webhooks are
    backfilled with settings as close to today as the new body allows: every field, grouped every
    10 seconds (today's body is already a list per claim), the `day` retry policy (today's 24
    hours) and pause off (today nothing pauses). A silent cut to 10 minutes of retries or a new
    pause could lose spots for a receiver that worked yesterday. New webhooks get the canvas's
    defaults, except that `webhook_default_settings()` keeps the pause null in PR 2 and PR 3's
    migration makes it 20 (*amended 2026-10-18 in PR 2's review*): between the hosted push and the
    web deploy the old app can neither show a paused webhook nor turn one back on, so a webhook
    made through the old dialog must not turn itself off. *Decided 2026-10-18.*
11. **SQL renders every value** (`webhook_spot_fields`). jsonb does not keep key order, so the
    claim hands the sender the spot as ordered `[{key, value}]` pairs, and the sender builds the
    object in that order. The preview builds its text with `json` (not `jsonb`), which keeps the
    order. The sender never formats, converts or names a value. *Decided 2026-10-18.*
12. **Grouping reuses Discord's batch hold.** `webhook_destination_settings.batch_seconds` in
    {0, 10, 30, 60}. With a window, `claim_deliveries` skips a webhook destination until its
    oldest ready delivery is that old or 50 are ready (one full request); the Discord constant
    `c_batch_full` (10) becomes a knob `destination_batch_full(type)` (Discord 10, webhook 50).
    Held rows keep their vt and are never dropped or delayed by anything else. A grouped request
    carries at most 50 spots (`WEBHOOK_SPOTS_PER_REQUEST`, as today), so one claim of up to 200
    sends at most four. *Decided 2026-10-18.*
13. **One request per spot is capped at 5 spots a claim; no claim interval.** The sender sends a
    destination's requests one after another, each with a 10 s timeout, on one of
    `SENDER_CONCURRENCY` (4) workers, and the cycle's other destinations and the next claim wait
    for the slowest. The cap bounds that head-of-line cost: a receiver that answers just inside
    its timeout holds a worker for at most 50 s a cycle (5 x 10 s), as today's four requests of 50
    spots hold it for 40 s, and a receiver that answers in a second costs 5 s. A smaller cap (3)
    would cut the worst case to 30 s but also a busy connection's rate; the worst case belongs to
    a receiver that is close to failing, and grouping removes it. Neither the claim's 60 s `p_vt`
    nor the watchdog constrains this: marks land after each destination's sends, the sender is a
    serial consumer, and the watchdog counts each finished send as progress (Sender rules), so a
    long healthy cycle is never killed. So a new knob `webhook_claim_max(batch_seconds)` is 5
    when `batch_seconds` is 0 and null otherwise, and the claim's per-destination cap is it for
    webhooks (`destination_claim_max` stays null for them). With the sender polling every 5 s, one
    request per spot sustains about 50 spots a minute per destination; a busier connection should
    group, and `docs/WEBHOOKS.md` says so, along with the head-of-line cost of a slow receiver.
    Webhooks get no `destination_claim_interval`: no receiver has a known per-minute limit, the
    budget stays 1,000 a minute, and a 429 throttles like any other rate limit. *Decided
    2026-10-18.*
14. **Retry policy per destination, in SQL.** `retry_policy` is `none`, `three_10m` or `day`
    (Delivery policy has the schedules). `mark_deliveries_failed` keeps its signature and sets each
    webhook row's vt from SQL's schedule, ignoring the sender's `p_delay_seconds` (still used for
    Discord and push). When a row's attempts are used up its vt is set to now, so the next claim's
    expiry sweep, the only thing that drops a delivery, drops it with `dropped_at`; `ready` applies
    the same predicate so such a row is never claimed again (CLAUDE.md, Delivery rules). **Only
    rows that were in a request count an attempt.** The sender still stops at a destination's
    first failed request, but `SendResult` gains `attempted` (the rows up to and including the
    failed request's), and `run.ts` passes only `batch.slice(sent, attempted)` to
    `mark_deliveries_failed`. The rows after it are left alone and reappear when the claim's own
    `p_vt` (60 s) lapses, the path a destination paused mid-cycle already takes (`skipped_paused`):
    no RPC is skipped, no counter moves and nothing is delayed outside SQL. So `none` never drops a
    spot that was not sent, and a dead receiver costs each spot only its own attempts. A 429 still
    throttles every unsent row, as today. Discord and push leave `attempted` unset, which means the
    whole batch, so their behaviour does not change. *Decided 2026-10-18.*
15. **Send test is rendered and marked in SQL.** `webhook_test_delivery` (service role) renders the
    sample spot or a chosen one through the destination's settings, with `connection` "Test" and
    `delivery_id` 0, and hands the header values. The request also carries `X-LongLines-Test:
    true`. The body has the destination's shape (grouped destinations get a one-item `spots` list).
    `send-test` and the API's `POST /destinations/{id}/test` return the receiver's HTTP status, and
    the editor and the card show it. A test is not a delivery: it writes no row and moves no
    counter. *Decided 2026-10-18.*
16. **Duplicate works for webhooks.** The copy has the same URL, signing secret (and its
    `secret_rotated_at`), settings and headers (each value re-created in Vault, so the copy owns its
    secrets), starts disabled and is named "Copy of {name}" by the rule push and Discord use. A
    fresh signing secret would leave the copy unusable until rotated. `duplicate_destination` now
    accepts every type. *Decided 2026-10-18.*
17. **List cards.** The type line comes from a new `list_webhook_destination_settings()` (field
    count and window per destination), like Discord's: "Webhook · 11 fields" or "Webhook · 5 fields
    · grouped every 30 seconds". The meta line follows pages 7 and 8, which capitalize it, for every
    type: "Used by 1 connection · Last delivery 14 minutes ago" and "Not used by any connection ·
    Never used". Ages stay `timeAgo`'s words ("14 minutes ago"); the canvas's "14 min" is shorthand.
    The Delete tooltip's plural is fixed ("Used by 1 connection."). The artboard's Discord card
    ("Discord channel", Send test and Delete only) predates page 8; page 8's card (type line from
    `discordCardLine`, Edit and Duplicate) stands. Because the meta line changes push and Discord
    cards too, PR 3 adds a one-line amendment to the Copy of the push spec
    (`2026-10-13-push-notifications-design.md`, whose card meta still says "subscription") and the
    Discord spec pointing their card meta at this decision, and fixes `cardMeta.ts`'s comment
    ("per the page 5 copy"). *Decided 2026-10-18.*
18. **Select labels and helpers the canvas does not draw.** The canvas draws one option of each
    select. The full lists are in Copy. The missing-value helper and the Requests helper name the
    other choice ("Or send null." / "Or leave the key out."; "Or group spots ..." / "Or send one
    request per spot. ..."), and the time format helper is an example in the chosen format.
    *Decided 2026-10-18.*
19. **The preview shows the real headers, in the order they are sent.** The canvas's
    `X-LongLines-Delivery: dlv_8f2c1a` does not exist; the preview shows the fixed five
    (`Accept`, `Content-Type`, `User-Agent`, `X-LongLines-Timestamp`, `X-LongLines-Signature`),
    then each extra header's name with its value masked. Only `Host`, which the request line's
    URL already names, is left out. *Decided 2026-10-18.*
20. **The Source catalog follows the new body.** The Schema and Example spot cards on
    `/sources/:id` describe the delivered spot (CLAUDE.md, Source catalog rules), so they list the
    webhook field catalog with its default keys and show the default `spot` object for that
    source. This ships in PR 2 with the body change, not with the editor (Web, Sources).
    *Decided 2026-10-18.*
21. **The API reads webhook settings only**, as for push and Discord: `api_destination_json` gains a
    read-only `webhook` object (settings, header names, `secret_rotated_at`, `auto_disabled_at`). A
    webhook created through the API gets the defaults. No new operation or route. *Decided
    2026-10-18.*

## Schema (migration `20261018000300_webhook_destinations.sql`)

Every new function follows the house rules: `revoke all ... from public` (leaving
`service_role`), a pinned `search_path`, and a grant to `authenticated` only for the client RPCs.
`delivery_sender` gets nothing new: `SENDER_RPCS`, its grants and `sender_role.test.sql` do not
change.

**Destinations**
- `alter table destinations add column secret_rotated_at timestamptz` (webhooks only; not in the
  client column grant). Backfilled with `created_at` for existing webhooks. A before-insert trigger
  `destinations_secret_rotated_at` sets it to `now()` for a new webhook when it is null, so
  `create_destination` needs no change; `duplicate_destination` passes the source's value.
- `alter table destinations add column auto_disabled_at timestamptz` (decision 4), added to the
  client column grant (`grant select (auto_disabled_at) on destinations to authenticated`) so the
  list cards can show Paused.
- `alter table destinations add column pause_failures int not null default 0, add column
  pause_failure_at timestamptz` (decision 4's spaced count; not in the client column grant).
- `destination_url_display(p_type, p_url)`, same signature: a webhook's display is scheme, host,
  port and path without the query, with the last non-empty path segment replaced by `••••••` and
  a trailing slash kept (`https://logger.example.org/hook/••••••`, `https://example.org/••••••`,
  `https://hooks.zapier.com/hooks/catch/123456/••••••/`, and `https://example.org/` for a bare
  root; *amended 2026-10-18 in PR 2's review*: a Zapier catch hook ends in a slash, and masking only
  a non-empty last segment showed its token). Existing webhook rows are backfilled from `url`.
- `rotate_signing_secret(p_destination_id)`, same signature, also sets `secret_rotated_at = now()`.
- `update_destination(p_id, p_name, p_url, p_enabled)`, same signature, from its
  `20261016000400` body plus: when `p_enabled` is true and `auto_disabled_at` is set,
  `auto_disabled_at = null`, `consecutive_failures = 0`, `pause_failures = 0` and
  `pause_failure_at = null`.

**Catalog, knobs and settings**
- `webhook_fields()` = `{id, time, callsign, frequency, mode, band, source, reference, place_name,
  state, spotter, country, url, comment}`; `webhook_fields_valid(p_fields text[])`: known,
  distinct, 1 to 14.
- `destination_batch_full(p_type text) returns int`: Discord 10, webhook 50, others null.
- `webhook_claim_max(p_batch_seconds int) returns numeric`: 5 when 0, else null (decision 13).
- `webhook_retry_max_attempts(p_policy text) returns int`: `none` 1, `three_10m` 4, `day` null.
- `webhook_retries_exhausted(p_policy text, p_attempts int) returns boolean`: true when
  `p_attempts >= webhook_retry_max_attempts(p_policy)`, false when either is null. The expiry
  sweep and `ready` both call it.
- `webhook_retry_delay(p_policy text, p_attempt int) returns int`: seconds to wait after failed
  attempt `p_attempt` (1-based); see Delivery policy.
- `webhook_pause_spacing() returns interval`: 30 seconds, the least gap between two failures that
  both count toward the pause (decision 4).
- `webhook_destination_settings`: `destination_id` (pk, references `destinations` on delete
  cascade), `fields text[]` (check `webhook_fields_valid`), `key_style` (`snake`, `camel`),
  `time_format` (`iso_utc`, `unix_seconds`), `frequency_unit` (`khz`, `mhz`, `hz`),
  `missing_values` (`omit`, `null`), `batch_seconds` (0, 10, 30, 60), `retry_policy` (`none`,
  `three_10m`, `day`), all not null with check constraints, and `pause_after_failures int` (null,
  or 1 to 100; the editor sets 20 or null). RLS on, no policies, no client grants.
- `webhook_default_settings()`: fields `id, time, callsign, frequency, mode, band, source,
  reference, place_name, state, spotter`; `snake`; `iso_utc`; `khz`; `omit`; batch 0;
  `three_10m`; pause null in PR 2, 20 from PR 3's migration (decision 10).
- Trigger `destinations_webhook_settings` (after insert, `when (new.type = 'webhook')`) inserts the
  defaults. The migration backfills existing webhooks with the defaults overridden by every field,
  batch 10, `day` and pause null (decision 10), as `webhook_legacy_settings()` (a function so
  pgTAP can pin the backfill's settings).
- `check_webhook_setting_keys(p_settings jsonb)` raises "Settings must be an object." and "Unknown
  setting {key}."; `validate_webhook_fields(p_fields text[])` and
  `validate_webhook_settings(p_settings webhook_destination_settings)` raise the Errors in Copy.

**Headers**
- `webhook_header_name_valid(p_name text) returns boolean`: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`,
  and not reserved. Reserved, ignoring case: `accept`, `connection`, `content-encoding`,
  `content-length`, `content-type`, `expect`, `host`, `keep-alive`, `te`, `trailer`,
  `transfer-encoding`, `upgrade`, `user-agent`, and any name starting `proxy-` or `x-longlines-`.
  The same list is `WEBHOOK_RESERVED_HEADERS` in `_shared/delivery/format.ts`; change both
  together.
- `webhook_destination_headers`: `id uuid` pk, `destination_id` (references `destinations` on
  delete cascade), `position smallint` (1 to 10), `name text` (check
  `webhook_header_name_valid`), `secret_id uuid not null`; `unique (destination_id, position)
  deferrable initially deferred`; a unique index on `(destination_id, lower(name))`. RLS on, no
  policies, no client grants.
- Trigger `webhook_destination_headers_drop_secret` (after delete, and after update of
  `secret_id`) deletes `old.secret_id` from `vault.secrets`. Its function is `security definer`
  (revoked from public), because a client's `delete from destinations` cascades here.
- `webhook_header_names(p_destination_id uuid) returns jsonb`: `[{name}]` by position.
- `webhook_header_values(p_destination_id uuid) returns jsonb`: `[{name, value}]` by position from
  `vault.decrypted_secrets`. Called only from the claim and the test RPC; duplicate joins
  `vault.decrypted_secrets` itself.
- `webhook_header_secret(p_value text) returns uuid`: the one `vault.create_secret` call (name and
  description as in Extra headers), used by `set_webhook_headers` and `duplicate_destination`.
- `set_webhook_headers(p_destination_id uuid, p_headers jsonb)`: see Extra headers.

**Rendering** (see Rendering)
- `webhook_field_key(p_field text, p_key_style text, p_frequency_unit text) returns text`
  (immutable).
- `webhook_field_value(p_field text, p_spot jsonb, p_time_format text, p_frequency_unit text)
  returns jsonb`: a JSON scalar, or SQL null when the spot has no value (stable: `cty_lookup` is).
- `webhook_spot_fields(p_settings webhook_destination_settings, p_spot jsonb) returns jsonb`: the
  ordered `[{key, value}]` pairs, `coalesce(jsonb_agg(... order by ord), '[]'::jsonb)`, so a spot
  that has none of the picked values (`omit` with `reference` only, on a DX Cluster spot) gives
  `[]`, never SQL null.
- `webhook_spot_object(p_settings, p_spot) returns json`: the same pairs as an object in order
  (`coalesce(json_object_agg(key, value::json order by ord), '{}'::json)`), `{}` for no pairs.
- `webhook_request_body(p_settings, p_delivery_id bigint, p_connection text, p_spot jsonb) returns
  json`: the single body, or `{"spots": [item]}` when `batch_seconds > 0`.

**Client RPCs** (`authenticated`)
- `save_webhook_destination(p_id uuid, p_name text, p_enabled boolean, p_url text, p_settings
  jsonb, p_headers jsonb) returns table (id uuid, signing_secret text)`. A new one (`p_id` null)
  goes through `create_destination('webhook', ...)` (URL check, masked display, name-taken message,
  the triggers) and returns its secret once; a blank URL raises "Use an https URL.". An existing one
  goes through `update_destination` (null name or enabled keeps what is stored, a null or blank URL
  keeps the stored URL) and returns a null secret. Settings merge key by key over the stored row
  and are checked as a whole, as Discord's; `p_headers` goes to `set_webhook_headers` (null leaves
  the headers alone).
- `get_webhook_destination(p_id uuid) returns jsonb`: `{id, name, enabled, url_display, settings,
  headers: [{name}], secret_rotated_at, auto_disabled_at}`. Never the URL, any part of the secret
  or a header value.
- `list_webhook_destination_settings() returns jsonb`: `[{destination_id, field_count,
  batch_seconds}]` for the caller's webhooks.
- `preview_webhook_request(p_settings jsonb, p_spot_id bigint default null, p_destination_id uuid
  default null) returns json`: the body `webhook_request_body` builds for the defaults merged with
  `p_settings` (after the same checks a save makes), for raw_spots row `p_spot_id` or
  `push_sample_spot()`, with `delivery_id` 0. `connection` is the name of the oldest connection
  that sends to `p_destination_id` when that is the caller's destination and has one, else
  "Example connection". "Spot not found." for an unknown spot.

**Service role**
- `webhook_test_delivery(p_destination_id uuid, p_spot_id bigint default null) returns jsonb`:
  `{webhook: {batch_seconds, headers: [{name, value}]}, spot: delivery_spot_json ||
  {webhook_fields, webhook_connection: "Test"}}`, or null when the destination is not a webhook or
  the spot is unknown. Not a sender RPC.

**Changed objects**
- `duplicate_destination(p_id)`, same signature: the type check goes; a webhook copy gets the
  source's `url`, `url_display`, `signing_secret` and `secret_rotated_at`, its settings, and its
  headers with each value re-created by `vault.create_secret`.
- `api_destination_json(d)`, same signature: a webhook gains `webhook`: its settings minus
  `destination_id`, plus `headers: [{name}]`, `secret_rotated_at` and `auto_disabled_at`.
- `mark_deliveries_failed` and `claim_deliveries`, same signatures and result columns (Delivery
  policy).

## Rendering

`webhook_spot_fields(settings, spot)` walks `settings.fields` in order and returns one
`{key, value}` per field. When a field has no value it is left out with `missing_values = 'omit'`
and sent as `{key, value: null}` with `'null'`. The spot is `delivery_spot_json(r)` (or the sample
spot), so the renderer reads the same keys push and Discord do.

| Field | Label | Snake key | Camel key | Value | JSON type | No value when |
| --- | --- | --- | --- | --- | --- | --- |
| `id` | Spot ID | `id` | `id` | `raw_spots.id` | integer | never |
| `time` | Time | `time` | `time` | `spot_time` (see below) | string or integer | never |
| `callsign` | Callsign | `callsign` | `callsign` | the call as spotted | string | never |
| `frequency` | Frequency | `frequency_khz`, `frequency_mhz`, `frequency_hz` | `frequencyKhz`, `frequencyMhz`, `frequencyHz` | see below | number | never |
| `mode` | Mode | `mode` | `mode` | the stored mode, lower case (`cw`, `ssb`, `ft8`) | string | the spot has no mode |
| `band` | Band | `band` | `band` | `20m`, `2m`, `70cm` | string | outside every band |
| `source` | Source | `source` | `source` | `pota`, `sotawatch`, `wwff`, `dxcluster` or `rbn` | string | never |
| `reference` | Reference | `reference` | `reference` | POTA park (`US-2763`), SOTA summit (`W4C/CM-001`) or WWFF reference (`KFF-5268`) | string | DX Cluster, RBN |
| `place_name` | Place name | `place_name` | `placeName` | POTA park name or WWFF reference name | string | SOTA, DX Cluster, RBN, or no name |
| `state` | State | `state` | `state` | POTA location's part after the dash (`US-NC` is `NC`), several joined by `/` (`NC/VA`) | string | not POTA, or no location |
| `spotter` | Spotter | `spotter` | `spotter` | the spotter's call as sent | string | none given |
| `country` | Country | `country` | `country` | `cty_lookup(callsign).name`, the cty.dat entity name (`United States`) | string | no cty.dat match, or cty.dat not loaded |
| `url` | Spot URL | `url` | `url` | `spot_source_url(spot)`: the pota.app park, the SOTA summit page or the WWFF directory entry | string | DX Cluster, RBN, or a reference not safe in a URL |
| `comment` | Comment (free text) | `comment` | `comment` | the comment as the spotter typed it | string | empty |

`reference`, `place_name` and `state` are `render_push_field`'s values for the same field names, so
push, Discord and webhooks agree. A rendered empty string counts as no value.

**Time.** `iso_utc` is `to_char(spot_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
whole seconds, always `Z` (`"2026-10-17T17:42:09Z"`). `unix_seconds` is
`floor(extract(epoch from spot_time))::bigint` (`1792258929`).

**Frequency.** `raw_spots.frequency_khz` is `numeric(10,3)`. kHz is `trim_scale(frequency_khz)`
(`14062`, `10123.9`); MHz is `trim_scale(round(frequency_khz / 1000, 6))` (`14.062`, `10.1239`),
which is exact; Hz is `(frequency_khz * 1000)::bigint` (`14062000`), also exact. The unit changes
the key (`frequency_khz`, `frequency_mhz`, `frequency_hz`).

**Order.** The pairs are a jsonb array, which keeps order. The sender builds the spot with
`Object.fromEntries(pairs)`; every key is a non-numeric string, so JavaScript keeps insertion order
and `JSON.stringify` writes the keys in the picked order. `webhook_spot_object` and
`webhook_request_body` use `json_object_agg ... order by` and `json_build_object`, so the preview
text has the same order. A pgTAP test pins that the keys of `webhook_spot_object` are the keys of
`webhook_spot_fields`, in order. No pairs is valid: the claim hands `"webhook_fields": []`, the
sender sends `"spot": {}`, and the preview shows the same.

**Comment** is untrusted text typed by the spotter. It goes in as a JSON string (escaped by the
JSON encoder) and is never interpreted.

## Request bodies

One request per spot (`batch_seconds` 0), with the default fields:

```
POST /hook/abc123 HTTP/1.1
Host: logger.example.org
Accept: */*
Content-Type: application/json
User-Agent: LongLines/0.2
X-LongLines-Timestamp: 1792258930
X-LongLines-Signature: sha256=3b1f…e07a
Authorization: Bearer …
```

```json
{
  "delivery_id": 918273,
  "connection": "POTA states I still need",
  "spot": {
    "id": 4421907,
    "time": "2026-10-17T17:42:09Z",
    "callsign": "KK4PWJ",
    "frequency_khz": 14062,
    "mode": "cw",
    "band": "20m",
    "source": "pota",
    "reference": "US-2763",
    "place_name": "Falls Lake SRA",
    "state": "NC",
    "spotter": "W4ABC"
  }
}
```

Grouped (`batch_seconds` 10, 30 or 60), camelCase, MHz, Unix seconds and nulls, with Country and
Spot URL added. Each item is exactly a single body; one request can hold several connections'
spots, up to 50:

```json
{
  "spots": [
    {
      "delivery_id": 918274,
      "connection": "POTA states I still need",
      "spot": {
        "id": 4421910, "time": 1792258950, "callsign": "N4XYZ", "frequencyMhz": 7.0335,
        "mode": "cw", "band": "40m", "source": "pota", "reference": "US-4567",
        "placeName": "Eno River SP", "state": "NC", "spotter": "N4XYZ",
        "country": "United States", "url": "https://pota.app/#/park/US-4567"
      }
    },
    {
      "delivery_id": 918275,
      "connection": "Summits on 2m",
      "spot": {
        "id": 4421913, "time": 1792258961, "callsign": "W4/G4ABC/P", "frequencyMhz": 146.52,
        "mode": "fm", "band": "2m", "source": "sotawatch", "reference": "W4C/CM-001",
        "placeName": null, "state": null, "spotter": "KK4PWJ",
        "country": "United States", "url": "https://summits.sota.org.uk/summit/W4C/CM-001"
      }
    }
  ]
}
```

The signature is unchanged: `sha256=` and the hex HMAC-SHA256 of `"{timestamp}.{raw body}"` with
the signing secret. Headers go out in this order: `Host`, the fixed five (`Accept`,
`Content-Type`, `User-Agent`, `X-LongLines-Timestamp`, `X-LongLines-Signature`), then
`X-LongLines-Test` on a test, then the extra headers in their position order. An extra header can
never replace a fixed one (the denylist). A test request adds `X-LongLines-Test: true`, `"connection": "Test"` and
`"delivery_id": 0`. Deliveries still go out newest first and order is not guaranteed.

The legacy body (`{"deliveries": [...]}`) is sent only for rows claimed without the new keys
(Sender).

## Extra headers

- At most 10 per destination. Names follow `webhook_header_name_valid`; each name once, ignoring
  case. Values are 1 to 1,024 printable ASCII characters (space to `~`), stored as typed. No
  line breaks or other control characters reach a request.
- `set_webhook_headers(p_destination_id, p_headers)` takes the full ordered list as
  `[{"name", "value"?}]`. Null leaves the headers as they are; `[]` removes them all. An item whose
  `value` is missing, null or empty keeps the stored value of the header with that name (ignoring
  case), so the editor sends values only for what was typed; a renamed header needs a value. The
  checks run on the whole list before anything is written. Then rows not in the list are deleted
  (the trigger deletes their Vault secrets), kept rows get their new name, position and, when a
  value was given, a new secret (`vault.create_secret(value, 'longlines_webhook_header_' ||
  gen_random_uuid(), 'Long Lines webhook header')`, the old one deleted by the trigger), and new
  names are inserted with a new secret.
- The claim hands `destination.webhook.headers = [{name, value}]` in position order. The sender
  drops any name `WEBHOOK_RESERVED_HEADERS` refuses or any value outside printable ASCII (defence in
  depth; SQL already refused them) and appends the rest after the fixed five (Request bodies has
  the order). The denylist, not the order, is what keeps an extra header from replacing a fixed one.
- The editor shows a saved value as `••••••••••••` and never receives one.

## Delivery policy

**Batch hold.** `claim_deliveries`' `held` CTE, from the Discord migration, joins both settings
tables: a Discord or webhook destination with `batch_seconds > 0` is held while every ready row is
younger than the window and fewer than `destination_batch_full(type)` are ready. Only ready rows
count, so a row in flight, backed off, throttled or turned off never starts or fills a window, and
a retried row (old `created_at`) goes at once. With 0 nothing is held.

**Per-claim cap.** The `budget` CTE's `claim_max` is `webhook_claim_max(coalesce(ws.batch_seconds,
0))` for a webhook and `destination_claim_max(type)` otherwise (decision 13).

**Retry policies.** Attempt 1 is the first send. `p_attempt` is the attempt that just failed.

| Policy | Label | Wait after attempt 1, 2, 3, ... | Attempts | Dropped |
| --- | --- | --- | --- | --- |
| `none` | Don't retry | none | 1 | at the next claim after the failure |
| `three_10m` | Up to 3 times over 10 minutes | 60 s, 180 s, 360 s (retries about 1, 4 and 10 minutes after the first failure) | 4 | after the fourth failure |
| `day` | Keep trying for 24 hours | 30 s, 60 s, 120 s, 300 s, 900 s, then 1,800 s each time (today's `backoffSeconds`) | no limit | when 24 hours old (`destination_max_age('webhook')`) |

Every policy also drops a row 24 hours after it was created, as today, whatever its attempts (a
throttled or rate-limited row may wait that long without failing).

`mark_deliveries_failed(p_delivery_ids, p_msg_ids, p_error, p_delay_seconds)`, same signature:
1. Each delivery: `status = 'failed'`, `attempts + 1`, `last_error`.
2. Each destination once: `consecutive_failures + 1`, `last_error`, `last_error_at`, health as
   today (`failing` from 5, `paused` kept), and, for a webhook with `pause_after_failures` set
   that is enabled, the pause count of decision 4: when `pause_failure_at` is null or
   `last_success_at > pause_failure_at`, `pause_failures = 1`; else when `pause_failure_at <=
   now() - webhook_pause_spacing()`, `pause_failures + 1`; else unchanged. `pause_failure_at =
   now()` whenever the count moved. When the count reaches `pause_after_failures`, `enabled =
   false` and `auto_disabled_at = now()`.
3. Each message, from `unnest(p_delivery_ids, p_msg_ids)` joined to its delivery, destination and
   webhook settings: vt `0` when `webhook_retries_exhausted(policy, attempts)`, else
   `webhook_retry_delay(policy, attempts)` for a webhook with settings, else `p_delay_seconds`.
4. Each destination in the call with `auto_disabled_at` set and `enabled` false: every queued
   message of it (pending or failed) gets vt `0`, after step 3, so the next claim's unwanted sweep
   drops them all.

`claim_deliveries`' expiry sweep (0b) drops a row when it is past its age (as now) or
`webhook_retries_exhausted(ws.retry_policy, d.attempts)`; `ready` leaves out the same rows.

**Pause.** Decision 4. The unwanted sweep (0a) drops a disabled destination's queue without
`dropped_at` (not a loss: someone turned it off), except while `auto_disabled_at` is set, when it
sets `dropped_at = now()` (the pause lost those spots). Step 4 above makes the whole queue visible
first, so re-enabling does not bring any of them back.
`mark_deliveries_sent` does not change.

## Sender

Files: `_shared/delivery/types.ts`, `format.ts`, `send.ts`, `run.ts`,
`_shared/handlers/test_delivery.ts`. `sender/` code, `SENDER_RPCS` and the env list do not change.

- **types.ts.** `WebhookHeader {name, value}`; `WebhookSettings {batch_seconds, headers}`;
  `DeliveryDestination.webhook?: WebhookSettings`; `WebhookField {key: string; value: string |
  number | null}`; `DeliverySpot.webhook_fields?: WebhookField[]` and `webhook_connection?:
  string`; `PendingDelivery.test?: boolean` (set only by `sendTestTo`); `WebhookItem
  {delivery_id, connection, spot: Record<string, string | number | null>}`; `WebhookBody =
  WebhookItem | {spots: WebhookItem[]} | LegacyWebhookPayload`, where `LegacyWebhookPayload` is
  today's `WebhookPayload` renamed; `WebhookRequest {body: WebhookBody; count: number}`.
- **format.ts.** `webhookItem(d)` builds the item from SQL's pairs in order (`[]` gives
  `"spot": {}`). A row is new-style when `Array.isArray(spot.webhook_fields)`. `webhookRequests(
  destination, deliveries)`: when `destination.webhook` is absent or any row is not new-style, the
  legacy chunks of 50 (`webhookPayloads`, kept for the transition and
  commented as `LEGACY_PUSH_SETTINGS` is); with `batch_seconds` 0, one request per delivery; else
  chunks of `WEBHOOK_SPOTS_PER_REQUEST` (50) as `{spots}`. `webhookSpot` also strips
  `webhook_fields` and `webhook_connection` from a legacy spot. `WEBHOOK_RESERVED_HEADERS`,
  `extraHeaderAllowed(name)` (the name pattern and the denylist) and
  `webhookExtraHeaders(destination)` (also drops a repeated name, ignoring case) mirror SQL's
  rules.
  `sampleSpot` goes: every test spot now comes from SQL. `backoffSeconds` stays for Discord and
  push, with a comment that SQL's schedule wins for webhooks.
- **send.ts.** `sendWebhook` iterates `webhookRequests`, signs each body, builds the headers as
  the fixed five (`Accept`, `Content-Type`, `User-Agent`, `X-LongLines-Timestamp`,
  `X-LongLines-Signature`), then `X-LongLines-Test: true` when the deliveries are a test, then the
  allowed extra headers, and counts `sent += request.count`. `SendResult` gains `status?: number`,
  the last HTTP status received, and `attempted?: number`, the rows up to and including the last
  request made (on a failure, `sent` plus the failed request's count). A failure before any
  request (no URL, an unsafe or unresolvable URL, no signing secret) reports `attempted` as the
  first request's count, as if that request had failed, so `consecutive_failures` and health
  still move and the other rows wait for the claim's `p_vt`. The timeout, redirect
  refusal, address pinning and 429 handling are unchanged, and it still stops at the first failed
  request. The headers go to `pinnedPost` as ordered `[name, value]` pairs
  (`pinned_http.ts` takes pairs or an object), since an object would move an integer-like extra
  header name such as `1` ahead of the fixed five.
- **run.ts.** On a failure that is not a 429, `mark_deliveries_failed` gets only
  `batch.slice(sent, attempted ?? batch.length)`; the rows after `attempted` are counted in a new
  `DestinationResult.unattempted` (not failed) and left for the claim's `p_vt` (decision 14). A 429 still
  throttles `batch.slice(sent)`. Tests: five one-spot requests with a 500 on the first mark one
  row failed and leave four untouched; under `none` only that one is dropped by the next claim's
  sweep (pgTAP covers the SQL half).
- **test_delivery.ts.** For a webhook, `sendTestTo` calls `webhook_test_delivery` and uses its
  `webhook` and `spot` (null is "Destination not found." or "Spot not found.", an error is 500, as
  for Discord), sets `test: true`, and answers `{"ok": true, "status": 204}` or `{"error":
  "Webhook HTTP 500", "status": 500}` with 502. A request that never got a status has no `status`.
  `handlers/api.ts` passes that through for `POST /destinations/{id}/test`.
- **Ship in either order.** The sender deploys when PR 2 merges, before Brad pushes the migration:
  until then the claim has no webhook keys and receivers get the legacy body, without extra
  headers, on today's retry schedule. After the push they get the new body. An old sender against
  the new claim (a failed deploy) sends the legacy body with the two new spot keys in it, which
  receivers ignore. `send-test` and `api` are deployed after the push.

## API

- `GET /destinations` and `GET /destinations/{id}`: a webhook gains `webhook`:

```json
"webhook": {
  "fields": ["id", "time", "callsign", "frequency", "mode", "band", "source", "reference",
             "place_name", "state", "spotter"],
  "key_style": "snake", "time_format": "iso_utc", "frequency_unit": "khz",
  "missing_values": "omit", "batch_seconds": 0, "retry_policy": "three_10m",
  "pause_after_failures": 20,
  "headers": [{"name": "Authorization"}],
  "secret_rotated_at": "2026-10-06T14:02:11Z", "auto_disabled_at": null
}
```

- `PATCH /destinations/{id}` with `"enabled": true` on a paused webhook resumes it (decision 4).
- `POST /destinations/{id}/test`: `{"ok": true, "status": 204}`, or `502` with `{"error",
  "status"?}`.
- `docs/API.md` says the API does not change webhook settings or headers.

## Web

- **Routes.** `DestinationRoute` (`App.tsx`) sends `webhook` to a new `WebhookDestinationPage`.
  `DestinationDialog` keeps only the type step; Continue goes to `/destinations/new?type={type}`
  for every type, and its `onCreated` prop and details step go. `SecretDialog` is replaced by
  `SigningSecretDialog`.
- **Page.** `WebhookDestinationPage.tsx` is the Discord page's skeleton (gatekeeper, Loader,
  Editor): breadcrumb, title, Cancel and save buttons, Name with its helper and the name-taken field
  error, Enabled, the type chip and sentence, the paused alert, then a 7/5 `Grid` with Endpoint,
  Payload and Delivery on the left and the sticky Request preview on the right (stacked on phones,
  preview last).
- **Cards.** `WebhookEndpointCard.tsx` (URL with Replace URL as `DiscordChannelCard`, the signing
  secret block with Rotate, header rows), `WebhookPayloadCard.tsx` (Always sent box, the field
  list, the four selects, Reset to default fields, which resets only `fields` to the defaults, as
  Discord's resets only its field lists), `WebhookDeliveryCard.tsx` (Requests, Retry, the
  pause `SettingSwitch`), `WebhookPreviewCard.tsx` (spot select from `useRecentSpotPicker`, the
  request line and headers, the body from `preview_webhook_request` pretty-printed with two
  spaces and debounced 300 ms, Send test request and its result), `SigningSecretDialog.tsx`
  (created and rotated variants; Copy through `navigator.clipboard.writeText`; Done disabled until
  "I have saved the secret" is checked; no backdrop or Escape close).
- **Rotate.** Rotate calls `rotate_signing_secret` at once, whatever the form holds (it is not
  part of the save). The rotated dialog opens; Done closes it and stays on the editor with the
  form's unsaved state kept, and the secret line reads "Rotated 1 minute ago" (`timeAgo`'s floor)
  from the rotation time the page sets locally, without a reload. Save, Cancel and Rotate block
  each other while either request runs: a save leaves the page, which would lose a rotated secret
  before its dialog opened.
- **Enabled on save.** On a saved destination the editor sends Enabled only when the switch differs
  from what it loaded, else null (keep). `update_destination` reads Enabled on as a resume
  (decision 4), so a pause that lands while the editor is open is never cleared by a save that did
  not touch the switch. A new destination always sends it.
- **FieldPicker.** The generic `FieldPicker` gains two optional props, never a fork: `keyOf(id)`
  (a monospace secondary on each row, the key name) and `addAs: "select" | "chips"` (chips are
  "+ {label}" under the heading Not included). Push and Discord keep the select. With every field
  included, the Not included heading and its chips are hidden; a helper below them (the Comment
  note) stays.
- **Model.** `webhookModel.ts`: `WEBHOOK_FIELDS` (ids and labels), `FIELDS_MIN` 1, `FIELDS_MAX` 14,
  `DEFAULT_WEBHOOK_SETTINGS` pinned to `webhook_default_settings()` by `webhookModel.test.ts`
  reading the migration (as `discordModel.test.ts` does), `webhookKey(field, keyStyle, unit)`
  pinned to the key table above (display only; SQL renders the request), option lists, the form
  shapes (`blankForm`, `formOf`, `toInput`, `dirty`), header row helpers (at most 10; a saved row
  sends no value unless typed; a renamed row needs one), `webhookCardLine(count, batchSeconds)`
  (singular "1 field", as `discordCardLine`),
  `sendTestBlocker` (Discord's, shared or reused), `PAUSE_AFTER` 20.
- **List.** `DestinationCard`: webhooks are editable and duplicable, the Rotate secret button goes,
  the type line comes from `list_webhook_destination_settings` (one call when any webhook exists),
  and `HealthChip` shows Paused when `auto_disabled_at` is set. `cardMeta` and the Delete tooltip as
  decision 17. Send test on a webhook card toasts the status, 2xx or not: send-test's 502 body
  carries the receiver's `status`, which `api.ts` keeps on the `ApiError` (`receiverStatus`). A
  failure without a status (no connection, a refused address) toasts the error.
- **api.ts.** Types `WebhookField`, `WebhookSettings`, `WebhookHeaderInput {name, value?}`,
  `WebhookDestination`, `WebhookDestinationInput`, `WebhookSettingsSummary`; functions
  `saveWebhookDestination` (returns `{id, signingSecret}`), `getWebhookDestination`,
  `listWebhookDestinationSettings`, `previewWebhookRequest(settings, spotId, destinationId)`;
  `sendTest` returns `{status: number | null}`; `Destination` gains `auto_disabled_at`.
- **Sources** (in PR 2, not PR 3, so `/sources/:id` changes with the delivered spot: CLAUDE.md
  says a field added to the delivered spot goes in `COMMON_FIELDS` too, and PR 2's merge builds
  the web on Vercel). `web/src/sources/sources.ts`: `COMMON_FIELDS` becomes the field catalog in
  `webhook_fields()` order with the default snake keys and types, with per-source wording for
  `source`, `reference`, `place_name`, `state` and `url`; each source's `example` is its default
  `spot` object. `SourceDetailPage` copy says keys follow the destination's settings (Copy). It
  needs no RPC. The window between PR 2's merge and Brad's `db push`, when receivers still get
  the legacy body, is minutes and accepted.

## PR order

1. **This spec and the plan** (branch `webhook-spec`), plus one line in the outbound sender spec's
   section 9A. Brad reviews before any code.
2. **Schema and sender** (branch `webhook-schema`, stacked on `webhook-spec`): the migration,
   pgTAP, `types.ts`, `format.ts`, `send.ts`, `test_delivery.ts`, their tests, regenerated
   `database.types.ts`, `run.ts`, the Source catalog's `sources.ts` and `SourceDetailPage` with
   their tests, `docs/WEBHOOKS.md` rewritten, `docs/API.md`, `docs/ARCHITECTURE.md`'s Delivery
   section, and CLAUDE.md: the Delivery rules (schedule, knobs, pause, attempts), the Subscription
   rules' "the webhook body's `connection`" (was `connection_id`) and the Source catalog rules'
   wording. **Merging deploys the sender.** Brad then runs `supabase db push` and deploys
   `send-test` and `api`, in that order, and tells webhook users about the body change.
3. **Web** (branch `webhook-ui`, stacked on `webhook-schema`), once PR 2's migration is on hosted.
   It carries one small migration that makes `webhook_default_settings()`'s pause 20 (decision
   10), so the pause default and the editor that shows and undoes a pause ship together; Brad
   runs `supabase db push` for it when PR 3 merges.
   It amends the push and Discord specs' card meta Copy (decision 17) and ends with a CLAUDE.md "Webhook rules" section and this spec marked shipped.

## Verification

- Schema and sender: `deno task fmt`, `lint`, `check`, `coverage`; `supabase db reset` and
  `supabase test db` (a new `webhook_destinations.test.sql`, hold, cap and retry cases in
  `deliveries_rpc.test.sql`, the attempts predicate in `claim_expiry.test.sql`, the advisor list,
  `destinations.test.sql`'s masked display, `management_api.test.sql`'s `webhook` object, and the
  existing suites that use a webhook as the generic destination, re-pinned (plan, Task 4));
  `scripts/smoke-test.sql` with a webhook block (the settings trigger exists; the default pairs
  render in order); `supabase db lint`; the sender's `db.test.ts` against the local stack.
- By hand, locally: a receiver on `Deno.serve`, the destination's URL pointed at it with `psql`
  (SQL refuses http and loopback by design) and `npm run sender` with
  `LONGLINES_ALLOW_INSECURE_DESTINATIONS=1`. Check: one request per spot in the picked key order
  with a valid signature and both extra headers; grouped every 10 s gives one `{spots}` request;
  `none` sends once then the row is dropped with `dropped_at`, and with five spots queued and a
  500, only the first is marked failed; with `pause_after_failures` set low by `psql` (3) and the
  receiver failing, the destination turns off after three failures 30 s apart (not three cycles),
  with `auto_disabled_at`, its queued rows dropped with `dropped_at`, and the card says Paused;
  Enabled on and save resumes it; Send test shows the receiver's status; the preview text equals the received body for the same spot and
  settings, byte for byte after pretty-printing both.
- Web: `npm run test:all`, `build`, `lint`; then in `dev:full`, add a webhook through the new page,
  copy the secret, check the card's type line, replace the URL, add and remove headers, reorder
  fields, group, duplicate, and compare phone width with `WebhookEdit-Mobile`.
- After the hosted push: Brad's Vault probe (plan, Brad's steps), then a Send test to a real
  receiver.

## Out of scope

- Email on pause (decision 3) and the sender spec's Phase 2 C health model (`failing_since`, a
  `disabled` state).
- Grid square, Latitude, Longitude and Spotter grid (decision 6).
- Changing webhook settings or headers through the management API (decision 21).
- A pause threshold other than 20 in the editor; the column takes 1 to 100 for later.
- Templates (the canvas nav's Templates item, page 6).
- Moving Discord's and push's retry schedule into SQL; LISTEN in the sender; per-request progress
  for the watchdog (a finished destination is progress, decision 13); a per-destination time
  budget inside a cycle (the head-of-line cost of decision 13).

## Copy

Use these word for word. "KK4PWJ" becomes the signed-in callsign; `{…}` marks a value. Lines marked
*(amended)* differ from the canvas and *(added)* are not on it; the rest are the canvas's. Anything
not listed comes from the Discord spec's Copy.

**Destinations page**
- Header: Destinations · Where matching spots are sent. · button Add destination
- Webhook card: {name} · health chip (Healthy · Failing · Paused *(added: while
  `auto_disabled_at` is set)*) · type line Webhook · 1 field | Webhook · {N} fields, and with a
  window Webhook · 1 field · grouped every {10|30|60} seconds | Webhook · {N} fields · grouped
  every {10|30|60} seconds · the masked URL in a code block
- Meta (every type): Used by {N} connection | Used by {N} connections | Not used by any connection,
  then · Last delivery {ago} | · Last delivery failed {ago} | · Never used *(amended: capitalized
  for every type; ages as "14 minutes ago")*
- Actions: Send test · Edit · Duplicate · Delete. Delete tooltip: Used by {N} connection. Remove it
  from them first. | Used by {N} connections. Remove it from them first.
- Toasts: Added {name} · Saved changes · Duplicated {name} · {name} answered HTTP {status}.
  *(added, a webhook's Send test, whatever the status; a failure with no status toasts the error)*

**Webhook destination editor**
- Breadcrumb: Destinations › New destination | {name}
- Titles: New destination · Edit destination; buttons: Cancel · Add destination | Save destination
  (phones: Save)
- Name helper: Names are unique. A name can be reused after the destination that has it is deleted.
- Switch: Enabled
- Type chip: Webhook · Sentence: Filtering and repeat limits are set on each connection. This page
  controls where spots are sent and what the request contains.
- Paused alert *(added)*: Paused {ago} after repeated failed requests. Spots waiting to be sent
  were dropped. Turn Enabled on and save to resume. ({ago} from `auto_disabled_at`; shown whatever
  the pause switch says.)
- Endpoint card: Endpoint · Requests are sent as POST with a JSON body.
  - New or replacing: field Webhook URL · helper Must start with https://
  - Edit: the masked URL · button Replace URL · The URL is hidden after saving. *(amended: the
    canvas shows the URL in the field)*
  - Replacing: text button Keep current URL beside the field
  - Signing secret: label Signing secret · `whsec_••••••••` *(amended: no last four)* · button
    Rotate · We sign each request with this secret so you can check it came from Long Lines. It is
    only shown once, when created or rotated. Rotated {ago}.
  - New destination, in place of the masked secret and Rotate *(added)*: A signing secret is
    created when you add the destination.
  - Extra headers: heading Extra headers · fields Header · Value (a saved value shows
    `••••••••••••`) · icon button Remove header · button Add a header · Sent with every request, for
    example an API key. Stored encrypted and never shown again after saving.
- Payload card: Payload · Choose which fields are in each request and in what order. Key names are
  fixed, and you cannot add custom fields or text.
  - Box: Always sent · `delivery_id` identifies the delivery, so you can spot a retry. `connection`
    names the connection that matched. Spot fields go inside `spot`.
  - List: Included, in this order · rows numbered 1, 2, 3… with the label and the key in monospace ·
    row buttons Move {field} up · Move {field} down · Remove {field}
  - Field labels: Spot ID · Time · Callsign · Frequency · Mode · Band · Source · Reference · Place
    name · State · Spotter · Country · Spot URL · Comment (free text)
  - Not included: chips + {field} *(amended: Grid square, Latitude, Longitude and Spotter grid are
    not offered)*; chip aria-label Add {field} *(added)*; hidden, heading included, when every
    field is included *(added)*
  - Note: Comment is text typed by the person who spotted, so treat it as untrusted. It is sent as
    a quoted JSON string, never as markup.
  - Key style (snake_case · camelCase) · Keys such as place_name or placeName.
  - Time format (ISO 8601, UTC · Unix seconds) · helper 2026-10-17T17:42:09Z | 1792258929
    *(amended: the example follows the choice; Unix seconds added)*
  - Frequency unit (kHz · MHz · Hz) · Changes the key name too.
  - When a spot has no value (Leave the key out · Send null) · Or send null. | Or leave the key
    out. *(amended: the helper names the other choice)*
  - Button: Reset to default fields (the field list only; the selects keep their choices)
- Delivery card: Delivery · How requests are sent and what happens when they fail
  - Requests (One request per spot · Group spots every 10 seconds · Group spots every 30 seconds ·
    Group spots every 60 seconds) *(the canvas draws the first)* · Or group spots into one request
    every 10, 30 or 60 seconds. Grouped requests send a spots list instead of a single spot. (one
    request per spot) | Or send one request per spot. Grouped requests send a spots list instead of
    a single spot. (grouped) *(amended: the helper names the other choice)*
  - Retry a failed request (Don't retry · Up to 3 times over 10 minutes · Keep trying for 24 hours)
    *(the canvas draws the second)* · A request fails on a timeout after 10 seconds or any status
    other than 2xx.
  - Switch: Pause this destination after repeated failures · After 20 failed requests in a row,
    deliveries stop. Turn it back on here. *(amended: "and you get an email" dropped)* ·
    aria-label Pause after repeated failures
- Request preview card: Request preview · Preview with this spot (Sample spot, then recent spots,
  each as KK4PWJ, POTA US-2763, 14.062 CW)
  - Code block: POST {path} · Accept: */* · Content-Type: application/json · User-Agent:
    LongLines/0.2 · X-LongLines-Timestamp: {Unix seconds now} · X-LongLines-Signature: sha256=… ·
    {header}: •••••••• per extra header · then the body *(amended: the real headers in the order
    sent, decision 19)*
  - Button: Send test request · caption: Sends this example to your URL and shows the response
    code. The test is marked as a test and is not counted as a delivery. | Add a webhook URL to
    send a test. | Save your changes to send a test.
  - Result *(added)*: Your URL answered HTTP {status}. (success) | the error, such as Webhook HTTP
    500 (failure)

**Signing secret dialog**
- Created: title Destination added · {name} will receive a request for each matching spot, with the
  fields you chose. | {name} will receive a request every {10|30|60} seconds with the matching
  spots, with the fields you chose. *(added: the grouped variant)*
- Rotated *(added)*: title Signing secret rotated · {name} signs requests with this new secret from
  now on. The old one no longer works.
- Both: warning alert Copy your signing secret now · It is shown once. We use it to sign each
  request so you can check it came from Long Lines. If you lose it, rotate it from this
  destination. · the secret in a code block · button Copy (Copied once copied *(added)*) · checkbox
  I have saved the secret · button Done (disabled until checked)

**Source detail page** *(added)*
- Schema card note: Keys and units shown are the defaults. Each webhook destination picks its
  fields, key style, time format and frequency unit.

**Errors**
- Use an https URL. · That address is not allowed. (exist) · A destination named {name} already
  exists. Choose a different name. (exists)
- Give the destination a name. · Destination not found. · Spot not found. (exist)
- Settings must be an object. · Unknown setting {key}. · Unknown field {name}. · Pick at least one
  field. · Pick each field once.
- Pick a key style. · Pick a time format. · Pick a frequency unit. · Pick what to send when a spot
  has no value. · Pick a batch window. · Pick a retry policy. · Pause after 1 to 100 failures, or
  never. (The editor's selects and switches cannot produce these; a malformed request can.)
- Headers must be a list. · Up to 10 headers. · Give each header a name. · Header names use
  letters, digits, - _ and . only. · {name} is set by Long Lines. · Add each header once. · Give
  the {name} header a value. · Header values can be up to 1,024 characters. · Header values can only
  use printable ASCII characters.
- Couldn't send the test. (fallback toast)
