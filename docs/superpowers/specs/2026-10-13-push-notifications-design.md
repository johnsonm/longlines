# Push notifications and an installable app: design

Date: 2026-10-13. Status: **Decisions approved by Brad (2026-10-13). This spec, and especially its
Copy section, is waiting for his review.** No code ships until he approves it. Items marked
*proposed* fill gaps the planning session didn't cover. Each needs an explicit yes. If the design
changes during a PR, update this file in that PR.

## Amendment, 2026-10-15: page 5

Status: **shipped** (decisions 1 to 15 accepted by Brad, 2026-10-16; 16 is withdrawn by the sender
amendment). The schema and the sender side landed in #211; the web side (Parts 3 to 5 of the plan)
is PR #212.
PR 1 (#157, merged 2026-10-14) shipped the model the rest of
this file describes. Page 5 of Brad's design canvas ("Push notification destination (draft)",
artboards `PushList-Desktop`, `PushType-Desktop`, `PushNew-Desktop`, `PushDevice-Desktop`,
`PushEdit-Desktop`, `PushEdit-Mobile`, `PushDevice-iOS-Mobile`) draws a different one, and this
amendment records it. Where this section and the rest of the file disagree, this section wins. The
implementation plan is `docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md`.

Brad gave no answers in Part 0, so every decision below was the plan's proposal; he accepted them
all on 2026-10-16, before Part 2 started, and each is marked *decided*.

### The model change

**Many push destinations per account, each with its own devices, notification text and delivery
settings** (decision 1) replaces "one push destination per account, fanning out to every device".
Devices still belong to the account (`push_devices`). Each push destination picks some of them, so
a user can have "POTA on my phone", "SOTA on my phone" and "Desktop alerts" side by side.
Notification text is **not a template** (Brad, 2026-10-15): the user picks which spot fields appear
in the title and the body and in what order, and SQL joins their fixed renderings. There is no free
text, so nothing to parse and nothing a user can inject. The worker and the editor's preview call
the same SQL; the worker keeps only the per-run "3 spots then a summary" shaping.

### Schema (migration `20261016000400_push_destinations_v2.sql`; see the 2026-10-16 amendment for what the sender changes)

`20261014000100` is applied to hosted and stays as is; the new migration builds on it.

- **Destinations.** The one-push-per-account index (`destinations_one_push_per_user`) goes, and with
  it "You already have push notifications.". `destinations` gains `enabled boolean not null default
  true`; `match_pending_spots` skips disabled destinations of every type, and `update_destination`
  gains `p_enabled`. Names become unique per account across all types, case-insensitive
  (`destinations_user_name_key` on `(user_id, lower(name))`). Before the index is built, the
  migration renames hosted duplicates: the oldest keeps its name, the rest become "{name} (2)",
  "{name} (3)" and so on. `create_destination` and `update_destination` turn the `unique_violation`
  into the name-taken error in Copy.
- **Devices.** `push_devices.label` becomes the user's name for the device. New columns: `agent`
  (the "{Browser} on {Platform}" descriptor, backfilled from `label`), `standalone` (opened from the
  Home Screen or as an installed app) and `blocked_at`. `register_push_device(p_endpoint, p_p256dh,
  p_auth, p_label, p_agent, p_standalone)` upserts as before, clears `blocked_at` and returns the
  device id. It **never creates a destination**; the old five-argument overload is dropped. New
  client RPCs: `rename_push_device(p_id, p_label)` (trimmed, 60 characters, blank becomes "This
  browser") and `report_push_device_blocked(p_endpoint)` (stamps `blocked_at` on the caller's
  device, silent otherwise). `list_push_devices(p_current_endpoint)` returns `id, label, agent,
  standalone, created_at, last_success_at, last_error, last_error_at, blocked_at, is_current` and
  the `destination_ids` each device belongs to. The 20-device cap stays.
- **Membership.** `push_destination_devices (destination_id, device_id)`, both cascading, RLS on with
  no policies and client grants revoked. The migration enrols every existing device in its owner's
  existing push destination, so nothing that works today stops working.
- **Settings.** `push_destination_settings`, one row per push destination, same RLS pattern:
  `title_fields` and `body_fields` (ordered lists of field names), `show_field_names`,
  `body_separator` (`dot`, `comma`, `newline`), tap target (`profile` or `source`), action buttons, urgency (`low`, `normal`,
  `high`), drop-if-offline seconds (300, 900, 1800, 3600, 14400), replace same station, sound, quiet
  hours on/off, from, until, and quiet mode (`silent` or `skip`). `push_default_settings()` holds
  the defaults (decisions 4 and 7). A trigger on `destinations` inserts them for every new push row,
  and the migration backfills existing ones. A check constraint and `save_push_destination` require
  every name to be in `push_fields()`, no name twice in a list, 1 to 4 title fields and 0 to 8 body
  fields; otherwise "Unknown field {name}.", "Pick 1 to 4 fields for the title." or "Pick up to 8
  fields for the body.".
- **Rendering, in SQL only.** `render_push_field(field, spot)` gives one field its fixed rendering
  (decision 4), null when the spot lacks it; `render_push_fields(fields, spot, separator, labels)`
  renders a list in order, skips nulls, prefixes the display name when `labels` is true and joins
  (" · " for the title; the destination's `body_separator` for the body). `spot_source_url(spot)` returns the POTA
  park page or the SOTA summit page, otherwise null. `push_quiet_now(settings, timezone, at)` handles
  ranges that cross midnight, in the account time zone (`profiles.timezone`).
- **`claim_deliveries`.** For push, `devices` are the destination's members with `blocked_at is
  null`, aggregated once per destination (this also fixes #159 for push). The destination jsonb
  gains `push` (the settings row). The spot jsonb gains `push_title`, `push_body`, `push_url` (from
  the tap target), `push_source_url` and `quiet_now`. Webhook payloads strip these keys, so
  `docs/WEBHOOKS.md` doesn't change.
- **Client RPCs** (security definer, pinned `search_path`, granted to `authenticated`, listed in
  `advisor.test.sql`, "Not signed in." without `auth.uid()`):
  `save_push_destination(p_id, p_name, p_enabled, p_settings, p_device_ids)` creates when `p_id` is
  null, validates the settings, rejects devices that aren't the caller's with "Device not found."
  and replaces membership. `get_push_destination(p_id)` returns settings and `device_ids`.
  `duplicate_destination(p_id)` (decision 9). `preview_push_notification(p_title_fields,
  p_body_fields, p_show_field_names, p_body_separator, p_spot_id)` renders against a `raw_spots`
  row, or `push_sample_spot()` when null, through the same `push_spot_fields` that
  `claim_deliveries` calls, after the same field checks. None of them returns an endpoint or a key.
  Send test cannot use it (the Edge Function runs as the service role, with no `auth.uid()`), so it
  reads `push_test_delivery(p_destination_id, p_spot_id)`, service-role only, which returns the
  settings, the unblocked members and the spot rendered through the same function.
- **Worker.** `send.ts` takes `Urgency` and `TTL` from the destination's settings (today's values
  when absent). `deliver.ts` drops a push delivery older than that destination's TTL instead of the
  fixed 15 minutes. `format.ts` passes the SQL-rendered text through and only builds tags, actions,
  `silent`/`renotify` and the summary; it never joins spot fields itself. A spot in quiet hours with
  "Don't send" is marked sent without a request: never retried, never a failure.
- **Send test.** Devices come from the destination's members, not the owner's. `send-test` takes
  an optional `spot_id` and renders through `preview_push_notification`, so the test shows the
  saved fields.
- **Management API.** `api_destination_json` gains `enabled` and, for push, `push` (the settings
  and a `device_count`, never devices). `PATCH` accepts `enabled`. `POST /destinations` with
  `"type": "push"` always works. Devices stay browser-only.

### Decisions

1. **Many push destinations per account, devices picked per destination**, as above. *Decided 2026-10-16.*
2. **Enabled switch.** A real `destinations.enabled` that `match_pending_spots` honours for every
   type, rather than reusing `health = 'paused'`, which is a delivery-side state. Discord and
   webhook cards don't show the switch (page 1), but the API exposes `enabled` for all. *Decided 2026-10-16.*
3. **Unique names** per account across every destination type, case-insensitive, with hosted
   duplicates renamed as above. *Decided 2026-10-16.*
4. **Fields, not templates** (Brad, 2026-10-15; canvas updated 2026-10-16, decided). The title
   and the body are each an ordered list of fields from `callsign`, `frequency`, `band`, `mode`,
   `source`, `reference`, `place_name`, `state`, `spotter`, `comment` and `time`. No custom text
   anywhere: a template engine would have to accept arbitrary text, and a user could put anything
   into a notification. Each field has one fixed rendering and one display name: Callsign (as is),
   Frequency ("14.062 MHz", three decimals), Band ("20m"), Mode (upper case), Source (the source
   label), Reference (the POTA, SOTA or WWFF reference), Place name (the park, summit or WWFF
   reference name), State (the part after the dash of `pota_location`, "US-NC" becomes "NC"),
   Spotter (the call), Comment (as is), Time (the UTC clock). Two more settings shape the text:
   **Show field names** (off by default) puts the display name before each value, "State: NC";
   **Separate body fields with** picks the body's joiner: A dot (" · ", default), A comma (", ")
   or A new line. The title is always joined with " · ". A field the spot lacks is skipped.
   Defaults: title Callsign, Frequency, Mode; body Source, Reference, Place name, State, rendering
   "KK4PWJ · 14.062 MHz · CW" / "POTA · US-2763 · Falls Lake SRA · NC", as the canvas previews
   show. Limits: title 1 to 4 fields, body 0 to 8, no field twice in a list. *The separator
   options beyond the dot and labels on the title as well as the body: decided 2026-10-16.*
5. **When tapped, open.** Callsign profile (`/call/<base>`, the default) or Source site
   (`spot_source_url`; RBN and DX Cluster spots fall back to the profile). URLs are built in SQL.
   *Decided 2026-10-16.*
6. **Action buttons.** "Open profile" and "Open on {Source}", the latter only when the source URL
   differs from the profile, through the notification `actions` API. iOS ignores them, as the
   preview caption says. *Decided 2026-10-16.*
7. **Delivery values.** Urgency Low / Normal / High, default Normal (today's worker sends High).
   Drop if offline for 5 min / 15 min / 30 min / 1 hour / 4 hours, default 30 minutes (today 15).
   Replace the earlier notification for the same station: default on (tag per station; off gives
   each spot its own tag). Sound and vibration: default on (`silent: false`). Quiet hours: default
   off, 22:00 to 07:00; during them, **Send silently** (default) or **Don't send** (marked sent
   without a push). Quiet hours use the account time zone and are evaluated in SQL when the delivery
   is claimed. *Decided 2026-10-16.*
8. **Blocked devices.** A browser that finds `Notification.permission === "denied"` on load reports
   its last endpoint through `report_push_device_blocked`. Blocked devices are skipped at claim time
   and shown as page 5 draws them. The browser keeps its last endpoint in `localStorage` (a
   per-viewer convenience), since a denied browser can no longer read its subscription.
   Re-registering clears `blocked_at`. *Decided 2026-10-16.*
9. **Duplicate.** `duplicate_destination(p_id)`, push destinations only (page 5 shows it only
   there): same settings and devices, named "Copy of {name}", `enabled` false so a copy never
   double-sends until it's edited. It returns the new id and the web opens the editor. *Decided 2026-10-16.*
10. **Send test from the editor** uses the destination's *saved* settings and devices and the chosen
    preview spot. While the form has unsaved changes the button is disabled with "Save your changes
    to send a test."; on a new destination, "Add a device to send a test.". *Decided 2026-10-16.*
11. **Device name.** The Add a device dialog prefills "{Browser} on {Platform}" and the user can
    change it. The descriptor is stored separately in `agent` and shown under the name, with ",
    installed app" for standalone browsers. *Decided 2026-10-16.*
12. **Install app** stays in the account menu, between Account and Sign out (the tour it sat next
    to is gone). *Decided 2026-10-16.*
13. **`pushsubscriptionchange`.** The service worker can't reach the supabase-js session and must
    never hold a token, so it re-subscribes and posts `{type: "push-subscription-changed"}` to open
    windows, which re-register. The next app load covers the no-window case, and the old endpoint
    is pruned on its first 410. This replaces PR 2's "call `register_push_device` through a plain
    `fetch` with the stored session". *Decided 2026-10-16.*
14. **Icons.** No SVG rasteriser is installed: a throwaway resvg script in the session scratchpad
    renders them, the PNGs are committed, and nothing is added to the build. *Decided 2026-10-16.*
15. **Manifest colours.** `theme_color` is the stock MUI light primary `#1976d2`, `background_color`
    `#ffffff`; the `index.html` `theme-color` metas keep light and dark variants. *Decided 2026-10-16.*
16. **Per-run shaping stays.** Page 5 doesn't show it, so the worker keeps "at most 3 notifications
    per device per run, then one summary". The summary keeps the fixed text in Copy below and uses
    the destination's tap target. *Withdrawn by the 2026-10-16 amendment (S1): no summary.*

### What this supersedes

- **PR 3: push UI** below is superseded by this amendment and the plan's Parts 3 to 5: a
  Destinations card grid, an Add destination type picker, a full-page push destination editor and
  an Add a device dialog replace the dialog's Turn on notifications button and the This device line.
- **Open question 3** (`renotify: true`) is closed: `renotify` follows the Sound and vibration
  switch (`renotify = !silent`).
- **Open question 6** (Add without this device) is closed: the editor saves a destination with zero
  devices and shows "No devices yet".
- In **Copy** below, the page 5 strings that follow win wherever page 5 shows a screen. The fixed
  spot title and body under Notifications are replaced by the default field picks (decision 4); the summary text, the
  install strings page 5 doesn't show and the error strings stay. "You already have push
  notifications." goes.

### Copy (page 5)

Use these word for word. Substitutions applied everywhere: **"connection(s)" becomes
"subscription(s)"** (CLAUDE.md: until Connections ship); **"KK4PWJ"** becomes the signed-in
callsign; **"America/New_York"** becomes `profile.timezone`. `{…}` marks a value. Anything not
listed here comes from Copy at the end of this file.

**Destinations page (page 1 + page 5)**
- Subtitle: Where matching spots are sent.
- Button: Add destination
- Failing alert: {name} is failing · The last {N} deliveries returned {error}. Spots for {M} subscription(s) are not being sent. Check the URL, then send a test. · Action: Send test
- Blocked alert: {device} cannot receive notifications · Notifications are blocked for longlines.io in {agent} on that device. Allow them in the browser site settings, or remove the device from {destination}. · Action: Manage devices
- Card type lines: Discord channel · Webhook · Push notification
- Card meta: used by {N} subscription(s) · Last delivery {age} ago | not used by any subscription · Never used | Last delivery failed {age} ago
  *(Amended 2026-10-18: the meta line and the Delete tooltip follow decision 17 of
  `2026-10-18-webhook-destination-design.md` for every type: "Used by {N} connection(s)" / "Not
  used by any connection", capitalized, with a singular tooltip.)*
- Push card chip when blocked: {N} device(s) blocked; device chip: {label} (blocked)
- Actions: Send test · Edit · Duplicate · Delete; Delete tooltip: Used by {N} subscriptions. Remove it from them first.
- Toasts: Added {name} · Saved changes · Duplicated {name} · Deleted {name} · Test spot sent to {name}

**Add destination dialog**
- Title: Add destination
- Intro: Pick where matching spots should go. You can add as many of each type as you like, for example one push destination per source or per device.
- Discord channel: Post each spot to a channel through a webhook.
- Webhook: Send each spot as JSON to your own URL.
- Push notification: Notify your phone or computer. Works in the browser, no app to install.
- Buttons: Cancel · Continue (step 2 for webhooks only: Add destination, as today; Discord opens its editor instead, see `2026-10-18-discord-destination-design.md`)

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

**Errors (new)**
- A destination named {name} already exists. Choose a different name.
- Unknown field {name}.
- Pick 1 to 4 fields for the title.
- Pick up to 8 fields for the body.

## Amendment, 2026-10-16: the sender

Status: **shipped in #211** (accepted by Brad, 2026-10-16; the plan's S1 to S6). Outbound delivery moved off the `deliver` Edge Function onto
the sender, a Deno process on Fly.io (`sender/`, `docs/superpowers/specs/2026-10-15-outbound-sender-design.md`,
Phase 1 complete 2026-10-16). The page 5 amendment above was written against the Edge worker; this
section says what changes. Where it and the page 5 amendment disagree, this section wins.

- **The sender is dumb; the push settings travel in the claim.** `claim_deliveries(p_limit, p_vt)`
  keeps its signature and result columns. For a push destination its `destination` jsonb gains
  `push` (the settings row) and `quiet_now` (decided once per destination at claim time, in the
  account time zone), and its `devices` are the destination's members with `blocked_at is null`,
  aggregated once per destination. Its `spot` jsonb gains `push_title`, `push_body` (built by
  `render_push_fields`), `push_url` (the tap target) and `push_source_url`. `send.ts` reads
  `Urgency` and `TTL` from `destination.push` and falls back to today's values when the key is
  absent, so the sender and the migration can ship in either order. The sender's RPC allowlist,
  its grants (`sender_role.test.sql`) and its `--allow-env` list do not change.
- **No summary notification.** The sender spec decided the push budget: 3 spots a minute per push
  destination, newest first, in `destination_budget('push')`, with no "N more spots" summary.
  `pushNotifications` builds one notification per claimed spot and nothing else;
  `PUSH_NOTIFICATIONS_PER_RUN` and the summary branch go. Decision 16 of the page 5 amendment is
  withdrawn. A device that belongs to several push destinations can receive up to 3 a minute from
  each; that is the user's choice when they add it to several.
- **Drop if the device is offline for** is a per-destination override of the expiry sweep. The
  sweep in `claim_deliveries` uses `coalesce(push_destination_settings.ttl_seconds, destination_max_age(type))`
  for push rows, and `send.ts` sends the same number as the `TTL` header. Per-destination overrides
  are columns the claim reads, never arguments (sender spec, section 10).
- **Quiet hours, "Don't send".** `quiet_now` is per destination, so a claimed batch is uniformly
  silent or skipped. For `skip`, `sendPush` makes no request and returns `sent` equal to the batch,
  which `runDeliveryBatch` acks with the cycle's one `mark_deliveries_sent`; nothing is retried or
  counted as a failure. For `silent`, the payload carries `silent: true` and `renotify: false`.
- **Enabled.** A disabled destination is skipped by `match_pending_spots` (no delivery is created)
  and its already-queued rows are dropped by the claim's "unwanted" sweep (`20261016000100`),
  the way a disabled subscription's are. Both in SQL.
- **Send test stays an Edge Function** (`send-test`, reached by the web app and by
  `POST /v1/destinations/{id}/test`) with the VAPID triple in Edge env, until Phase 2 F of the
  sender spec routes test sends through the sender. It reads the destination's members and renders
  through `preview_push_notification`, so a test shows the saved fields.
- **Migration number.** The page 5 amendment's `20261015000200` was taken by the sender role
  migration. The push migration is `20261016000400_push_destinations_v2.sql` (recheck before
  creating it). The unmerged branch `push-schema-2` carries a draft built on the Edge worker and
  on templates; the plan says what to quarry from it.
- **VAPID.** The same pair goes to the sender's Fly secrets (real deliveries) and to Edge env
  (`send-test`, `api`), and its public key to Vercel. No pair has been generated yet.

## Purpose

Today matched spots go out through only two destination types, `discord` and `webhook`. This adds a
third, **push notifications**. The web app becomes an installable PWA. An alert reaches every browser
or device where the user is signed in and has turned notifications on. That covers Android, desktop
Chrome, Edge, Firefox and Safari, and iOS/iPadOS 16.4+ once Long Lines is added to the Home Screen.

## Decisions

| Topic | Decided |
|---|---|
| Shape | *Superseded by the 2026-10-15 amendment: many per account, devices picked per destination.* **One push destination per account.** It fans out to every registered device. Subscriptions pick it like any other destination, and devices come and go underneath it. |
| Volume | **A few alerts, then a summary.** A run sends each device at most 3 notifications, one per spot. A notification is tagged by callsign, so a re-spot replaces the older one. When more spots match in that run, one "N more spots" notification covers the rest. |
| PWA scope | **Install and push only.** The service worker handles `push`, `notificationclick` and `pushsubscriptionchange`. It caches nothing, so a deploy can never strand anyone on a stale bundle. |
| Copy | The Copy section below is the copy source for these screens. `docs/ui-mock.html` is a bundled build, as it was for callsign lookup and groups. |
| Library | No web-push dependency. `webpush.ts` is WebCrypto only, and the RFC 8291 test vector pins it. |
| SSRF | The worker POSTs to a URL that a client chose. Endpoints must be https on a known push-service host, and both SQL and TypeScript check the allowlist. |
| Freshness | `TTL: 900`, so a push service drops a spot it couldn't deliver within 15 minutes. |

## PR order

0. **Spec PR** (branch `push-spec`): this file plus the "Push rules" section in CLAUDE.md. Brad
   reviews it before any code.
1. **PR 1, schema and delivery** (Deno and SQL). It can ship with no UI, and nobody can register a
   device yet.
2. **PR 2, PWA shell** (web): manifest, icons, service worker and Vercel headers. The app becomes
   installable but has no push UI yet. It can run alongside PR 1.
3. **PR 3, push UI** (web). It needs PRs 1 and 2.

Run each PR in its own chat and worktree. Don't run pgTAP in two chats at once, because the local
stack is shared. Nothing is pushed, merged or deployed unless Brad asks. A merge to main applies
migrations on hosted through the GitHub integration. The integration skips new Edge Functions, but
this adds none: `deliver` and `send-test` already exist.

## PR 1: schema and delivery

### Migration `20261014000100_push_destinations.sql`

Recheck the number across every worktree and remote branch first. It was planned as
`20261013000400`, then renumbered on 2026-10-14 after `20261014000010`–`000020` (APRS, API
fixes) merged to main ahead of it; an unmerged branch already uses `20261014000030`.

- **Destinations.**
  - The `destinations.type` check gains `'push'`.
  - `url` becomes nullable, with `check ((type = 'push') = (url is null))`.
  - A partial unique index `on destinations (user_id) where type = 'push'` allows one per account.
- **Helpers.**
  - `validate_destination_url('push', null)` passes, and `push` with any URL raises "Push
    notifications don't use a URL.".
  - `destination_url_display('push', null)` returns "Your devices".
- **`create_destination('push', name, null)`.** It inserts no URL and mints no signing secret. If
  the account already has a push destination, it catches the `unique_violation` and raises "You
  already have push notifications.".
- **Table `push_devices`.**
  - Columns: `id uuid pk`, `user_id uuid not null → auth.users on delete cascade`,
    `endpoint text not null unique`, `p256dh text not null`, `auth text not null`,
    `label text not null`, `created_at`, `last_success_at`, `last_error`, `last_error_at`.
  - RLS on, no policies, `anon` and `authenticated` revoked. This is the same pattern as
    `deliveries` and `sign_in_attempts`.
  - Endpoints are capability URLs, so no client read ever returns one.
- **Endpoint allowlist.** `validate_push_endpoint(text)` raises "Use a browser push service." unless
  the URL parses as https (`parse_https_url`) and its host is one of:
  - `fcm.googleapis.com`
  - `updates.push.services.mozilla.com`
  - a subdomain of `push.apple.com`
  - a subdomain of `notify.windows.com`

  A suffix test needs the dot: `evilpush.apple.com` must fail. An explicit port or credentials in
  the URL fail too. The same list is repeated in `_shared/delivery/urlsafety.ts`, and the worker
  checks it again before every POST.
- **Client RPCs.** Each is `security definer` with a pinned `search_path`, `revoke all from public`,
  granted to `authenticated` and added to `advisor.test.sql`. Each raises "Not signed in." when
  `auth.uid()` is null.
  - `register_push_device(p_endpoint, p_p256dh, p_auth, p_label, p_name text default null)`:
    - It upserts by endpoint. A device that moves between accounts is reassigned to the caller, and
      its error fields are cleared. On a move, `created_at` restarts and `last_success_at` is
      cleared too, so the new owner doesn't see the old owner's history.
    - If the account has no push destination, it creates one named `p_name`, or "Push
      notifications" when that's blank, so turning notifications on takes one step.
    - It returns the destination id.
    - The label is trimmed and capped at 60 characters; a blank one becomes "This browser". The
      keys must be base64url (helper `base64url_bytes`): `p256dh` is a 65-byte uncompressed point
      and `auth` is 16 bytes. Otherwise it raises "That browser sent an invalid subscription.".
    - An account can have at most 20 devices (approved 2026-10-13). The account's push destination
      row is locked before the count, so two browsers registering at once can't both pass. A 21st raises "You can turn on
      notifications on up to 20 devices. Remove one first."; re-registering an existing endpoint
      at the cap still works.
  - `unregister_push_device(p_endpoint)` deletes the caller's row for that endpoint. It is silent if
    there is none. It runs on sign-out and on "Turn off".
  - `list_push_devices(p_current_endpoint text default null)` returns
    `id, label, created_at, last_success_at, last_error, last_error_at, is_current`, newest first.
    It never returns the endpoint or the keys.
  - `delete_push_device(p_id)` raises "Device not found." when the id isn't the caller's.
- **Service-role RPC.** `prune_push_devices(p_endpoints text[]) → int` deletes subscriptions that
  came back gone (404/410).
- **Device status** (approved 2026-10-13; the plan had the columns but nothing that wrote them).
  `mark_deliveries_*` doesn't know about devices, so per-device status is written by
  `record_push_results(p_ok text[], p_errors jsonb)`, a service-role RPC.
  - `p_ok` holds endpoints to stamp `last_success_at` and clear the error fields.
  - `p_errors` is `{endpoint: message}` and stamps `last_error` and `last_error_at`.
  - It keeps the worker talking to the database only through RPCs.
- **`claim_deliveries`.** When `dest.type = 'push'`, add
  `'devices', jsonb_agg({endpoint, p256dh, auth})` to the destination jsonb through a lateral
  subquery. A destination with no devices gets `[]`. Also add `base_callsign` to the spot jsonb, so
  a click opens `/call/<base>` with a base call that came from SQL. Recreate the function from its
  **latest** definition (grep the migrations for every `claim_deliveries`; `…000014_mode_family`
  redefined it).
- **Management API** (approved 2026-10-13). Push is listed like any other destination, with `url_display`
  "Your devices".
  - `POST /destinations` with `{"type": "push", "name"}` works, because `create_destination`
    accepts it. Devices can only be added from a browser.
  - `PATCH` with a `url` on a push destination raises "Push notifications don't use a URL."
    (`update_destination` already calls `validate_destination_url`).
  - `POST …/test` reaches every device.
  - Device management stays out of the API.
  - Update `docs/API.md`.
- **Tests and lists.** Update `advisor.test.sql` for the new client-callable functions. Add
  `push_devices` to `account_delete.test.sql`.

### pgTAP `supabase/tests/push_devices.test.sql`

Cover:
- the endpoint allowlist: each of the four hosts accepted; `http:`, a bare `push.apple.com`
  look-alike (`evilpush.apple.com`), an IP literal and `localhost` rejected
- one push destination per user, and its error message
- the `url` / `type` check in both directions
- register reassigning an endpoint across users
- register creating the destination exactly once
- `list_push_devices` never exposing `endpoint`, `p256dh` or `auth`, and `is_current`
- RLS denying direct reads and writes through `pg_temp.as_user`
- `delete_push_device` on another user's device
- `claim_deliveries` including `devices` for push only, and `base_callsign` for every type
- `prune_push_devices` and `record_push_results`
- the cascade on user delete

### Deno, under `supabase/functions/_shared/delivery/`

- **`webpush.ts`** (new). Pure WebCrypto with no dependency.
  - VAPID (RFC 8292): an ES256 JWT with `aud` set to the endpoint's origin, `exp` at most 12 hours
    out and `sub` the `mailto:` contact. The header is `Authorization: vapid t=<jwt>, k=<public key>`.
  - RFC 8291 `aes128gcm` encryption: an ephemeral ECDH P-256 key, HKDF and AES-128-GCM, with the
    RFC 8188 header. One record, padded with the `0x02` delimiter.
  - Tests pin it against the **RFC 8291 Appendix A vector**, byte for byte. They also check that a
    JWT verifies with the public key. The vector is the reason a hand-rolled implementation is
    acceptable. Encryption takes the ephemeral key and salt as optional parameters so the test can
    inject the vector's values.
- **`format.ts`.** `pushNotifications(spots)` is pure. It returns at most 3 `{title, body, tag, url}`
  items, plus one summary item when more spots remain. The strings are in the Copy section.
  - `tag` is `spot:<CALLSIGN>`, or `summary` for the summary.
  - `url` is `/call/<base_callsign>`, or `/sources` for the summary.
  - A test asserts that the encoded payload stays under 3,000 bytes for a worst-case spot. The push
    limit is about 4 KB after encryption overhead.
- **`send.ts`.** `sendPush(destination, deliveries, options)`. `send.ts` is still the only place
  that calls `fetch` for a destination.
  - Per device, it encrypts and POSTs each notification with `TTL: 900`, `Urgency: high`,
    `Topic: <tag with ':' stripped>` and `redirect: "manual"`. Topic is limited to 32 URL-safe
    base64 characters, so any other character (a callsign's `/`) becomes `_` and the result is cut
    at 32.
  - A 201 or 202 counts as accepted.
  - A 404 or 410 adds the endpoint to `expiredEndpoints`, which isn't a failure.
  - A 429 sets `retryAfterSeconds`: a rate limit, not a failure. The device's `last_error` says
    so either way.
  - Any other status, or a network error, is a device error (`Push HTTP <status>`).
  - The batch is `sent` once any device accepted at least one notification. Retrying after that
    would show that device the same spots again, so a device that took notification 1 and then
    refused notification 2 is recorded as an error, not retried. When no device took anything and
    every device failed with a non-gone error, the result is `ok: false`, which counts toward
    `consecutive_failures`.
  - The VAPID header is signed once per push-service origin before anything is sent, so a bad
    key fails the whole send with "Push isn't configured on the server." instead of a device error
    on every device. `SendOptions.now` pins its clock in tests.
  - With zero devices, or zero left after pruning, the result is `ok: false` with the error
    "Turn on notifications on a device first.". Send test shows that string as is. After 5 runs
    the destination goes `failing`, like any other.
  - `sendToDestination` switches on all three types. Today it's a ternary.
- **`types.ts`.**
  - `DeliveryDestination.type` gains `"push"`, `url` becomes `string | null`, and an optional
    `devices` is added.
  - `SendResult` gains optional `expiredEndpoints` and `deviceResults` (fed into
    `record_push_results`).
  - `DeliverySpot` gains `base_callsign`.
- **Delivery age (amended 2026-10-16).** `handlers/deliver.ts` went with the sender cutover
  (`20261015001400`); the loop is `_shared/delivery/run.ts`, run only by the sender. A push
  delivery older than 15 minutes is expired by the sweep in `claim_deliveries`
  (`destination_max_age('push')`), never by an age check in TypeScript, so a push service outage
  doesn't end in a burst of hours-old alerts. Other types get 24 hours. After a push send the loop
  calls `prune_push_devices` and `record_push_results`. The list of calls comes from
  `pushBookkeeping(result)` in `send.ts`, because the `api` function (`verify_jwt = false`)
  reaches it through `test_delivery.ts` and must not import `isServiceRole`.
- **`handlers/test_delivery.ts`.** For a push destination it loads devices with the admin client,
  as it already selects destinations directly, so Send test reaches every device. It runs the
  same `pushBookkeeping` calls afterwards, so a test also prunes gone devices. `sampleSpot` gains
  `base_callsign: "N0CALL"`.
- **VAPID keys** come from Edge Function env:
  - `LONGLINES_VAPID_PUBLIC_KEY` (base64url, uncompressed point)
  - `LONGLINES_VAPID_PRIVATE_KEY` (base64url `d`, or a JWK)
  - `LONGLINES_VAPID_SUBJECT` (`mailto:`)

  `deliver/index.ts` and `send-test/index.ts` read them and pass them in through `SendOptions`.
  Missing keys make push sends fail with "Push isn't configured on the server." and leave Discord
  and webhooks untouched.
- **Key generation.** `scripts/generate-vapid-keys.ts` prints a keypair and writes nothing.
  `docs/OPERATIONS.md` gains the steps. Running the hosted `supabase secrets set` is Brad's job.
- **Tests:**
  - `__tests__/webpush.test.ts`
  - push cases in the existing `send` and `deliver` tests, run against a local http server
    (`allowInsecure`, as today)
  - `function_config.test.ts` stays green

## PR 2: PWA shell (web)

- **Manifest.** `web/public/manifest.webmanifest`:
  - `name` and `short_name` are "Long Lines", and the description is in the Copy section.
  - `display: standalone`, `start_url: "/"`, `scope: "/"`.
  - `theme_color` and `background_color` come from the stock MUI palette.
  - 192 and 512 PNG icons, plus maskable variants, generated from `favicon.svg`.
- **Other icons.** A monochrome `badge-72.png` for Android's status bar and an
  `apple-touch-icon.png` (180). The icons are generated once and committed; nothing generates them
  at build time.
- **`index.html`.** The manifest link, `theme-color` (light and dark `media` variants),
  `apple-touch-icon` and `apple-mobile-web-app-capable`.
- **Service worker** `web/src/pwa/sw.ts`. It's TypeScript, since the repo has no JavaScript files.
  - `push`: parse the JSON payload and call
    `showNotification(title, {body, tag, data: {url}, icon, badge, renotify: true})`.
    `renotify` (*proposed*) makes a re-spot that replaces an older notification sound again.
  - `notificationclick`: close the notification, then focus an open Long Lines window and navigate
    it to `data.url`. If none is open, `openWindow(data.url)`.
  - `pushsubscriptionchange`: re-subscribe with the same key, then call `register_push_device`
    through a plain `fetch` to PostgREST with the stored session. This is best-effort; the app
    also re-registers on every load.
  - No `fetch` handler and no caching.
- **Build.**
  - A second Rollup input in `web/vite.config.ts` emits a fixed `/sw.js`; `entryFileNames` keeps
    the hash on everything else.
  - In dev, the app registers `/src/pwa/sw.ts` with `{type: "module"}`.
  - The SW file gets its own tsconfig with `lib: ["WebWorker"]`.
  - No vite-plugin-pwa or Workbox: we'd only use them for a manifest we can write by hand.
- **Registration.** `web/src/pwa/register.ts` registers the SW on load when
  `"serviceWorker" in navigator`.
- **`web/vercel.json`.** Headers for `/sw.js` (`Cache-Control: no-cache`,
  `Service-Worker-Allowed: /`) and `/manifest.webmanifest` (`Content-Type:
  application/manifest+json`). Vercel serves files before the SPA rewrite.
- **Tests.** The SW handlers are exported as pure functions that take a fake `self` and
  registration, and they're unit-tested in node.

## PR 3: push UI (web)

*Superseded by the 2026-10-15 amendment (page 5) at the top of this file.*

- **`web/src/lib/api.ts`** (still the only supabase-js module) gains:
  - `registerPushDevice`, `unregisterPushDevice`, `listPushDevices` and `deletePushDevice`.
  - `signOut` first unregisters this device's endpoint (best-effort), then calls
    `PushSubscription.unsubscribe()`.
  - "Sign out others" leaves other devices alone. Each one cleans up when it signs out.
- **`web/src/pwa/push.ts`.** Pure state logic, with node tests.
  - `pushSupport()` returns `unsupported`, `ios-needs-install` (iOS/iPadOS not running standalone),
    `denied`, `off` or `on`.
  - `enablePush()` runs on a user gesture. **`Notification.requestPermission()` is its first call,
    before any `await`**, because Safari drops the gesture after an await. Then it calls
    `pushManager.subscribe({userVisibleOnly: true, applicationServerKey})`, then
    `registerPushDevice`.
  - `disablePush()` unsubscribes and unregisters.
  - The device label comes from UA hints, falling back to the UA string. See Copy.
- **VAPID public key.** Add `VITE_VAPID_PUBLIC_KEY`, read from `VAPID_PUBLIC_KEY` or
  `LONGLINES_VAPID_PUBLIC_KEY`, to the explicit `define` allowlist in `vite.config.ts`. It's a
  public key and the only new entry; `envPrefix` stays as it is.
- **Add destination dialog.**
  - `push` joins `DEST_TYPES`. Once the account has a push destination, the type is hidden.
  - With push selected, the dialog shows no URL field. Its primary button reads **Turn on
    notifications**, and it calls `enablePush()`. `register_push_device` creates the destination,
    named "Push notifications".
  - If the device is `unsupported`, `ios-needs-install` or `denied`, the dialog shows that state's
    copy in place of the button, plus **Add without this device**. That button calls
    `create_destination('push', name, null)` so another device can turn notifications on later.
  - The Name field stays, defaulting to "Push notifications". It's sent as `register_push_device`'s
    optional `p_name`, which is used only when that call creates the destination (*proposed*).
    The fallback button sends it to `create_destination`.
- **The push destination's row** on the Destinations page:
  - The usual chips, Send test and Delete.
  - Below them, a **This device** line with its control (Turn on, Turn off, or the reason it can't,
    including the iOS Add to Home Screen steps).
  - A **Devices** list with Remove.
  - When the device list is empty, an info alert (see Copy).
- **Install.**
  - Capture `beforeinstallprompt` (Chrome, Edge, Android) and offer **Install app** in the AppShell
    account menu, between Take the tour and Sign out.
  - On iOS/iPadOS outside standalone, the same item opens the Add to Home Screen steps.
  - Hide the item when running standalone, or when neither applies.
- **Refresh.** On app load, when permission is granted and a subscription exists, call
  `registerPushDevice` again. This keeps the endpoint fresh after the browser rotates it.
- **Other changes.**
  - Regenerate `web/src/lib/database.types.ts`.
  - Component tests go through `test/render.tsx` with `vi.mock("../lib/api")`, and stub
    `navigator.serviceWorker`, `PushManager` and `Notification`. Cover every This device state and
    the phone layout (`setMobile(true)`). Coverage stays at or above 80%.
- **Tour.** No change unless Brad asks.
- **Docs.** `docs/ARCHITECTURE.md` gains the push path. The README notes the VAPID env for
  `dev:full`.

## Open questions (*proposed*, need a yes)

Brad approved 1, 2, 4 and 5 on 2026-10-13, at the start of PR 1. 3 and 6 are PR 2 and PR 3
questions; the 2026-10-15 amendment closes both.

1. **Device cap.** *Approved.* Should an account be limited to some number of devices, say 20? Each run's
   requests scale with devices × 4. Proposed: 20, enforced in `register_push_device` with "You can
   turn on notifications on up to 20 devices. Remove one first.".
2. **Management API.** *Approved.* As described in PR 1: push is visible and can be created, but devices are
   browser-only.
3. **`renotify: true`** on replaced notifications. *Closed by the 2026-10-15 amendment: `renotify`
   follows the Sound and vibration switch.*
4. **Dialog name.** *Approved.* The optional `p_name` on `register_push_device`.
5. **Device status writes.** *Approved.* `record_push_results`, so the Devices list can show "Last alert" and
   errors.
6. **Add without this device.** The dialog's fallback when this browser can't turn notifications
   on. Without it, an iPhone user who hasn't installed the app yet can't add the destination at
   all. *Closed by the 2026-10-15 amendment: the editor saves with zero devices and shows "No
   devices yet".*

## Verification

- `deno task coverage`, `deno task check` and `deno task lint`. The RFC 8291 vector test must pass.
- `supabase db reset && supabase test db`, covering the new suite and the advisor test, plus
  `scripts/smoke-test.sql`.
- `cd web && npm run test:all`, then `npm run build`: zero TS errors, and `dist/sw.js` exists
  without a hash.
- End to end, locally:
  - Run `npm run dev:full` with generated VAPID keys in `supabase/functions/.env`.
  - Turn on push in desktop Chrome at `localhost` (a secure context) and click Send test. The
    notification appears, and clicking it opens `/call/N0CALL`.
  - Run `select match_pending_spots()` against a seeded subscription that targets push. Check that
    it sends 3 spots and a summary.
- Revoke the permission or unsubscribe the browser, deliver again, and confirm the 410 prunes the
  device.
- Run Chrome's "Installable" check on a Vercel preview. Then try a real Android device, and an iOS
  device after Add to Home Screen on the preview URL.

## Copy

The copy source for push and install, in place of `docs/ui-mock.html`. Use these strings word for
word. `{…}` marks a value. Brad's review of this spec approves them, or changes them here first.

**Destination type** (`DEST_TYPES`)
- Label: Push notifications
- Help: Get alerts on your phone or computer. Every browser where you turn on notifications gets them.
- Masked URL (`url_display`, from SQL): Your devices
  - So the row reads "Push notifications · Your devices".
- Default name: Push notifications

**Add destination dialog, push selected**
- Name placeholder: e.g. My devices
- Primary button: Turn on notifications
- Busy: Turning on…
- Fallback button (this device can't turn on): Add without this device
- Error: Couldn't turn on notifications.

**This device** (on the push row, and in the dialog where it applies)
- Heading: This device
- `on`: Notifications are on for this browser. · Button: Turn off
- `off`: Notifications are off for this browser. · Button: Turn on
- `denied`: Notifications are blocked for Long Lines. Allow them in your browser's site settings, then reload this page.
- `unsupported`: This browser can't receive push notifications.
- `ios-needs-install`: On iPhone and iPad, notifications only work after you add Long Lines to your Home Screen.
  1. Tap the Share button in Safari.
  2. Choose Add to Home Screen, then Add.
  3. Open Long Lines from your Home Screen and sign in.
  4. Come back to Destinations and turn notifications on.
- Toasts: Notifications turned on · Notifications turned off

**Devices list**
- Heading: Devices
- Current-device chip: This device
- Meta, sent before: Added {date} · Last alert {age} ago
- Meta, nothing sent yet: Added {date} · No alerts yet
- Error line: Failed {age} ago: {last_error}
- Remove button aria-label: Remove {label} · Tooltip: Remove
- Toast: Removed {label}
- Empty alert (info): No devices get these alerts yet. Turn on notifications on this device, or sign in on another device and turn them on there.
- Device labels: {Browser} on {Platform}
  - Browsers: Chrome, Edge, Firefox, Safari, Samsung Internet, Opera
  - Platforms: Android, iPhone, iPad, macOS, Windows, Linux, ChromeOS
  - Fallback: This browser

**Install**
- Account menu item: Install app
- iOS dialog title: Install Long Lines
- iOS dialog steps:
  1. Tap the Share button in Safari.
  2. Choose Add to Home Screen, then Add.
  3. Open Long Lines from your Home Screen.
- iOS dialog button: Done
- Manifest `description`: Alerts when the stations you follow are spotted on POTA, SOTA, RBN and the DX Cluster.

**Notifications** (built in `format.ts`; the service worker only displays them)
- Spot title: {CALLSIGN}
- Spot body: two lines.
  - Line 1: {kHz} kHz {MODE} ({band}), the same text as the Discord embed's description.
  - Line 2: the parts present, joined with " · ": {POTA reference}, {park name}, {SOTA summit}, {Source}.
  - Example: `14062.0 kHz CW (20m)` / `US-2763 · Pisgah National Forest · POTA`
- Summary title: {N} more spots (singular: 1 more spot)
- Summary body:
  - Up to 3 calls: {CALL}, {CALL} and {CALL}
  - More than 3: {CALL}, {CALL}, {CALL} and {K} others (singular: and 1 other)
  - Calls are listed in spot order and deduplicated.
- Test notification: the sample spot through the same formatter, so the title is N0CALL and the
  body is `14062.0 kHz CW (20m)` / `US-0000 · Test Park · POTA`.

**Errors**
- Turn on notifications on a device first. (no devices; shown by Send test and stored as the
  delivery error)
- Push isn't configured on the server.
- You already have push notifications.
- Push notifications don't use a URL.
- Use a browser push service.
- That browser sent an invalid subscription.
- Device not found.
- Push HTTP {status} (a device's `last_error`)
- *Proposed*, with the device cap: You can turn on notifications on up to 20 devices. Remove one first.
