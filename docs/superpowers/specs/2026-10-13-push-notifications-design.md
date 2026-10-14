# Push notifications and an installable app: design

Date: 2026-10-13. Status: **Decisions approved by Brad (2026-10-13). This spec, and especially its
Copy section, is waiting for his review.** No code ships until he approves it. Items marked
*proposed* fill gaps the planning session didn't cover. Each needs an explicit yes. If the design
changes during a PR, update this file in that PR.

## Purpose

Today matched spots go out through only two destination types, `discord` and `webhook`. This adds a
third, **push notifications**. The web app becomes an installable PWA. An alert reaches every browser
or device where the user is signed in and has turned notifications on. That covers Android, desktop
Chrome, Edge, Firefox and Safari, and iOS/iPadOS 16.4+ once Long Lines is added to the Home Screen.

## Decisions

| Topic | Decided |
|---|---|
| Shape | **One push destination per account.** It fans out to every registered device. Subscriptions pick it like any other destination, and devices come and go underneath it. |
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

### Migration `20261013000400_push_destinations.sql`

Recheck the number across every worktree and remote branch first. On 2026-10-13 the highest
anywhere is `20261013000300_management_api.sql`.

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
- **`handlers/deliver.ts`.** A push delivery older than `TTL` (15 minutes, `PUSH_MAX_AGE_MS`) is
  dropped instead of retried, so a push service outage doesn't end in a burst of hours-old
  alerts. Other types keep the 24-hour limit. After a push send, it calls `prune_push_devices` and
  `record_push_results` through `rpcOrLog`. The list of calls comes from `pushBookkeeping(result)`
  in `send.ts`, not `deliver.ts`, because the `api` function (`verify_jwt = false`) reaches it
  through `test_delivery.ts` and must not import `isServiceRole`.
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
questions and are still open.

1. **Device cap.** *Approved.* Should an account be limited to some number of devices, say 20? Each run's
   requests scale with devices × 4. Proposed: 20, enforced in `register_push_device` with "You can
   turn on notifications on up to 20 devices. Remove one first.".
2. **Management API.** *Approved.* As described in PR 1: push is visible and can be created, but devices are
   browser-only.
3. **`renotify: true`** on replaced notifications.
4. **Dialog name.** *Approved.* The optional `p_name` on `register_push_device`.
5. **Device status writes.** *Approved.* `record_push_results`, so the Devices list can show "Last alert" and
   errors.
6. **Add without this device.** The dialog's fallback when this browser can't turn notifications
   on. Without it, an iPhone user who hasn't installed the app yet can't add the destination at
   all.

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
