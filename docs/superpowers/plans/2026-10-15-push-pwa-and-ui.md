# Push Notifications: Page 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish push notifications so the web app matches **Page 5 of Brad's design canvas** ("Push notification destination (draft)"): a Destinations card grid with push cards, an Add destination type picker, a full-page push destination editor (devices, notification content, delivery settings, live preview), an Add a device dialog with its iPhone variant, and the installable PWA that carries the notifications.

**Architecture:** PR 1 (#157, merged 2026-10-14) shipped the schema, RPCs and worker for the *spec's* model: one push destination per account fanning out to every device, with fixed notification text. Page 5 is a different model: **many push destinations per account, each with its own picked devices, its own notification template and its own delivery settings.** So the work is a spec amendment, one new migration plus worker changes, the PWA shell, and the web pages. Templates are rendered in SQL (`render_push_template`) so the worker and the editor's preview show the same text; the worker keeps only the per-run "3 spots then a summary" shaping.

**Tech Stack:** Postgres (plpgsql, pgTAP), Deno Edge Functions, React 19, MUI 9, react-router 8, Vite 8 (second Rollup input for `/sw.js`), Vitest + Testing Library, Web Push API, Vercel headers.

**Design sources:**
- Canvas page 5 (`https://claude.ai/artifact/JyDdSRy1MCxeHJbYLgz7xh#page-a34d51868905`), seven artboards: `PushList-Desktop`, `PushType-Desktop`, `PushNew-Desktop`, `PushDevice-Desktop`, `PushEdit-Desktop`, `PushEdit-Mobile`, `PushDevice-iOS-Mobile`. The card grid for Discord and webhook cards comes from canvas page 1, "8 · Destinations", which the app never adopted (it still renders a `List`).
- `docs/superpowers/specs/2026-10-13-push-notifications-design.md`, as amended by Part 0 below. Its PR 1 section describes what exists today. Its Copy section is superseded by the **Copy** section at the end of this plan wherever page 5 shows a screen; notification *defaults* and error strings that page 5 doesn't show stay as the spec has them.

## Where things stand

| Area | State |
| --- | --- |
| Schema and worker for one push destination per account, fixed text, every device (`20261014000100`, `webpush.ts`, `sendPush`, `pushNotifications`, send-test, API) | Merged in #157; applied to hosted |
| PWA shell (manifest, icons, service worker, `/sw.js`, Vercel headers) | Not started |
| Any push UI | Not started. `DEST_TYPES` has Discord and webhook only; the Destinations page is a `List`, not page 1's card grid |
| Hosted VAPID secrets, redeploy of `deliver`, `send-test`, `api` | Unknown (this machine's CLI isn't linked). Brad's step |
| `VAPID_PUBLIC_KEY` in Vercel env | Not set; nothing reads it yet |
| #158 (retry devices that missed a batch), #159 (`claim_deliveries` repeats devices per row) | Open follow-ups. #159 gets fixed in passing by Task 3, since the device list is rebuilt per destination anyway |

Since the spec was written, main removed the guided tour (#179) and added a Theme switch to the account menu (#180), and the Subscriptions editor became a full page (`SubscriptionEditorPage.tsx`), which is the pattern the push editor follows.

## What page 5 changes against the approved spec

| Page 5 element | Spec / PR 1 today | Work |
| --- | --- | --- |
| Three push cards ("POTA on my phone", "SOTA on my phone", "Desktop alerts"), each with its own device chips | One push destination per account; `register_push_device` creates it; devices belong to the account | Drop the one-per-user index; add `push_destination_devices`; `register_push_device` stops creating destinations; `claim_deliveries` and send-test read members per destination |
| Devices card: checkbox per device, name + "Chrome on macOS · last delivery …", Rename, Remove, "This device", "Blocked" | `push_devices.label` is one string ("Chrome on macOS"); no rename; no blocked state | `label` becomes the user's name, new `agent`, `standalone`, `blocked_at`; `rename_push_device`, `report_push_device_blocked` |
| Notification content: Title and Body templates with `{field}` chips, "When tapped, open", action buttons, Reset to default text | Fixed text in `format.ts`; click always opens `/call/<base>` | `push_destination_settings`; `render_push_template` in SQL; `claim_deliveries` returns rendered text and the tap/source URLs; worker uses them; service worker shows `actions` |
| Delivery: Urgency, Drop if offline for, Replace earlier notification, Sound and vibration, Quiet hours | `Urgency: high`, `TTL: 900`, tag per callsign, never silent, no quiet hours | Settings columns; `send.ts` reads urgency and TTL per destination; `deliver.ts` max age per destination; `quiet_now` computed in SQL in the account time zone |
| Preview card with a spot picker and Android / iPhone / Desktop renderings; Send test notification | Send test uses the sample spot | `preview_push_notification` RPC; `send-test` takes an optional `spot_id` |
| Name helper "Names are unique…", Enabled switch | Names free; no enabled flag on destinations (only `health`) | Unique `(user_id, lower(name))` with hosted duplicates renamed; `destinations.enabled`; the matcher skips disabled destinations |
| Duplicate button on push cards | Nothing | `duplicate_destination` |
| "Home desktop cannot receive notifications" alert with Manage devices | Nothing | Web, from `blocked_at` |
| Add destination as a type picker (card radios, Continue) | Radio group plus fields in one dialog | Web: step 1 picker for every type; Discord and webhook keep their fields as step 2; push continues to the editor page |
| Add a device dialog; iPhone not-installed screen | "This device" line on the row (spec) | Web, on the RPCs above |
| "Install app" account menu item | In the spec, not on page 5 | Keep (decision 12) |
| "connection" wording throughout page 5 | CLAUDE.md: say "subscription" until Connections ship | Copy substitution, see Copy |

## How to run this plan: six parts, four PRs

Run each part in a fresh Claude Code session opened in the worktree `/home/brad-bazemore/Dev/longlines-push-web` (created from `origin/main`; its first branch is `push-pwa`).

| Part | Tasks | Produces | Branch | PR |
| --- | --- | --- | --- | --- |
| 0 | Task 0 | Spec amendment recording Brad's decisions, CLAUDE.md push rules updated | `push-spec-2` | Spec PR, reviewed before Parts 2–5 |
| 1 | Tasks 1–2 | Manifest, icons, `index.html`, `sw.ts`, `register.ts`, Vite input, Vercel headers | `push-pwa` | PR 2 (can run before Part 0 is approved; nothing in it depends on the decisions) |
| 2 | Tasks 3–5 | Migration `20261015000100_push_destinations_v2.sql`, worker, send-test, API, tests | `push-schema-2` | PR 3 |
| 3 | Tasks 6–8 | `api.ts`, `pwa/push.ts`, Destinations card grid, type picker | `push-ui` | PR 4 (draft) |
| 4 | Tasks 9–11 | Push destination editor page, devices card, Add a device dialog, preview | `push-ui` | PR 4 (draft) |
| 5 | Tasks 12–13 | Install app, refresh on load, sign-out cleanup, docs, gates, end to end | `push-ui` | PR 4 (ready) |

PR 2 is safe to merge alone. PR 3 is safe to merge alone: existing push destinations keep working (the migration enrols every device of the owner into the account's existing push destination and gives it default settings), and nothing user-visible changes until PR 4. PR 4 needs PRs 2 and 3.

### Branches and PRs

- **Part 0** starts `push-spec-2` from `origin/main`. **Part 2** starts `push-schema-2` from `origin/main` once the spec PR is merged (otherwise from `push-spec-2`, stacked). **Part 3** starts `push-ui` from `origin/main` once PRs 2 and 3 are merged; otherwise from whichever is unmerged (stacked), and says so in the PR text.
- `git switch -c <branch> <start>` in this worktree; never `git checkout` a branch another session may hold. Always `git push -u origin <branch>` with the branch named.
- `gh pr create --base <base>`; the repo deletes branches on merge and GitHub retargets stacked PRs. Part 3 opens PR 4 as a draft; Part 5 marks it ready after every gate passes.
- PR text follows #157: what it does, what's still to come, testing with real numbers, Brad's steps, and whether merging applies a migration (PR 3 does).
- Nothing is pushed, merged or deployed unless Brad asks. Don't run pgTAP in two sessions at once; the local stack is shared.

## Decisions needed (Brad answers these in Part 0; Parts 2–5 assume the proposals)

1. **Many push destinations per account, devices picked per destination** (page 5) replaces the approved "one per account, every device". *Everything below assumes yes.*
2. **Enabled switch.** Proposed: a real `destinations.enabled` column that `match_pending_spots` honours for every type, rather than reusing `health = 'paused'`, which is a delivery-side state. Discord and webhook cards don't show the switch (page 1), but the API exposes `enabled` for all.
3. **Unique names** per account across all destination types, case-insensitive, as page 5's helper says. The migration renames hosted duplicates to "{name} (2)", "(3)" and so on, oldest keeps its name. Error: "A destination named {name} already exists. Choose a different name."
4. **Template fields and formatting.** `{callsign}`, `{frequency}`, `{band}`, `{mode}`, `{source}`, `{reference}`, `{place_name}`, `{state}`, `{spotter}`, `{comment}`, `{time}`. Page 5 shows `{frequency}` as "14.062" (MHz), while the app shows kHz everywhere else. Proposed: MHz with three decimals in templates, as drawn. `{reference}` is the POTA reference or SOTA summit; `{place_name}` the park name; `{state}` the part after the dash of `pota_location` ("US-NC" → "NC"); `{source}` the source label; `{time}` the UTC clock; `{mode}` upper case. A field the spot lacks is replaced by nothing, then the renderer tidies the separators left behind (", ," and " ." and doubled spaces), so "POTA US-2763, , NC." never appears.
5. **"When tapped, open."** Proposed options: **Callsign profile** (`/call/<base>`, default) and **Source site** (`spot_source_url`: the POTA park page, the SOTA summit page; for RBN and DX Cluster spots it falls back to the profile). URLs are built in SQL.
6. **Action buttons.** "Open profile" and "Open on {Source}" (the latter only when `spot_source_url` differs from the profile). Shown through the notification `actions` API; iOS ignores them, as the preview caption says.
7. **Delivery values.** Urgency Low / Normal / High (default Normal; today's worker sends High). Drop if offline for 5 min / 15 min / 30 min / 1 hour / 4 hours (default 30; today 15). Replace the earlier notification for the same station: default on (tag per station; off gives each spot its own tag). Sound and vibration: default on (`silent: false`). Quiet hours: default off, 22:00 to 07:00, "During quiet hours" is **Send silently** (default) or **Don't send** (the delivery is marked sent without a push, never queued). Quiet hours use the account time zone (`profiles.timezone`), evaluated in SQL when the delivery is claimed.
8. **Blocked devices.** A browser that finds `Notification.permission === "denied"` on load reports its last endpoint through `report_push_device_blocked`, which stamps `blocked_at`. Blocked devices are skipped at claim time and shown as page 5 draws them. The browser remembers its last endpoint in `localStorage` (a per-viewer convenience), since a denied browser can no longer read its subscription. Re-registering clears `blocked_at`.
9. **Duplicate.** `duplicate_destination(p_id)` for push destinations only (page 5 shows it only there): same settings and devices, name "Copy of {name}", `enabled` false so a copy never double-sends until it's edited. Returns the new id and the web opens the editor.
10. **Send test from the editor.** The test uses the destination's *saved* settings and devices and the chosen preview spot (`send-test` gains an optional `spot_id`). While the form has unsaved changes the button is disabled with the caption "Save your changes to send a test."; on a new destination, "Add a device to send a test." as drawn.
11. **Device name.** The Add a device dialog prefills "{Browser} on {Platform}" and the user can change it; the descriptor is stored separately in `agent` and shown under the name. "installed app" is appended for standalone (Home Screen) browsers.
12. **Install app** stays in the account menu, between Account and Sign out (the spec had it next to the tour, which is gone).
13. **`pushsubscriptionchange`.** The service worker can't reach the supabase-js session and must never hold a token, so it re-subscribes and posts `{type: "push-subscription-changed"}` to open windows, which re-register; the next app load covers the no-window case, and the old endpoint is pruned on its first 410.
14. **Icons.** No SVG rasteriser is installed. Proposed: a throwaway resvg script in the session scratchpad, PNGs committed, nothing added to the build.
15. **Manifest `theme_color`.** One value: the stock MUI light primary `#1976d2`, `background_color` `#ffffff`; the `index.html` metas keep light and dark variants.
16. **Per-run shaping stays.** Page 5 doesn't show it, so the worker keeps "at most 3 notifications per device per run, then one summary". The summary uses fixed text (spec Copy) and the destination's tap target.

## Brad's steps (no part does these)

1. Hosted VAPID secrets and a redeploy of `deliver`, `send-test` and `api` (OPERATIONS.md "Push"), if not already done.
2. `VAPID_PUBLIC_KEY` in the Vercel project env (production and preview) once PR 4 lands.
3. The same three secrets on a PR's Supabase preview branch for end-to-end checks there.

## Global Constraints

- Work only in `/home/brad-bazemore/Dev/longlines-push-web` on the part's branch. Never `supabase db push`, `functions deploy`, `fly deploy`, `supabase secrets set` or `vercel`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Migrations already applied to hosted are never edited; `20261014000100` stays as is and the new migration builds on it. Recheck the new number against every worktree and remote branch first.
- Behaviour goes in SQL: template rendering, source URLs, quiet hours, device membership, name uniqueness. The worker and the web never render a template or work out a base call.
- `web/src/lib/api.ts` stays the only supabase-js module. `web/src/pwa/push.ts` is the only module that touches `PushManager`, `Notification` and `PushSubscription`. `register.ts` is the only module that calls `navigator.serviceWorker.register`. The service worker never imports app code and never holds a token.
- No endpoint, `p256dh` or `auth` is ever rendered, logged or returned to a client. `list_push_devices` returns names, descriptors and status only.
- `vite.config.ts`: `VITE_VAPID_PUBLIC_KEY` is the one new `define` entry; `envPrefix` stays as it is.
- Copy is word for word from the **Copy** section below (page 5 with the listed substitutions), then the spec's Copy for anything page 5 doesn't show. Say "subscription", never "connection".
- No new runtime dependency (no vite-plugin-pwa, Workbox, web-push, UA parser, template engine).
- MUI 9 rules from CLAUDE.md: `sx` for layout only; colours, borders and shadows from props and variants (the preview mock-ups use `Paper` elevation and palette colours, never the canvas's hex or gradient values); `Grid size`; `slotProps`; no `fontWeight` prop; MUI icons only.
- Web tests render through `web/src/test/render.tsx` with `vi.mock("../lib/api")` factories; pure `*.test.ts` stay in node; `setMobile(true)` for the phone layout. Gates per part: `cd web && npm run coverage`, `npm run build`, `npm run lint`; `deno task coverage`, `deno task check`, `deno task lint`; `supabase db reset && supabase test db`; `npm run test:all` once before a PR is marked ready.

## Review Focus

- Secrets: the device list the worker gets per destination holds keys; nothing else does. `get_push_destination` and `list_push_devices` return ids, names, descriptors and status only.
- The user gesture: `Notification.requestPermission()` is the first statement of `enablePush()`, before any `await`.
- Template rendering lives in one SQL function; the preview RPC and `claim_deliveries` both call it; `format.ts` never interpolates a template.
- Quiet hours and the Don't send mode: a delivery that is skipped is marked sent, never retried and never counted as a failure.
- The migration is safe on hosted data: existing push destinations keep every device, get default settings, and duplicate names are renamed before the unique index is created.
- The service worker emits as a single `dist/sw.js` with no `import` statements and is served `Cache-Control: no-cache`.

---

## Part 0: Spec amendment (branch `push-spec-2`)

### Task 0: Record the page 5 design in the spec

**Files:** `docs/superpowers/specs/2026-10-13-push-notifications-design.md`, `CLAUDE.md`.

- [ ] Add a section "Amendment, 2026-10-15: page 5" at the top of the spec, after Status: the model change (decision 1), the schema in Task 3 in prose, the decisions above with Brad's answers, and the Copy section of this plan (page 5 strings with substitutions). Mark the original "PR 3: push UI" section superseded and the spec's open questions 3 and 6 closed (`renotify` is now the Sound and vibration switch; "Add without this device" is replaced by the editor, which saves with zero devices and shows "No devices yet").
- [ ] CLAUDE.md "Push rules": replace the first bullet (one push destination per account) with: many per account; devices belong to the account (`push_devices`) and destinations pick them through `push_destination_devices`; notification text comes from `render_push_template` in SQL and `claim_deliveries`, never from TypeScript; `push.ts`, `register.ts` and the service-worker rules from Global Constraints; the web never reads an endpoint back.
- [ ] Commit `Spec: push destinations follow canvas page 5`, push, open the spec PR. Brad reviews it before Part 2 starts.

---

## Part 1: PWA shell (PR 2, branch `push-pwa`)

### Task 1: Manifest, icons and `index.html`

**Files:** `web/public/manifest.webmanifest`, `web/public/icon-192.png`, `icon-512.png`, `icon-192-maskable.png`, `icon-512-maskable.png`, `badge-72.png`, `apple-touch-icon.png` (committed), `web/index.html`, `web/src/pwa/manifest.test.ts`.

- [ ] Manifest: `name`/`short_name` "Long Lines", `description` from the spec Copy, `display: "standalone"`, `start_url: "/"`, `scope: "/"`, colours per decision 15, four icons with `purpose` `any` and `maskable`.
- [ ] Generate the icons once from `web/public/favicon.svg` (decision 14): maskable variants keep the glyph inside the 80% safe zone on a solid background; `badge-72.png` is a white silhouette on transparent; `apple-touch-icon.png` is 180×180 on a solid background. Commit the PNGs; nothing generates them at build time.
- [ ] `index.html`: manifest link, two `theme-color` metas with light and dark `media`, `apple-touch-icon`, `apple-mobile-web-app-capable`.
- [ ] `manifest.test.ts` (node): parse the manifest, assert the fields, assert every icon file exists.
- [ ] Commit `PWA: manifest, icons and install tags`.

### Task 2: Service worker, registration, build and headers

**Files:** `web/src/pwa/sw.ts`, `web/src/pwa/sw-handlers.ts` (+ test), `web/src/pwa/register.ts` (+ test), `web/src/main.tsx`, `web/vite.config.ts`, `web/tsconfig.json`, `web/tsconfig.app.json`, `web/tsconfig.sw.json`, `web/vercel.json`, `docs/ARCHITECTURE.md`.

- [ ] `sw-handlers.ts`: pure functions typed against small structural interfaces (not the WebWorker lib) so they compile under the app tsconfig and test in node:
  - `handlePush(data, notifications)`: parse `{title, body, tag, url, sourceUrl?, actions?, silent?, renotify?}`; ignore malformed data; `showNotification(title, {body, tag, data: {url, sourceUrl}, icon: "/icon-192.png", badge: "/badge-72.png", actions, silent, renotify})`. `actions` is `[{action: "profile", title: "Open profile"}, {action: "source", title: "Open on {Source}"}]` when the payload carries them; the worker decides, the service worker displays.
  - `handleNotificationClick(action, data, clients, origin)`: `action === "source"` opens `data.sourceUrl`, else `data.url`; focus an open window and `navigate`, else `openWindow`.
  - `handleSubscriptionChange(registration, oldSubscription, clients)`: re-subscribe with the same key, then `postMessage({type: "push-subscription-changed"})` to every client (decision 13).
- [ ] `sw.ts`: `declare const self: ServiceWorkerGlobalScope`, three listeners with `waitUntil`, imports only `./sw-handlers.ts`. No `fetch` listener.
- [ ] `tsconfig.sw.json` with `lib: ["ES2023", "WebWorker"]` including `src/pwa/sw.ts` and `sw-handlers.ts`; reference it from `tsconfig.json`; exclude `src/pwa/sw.ts` from `tsconfig.app.json`.
- [ ] `vite.config.ts`: `build.rollupOptions.input = { main: "index.html", sw: "src/pwa/sw.ts" }`, `output.entryFileNames` returning `sw.js` for the `sw` chunk and the hashed pattern otherwise. Add `src/pwa/sw.ts` to the coverage exclude with a comment.
- [ ] `register.ts`: `registerServiceWorker(nav = navigator)`; in dev register `/src/pwa/sw.ts` with `{type: "module"}`, in prod `/sw.js`; call it from `main.tsx` after render.
- [ ] `vercel.json`: `headers` for `/sw.js` (`Cache-Control: no-cache`, `Service-Worker-Allowed: /`) and `/manifest.webmanifest` (`Content-Type: application/manifest+json`); rewrites untouched.
- [ ] Tests (node): push well-formed and malformed; click with and without an open window, with and without `action`; subscription change posting to two clients; register in dev, prod and without `serviceWorker`.
- [ ] `npm run build`, then check `dist/sw.js` exists and `grep -c "^import" dist/sw.js` is 0.
- [ ] ARCHITECTURE: one paragraph on the PWA and the service worker's three handlers.
- [ ] Commit `PWA: service worker for push, registered on load, emitted as /sw.js`; gates; push `push-pwa`; open PR 2. PR text includes the Vercel preview check (Chrome's Installable audit, `/sw.js` served `no-cache`).

---

## Part 2: Schema, worker and API for page 5 (PR 3, branch `push-schema-2`)

### Task 3: Migration `20261015000100_push_destinations_v2.sql`

**Files:** the migration, `supabase/tests/push_destinations.test.sql` (new), `supabase/tests/push_devices.test.sql`, `supabase/tests/advisor.test.sql`, `supabase/tests/management_api.test.sql`, `supabase/tests/account_delete.test.sql`, `supabase/seed.sql`, `scripts/smoke-test.sql` if it lists tables.

- [ ] **Destinations.** `drop index destinations_one_push_per_user`. `add column enabled boolean not null default true`. Rename hosted duplicates (per user, case-insensitive, oldest keeps its name, the rest get " (2)", " (3)"…), then `create unique index destinations_user_name_key on destinations (user_id, lower(name))`. `create_destination` and `update_destination` catch `unique_violation` on that index and raise "A destination named {name} already exists. Choose a different name."; `create_destination('push', …)` no longer raises "You already have push notifications." `update_destination` gains `p_enabled boolean default null`.
- [ ] **Matcher.** Recreate `match_pending_spots` from its latest definition so the `subscription_destinations` join also requires `destinations.enabled`. Grep every redefinition first.
- [ ] **Devices.** `push_devices`: `add column agent text not null default ''`, `standalone boolean not null default false`, `blocked_at timestamptz`; backfill `agent = label`. `register_push_device(p_endpoint, p_p256dh, p_auth, p_label, p_agent, p_standalone)` upserts as before but **never creates a destination**, clears `blocked_at`, and returns the device id. Drop the old five-argument overload. `rename_push_device(p_id, p_label)` (trimmed, 60 chars, blank → "This browser"). `report_push_device_blocked(p_endpoint)` stamps `blocked_at` for the caller's device, silent otherwise. `list_push_devices(p_current_endpoint)` now returns `id, label, agent, standalone, created_at, last_success_at, last_error, last_error_at, blocked_at, is_current, destination_ids uuid[]`, newest first.
- [ ] **Membership.** `create table push_destination_devices (destination_id uuid references destinations on delete cascade, device_id uuid references push_devices on delete cascade, primary key (destination_id, device_id))`, RLS on, no policies, `anon`/`authenticated` revoked. Backfill: every existing push destination gets every device of its owner.
- [ ] **Settings.** `create table push_destination_settings (destination_id uuid primary key references destinations on delete cascade, title_template text not null, body_template text not null, tap_target text not null check (tap_target in ('profile','source')), action_buttons boolean not null, urgency text not null check (urgency in ('low','normal','high')), ttl_seconds int not null check (ttl_seconds in (300,900,1800,3600,14400)), replace_same_station boolean not null, sound boolean not null, quiet_enabled boolean not null, quiet_from time not null, quiet_until time not null, quiet_mode text not null check (quiet_mode in ('silent','skip')))`, same RLS pattern. `push_default_settings()` returns the defaults from decision 7 and the Copy section's default templates; a trigger on `destinations` inserts them for every new push row; backfill existing ones. Template checks: at most 120 characters for the title, 300 for the body, only known `{fields}` (`push_template_fields()` returns the list; unknown ones raise "Unknown field {name}.").
- [ ] **Rendering.** `render_push_template(p_template text, p_spot jsonb) returns text` (immutable where possible, `search_path` pinned): token replacement per decision 4, then separator tidying. `spot_source_url(p_spot jsonb) returns text`: POTA park page, SOTA summit page, else null. `push_quiet_now(p_settings, p_timezone, p_at timestamptz) returns boolean` handles ranges that cross midnight.
- [ ] **`claim_deliveries`.** Recreate from `20261014000100`. For push: `devices` are the destination's members with `blocked_at is null`, aggregated once per destination in a CTE (closes #159 for push); the destination jsonb gains `push` = the settings row; the spot jsonb gains `push_title`, `push_body`, `push_url` (`/call/<base>` or the source URL per `tap_target`), `push_source_url` and `quiet_now`. `base_callsign` stays.
- [ ] **Client RPCs** (security definer, pinned `search_path`, `revoke all from public`, `grant execute to authenticated`, listed in `advisor.test.sql`): `save_push_destination(p_id uuid, p_name text, p_enabled boolean, p_settings jsonb, p_device_ids uuid[]) returns uuid` (creates when `p_id` is null; validates settings; rejects device ids that aren't the caller's with "Device not found."; replaces membership), `get_push_destination(p_id) returns jsonb` (settings + `device_ids`), `duplicate_destination(p_id) returns uuid` (decision 9), `preview_push_notification(p_title text, p_body text, p_spot_id bigint default null) returns table (title text, body text, url text, source_url text)` (renders against `raw_spots` row `p_spot_id`, or the sample spot when null; the sample spot's shape lives in SQL `push_sample_spot()` so send-test and the preview agree), `rename_push_device`, `report_push_device_blocked`. Each raises "Not signed in." without `auth.uid()`.
- [ ] **Service-role RPCs** unchanged: `prune_push_devices`, `record_push_results`.
- [ ] **API.** `api_destination_json` gains `enabled` and, for push, `push` (the settings object and `device_count`; never devices). `api_call`'s allowlist and the route table (`api_routes.test.ts`) gain `enabled` on PATCH; `POST /destinations` with `type: "push"` now always works. `docs/API.md` updated: "An account has at most one push destination" goes; devices stay browser-only.
- [ ] **Seed.** `supabase/seed.sql` adds one push destination with settings for the synthetic user, no devices.
- [ ] **pgTAP** `push_destinations.test.sql`: two push destinations per user; unique names (case-insensitive) and the error text; hosted-duplicate rename logic on a fixture; `enabled` false keeps a spot out of `deliveries`; membership save/replace and the foreign-user device rejection; `render_push_template` for every field, a missing field, and separator tidying (the "POTA US-2763, , NC." case); `spot_source_url` per source; `push_quiet_now` inside, outside and across midnight in `America/New_York`; `claim_deliveries` returning members only, skipping blocked devices, carrying `push_title`/`push_body`/`push_url`/`quiet_now`; `preview_push_notification` matching `claim_deliveries` for the same spot; `duplicate_destination` name, `enabled` false and copied members; RLS on the two new tables; cascades on destination, device and user delete. Update `push_devices.test.sql` for the new `register_push_device` shape, `rename`, `report_blocked` and `list_push_devices` columns; `advisor.test.sql`; `management_api.test.sql` (push POST twice succeeds; `enabled` PATCH); `account_delete.test.sql`.
- [ ] `supabase db reset && supabase test db`; `scripts/smoke-test.sql`; `npm run supabase:types` and commit `database.types.ts`.
- [ ] Commit `Push destinations: many per account with picked devices, templates and delivery settings`.

### Task 4: Worker and send-test

**Files:** `supabase/functions/_shared/delivery/types.ts`, `format.ts`, `send.ts`, `handlers/deliver.ts`, `handlers/test_delivery.ts`, their tests, `docs/WEBHOOKS.md` (only if `DeliverySpot` changes for webhooks: it must not; the push fields are push-only and stripped before a webhook payload).

- [ ] `types.ts`: `DeliveryDestination.push?: PushSettings`; `DeliverySpot` gains optional `push_title`, `push_body`, `push_url`, `push_source_url`, `quiet_now`. `PushNotification` gains `sourceUrl?`, `actions?`, `silent?`, `renotify?`. `webhookPayloads` strips the `push_*` and `quiet_now` keys so webhook consumers see the documented shape (test it).
- [ ] `format.ts`: `pushNotifications(spots, settings)` uses `push_title`/`push_body`/`push_url` from SQL; tag `spot:<CALL>` when `replace_same_station`, else `spot:<CALL>:<id>`; `actions` when `action_buttons` (the source button only when `push_source_url` is set); `silent` when `!sound` or `quiet_now && quiet_mode === "silent"`; `renotify = !silent`. Spots with `quiet_now && quiet_mode === "skip"` are dropped from the list and the handler marks them sent. The summary keeps the spec's fixed text and uses the destination's tap target for its URL. The worst-case payload size test stays under 3,000 bytes with both actions.
- [ ] `send.ts`: `Urgency` and `TTL` from `destination.push` (defaults as today when absent, so a row claimed before the migration still sends). `sendPush` returns `skipped: number[]` for quiet-skipped deliveries.
- [ ] `deliver.ts`: the push max age is `ttl_seconds * 1000` per destination; skipped deliveries go through `mark_deliveries_sent` without a request.
- [ ] `test_delivery.ts`: devices come from `push_destination_devices` for that destination (not the owner's); body `{destination_id, spot_id?}`; with `spot_id` it loads that `raw_spots` row (owner check not needed: spots are public data; the preview RPC already renders it) and renders through `preview_push_notification` using the service client, so the test shows the saved template. Without, `push_sample_spot()`.
- [ ] Tests: `delivery_format.test.ts` (templates from SQL pass through, tags on/off, actions, silent, skip), `delivery_send.test.ts` (urgency and TTL headers per destination), `handlers_deliver.test.ts` (per-destination max age, skipped marked sent), `handlers_test_delivery.test.ts` (members only, `spot_id`). `function_config.test.ts` stays green.
- [ ] `deno task coverage`, `deno task check`, `deno task lint`.
- [ ] Commit `Push delivery: rendered templates, urgency, TTL, quiet hours and action buttons per destination`.

### Task 5: Docs and PR 3

- [ ] `docs/ARCHITECTURE.md`: the push path (editor → `save_push_destination` → `claim_deliveries` renders → `sendPush` → service worker → tap target). `docs/OPERATIONS.md`: the new tables in the Push section's queries. `docs/API.md` from Task 3.
- [ ] `npm run test:all` against a reset stack. Commit, push `push-schema-2`, open PR 3. PR text: merging applies the migration to hosted; existing push destinations keep their devices and get defaults; `deliver`, `send-test` and `api` must be redeployed after merge (Brad's step), since the GitHub integration doesn't redeploy changed functions.

---

## Part 3: API module, push state, card grid and type picker (PR 4 draft, branch `push-ui`)

### Task 6: `api.ts` and `pwa/push.ts`

**Files:** `web/src/lib/api.ts` (+ test), `web/src/pwa/push.ts` (+ test), `web/vite.config.ts`.

- [ ] `api.ts`: `DestinationType` gains `"push"`; `createDestination(type, name, url: string | null)`; `updateDestination` gains `enabled`; `Destination` gains `enabled`. New: `registerPushDevice({endpoint, p256dh, auth}, label, agent, standalone) → deviceId`, `unregisterPushDevice(endpoint)`, `listPushDevices(currentEndpoint)`, `deletePushDevice(id)`, `renamePushDevice(id, label)`, `reportPushDeviceBlocked(endpoint)`, `savePushDestination(input) → id`, `getPushDestination(id)`, `duplicateDestination(id) → id`, `previewPushNotification(title, body, spotId | null)`, `sendTest(id, spotId?)`. `signOut(scope, cleanup?)` runs `cleanup` first, best effort. Types `PushDevice`, `PushSettings`, `PushDestinationInput` live here (the settings shape mirrors `push_destination_settings` from `database.types.ts`).
- [ ] `vite.config.ts`: `VITE_VAPID_PUBLIC_KEY` from `VITE_VAPID_PUBLIC_KEY` / `VAPID_PUBLIC_KEY` / `LONGLINES_VAPID_PUBLIC_KEY`, with a warning when empty.
- [ ] `push.ts` with an injectable `PushEnv`: `pushSupport()` → `unsupported | ios-needs-install | denied | off | on`; `enablePush(label)` with `Notification.requestPermission()` as its first statement, then `serviceWorker.ready`, `subscribe`, `registerPushDevice(keys, label, deviceAgent(), isStandalone())`, remembering the endpoint in `localStorage` (try/catch); `disablePush()`; `currentEndpoint()`; `refreshPushRegistration()` (re-register when granted and subscribed; when `denied` and a remembered endpoint exists, `reportPushDeviceBlocked`); `deviceAgent()` → "{Browser} on {Platform}" from `userAgentData` with a UA fallback and "This browser" default; `isStandalone()`; `isIos()`.
- [ ] Tests: every wrapper's RPC name and arguments; `signOut` still signs out when cleanup rejects; every `pushSupport` state; the permission-before-await order; denied → report blocked; `deviceAgent` for Chrome/Android, Safari/iPhone, Firefox/Linux, Edge/Windows, fallback.
- [ ] Commit `Push: api wrappers, browser push state and the VAPID public key define`. Push `push-ui`, open PR 4 as a draft.

### Task 7: Destinations as a card grid

**Files:** `web/src/destinations/DestinationsPage.tsx` (+ test), `web/src/destinations/DestinationCard.tsx` (new), `web/src/destinations/HealthChip.tsx`.

- [ ] Replace the `List` with a `Grid` of `Card variant="outlined"` (two columns from `md`, one below), following page 1 for Discord and webhook cards and page 5 for push cards: header row with the name (`h6`) and a chip; the type line (`typeLabel`); for Discord/webhook the masked URL in a monospace `Paper variant="outlined"`; for push the device chips (`Chip size="small" variant="outlined"`, blocked ones `color="error"` with " (blocked)" in the label); the meta line "used by {N} subscription(s) · Last delivery {age} ago" / "Never used" / "Last delivery failed {age} ago" from `last_success_at`/`last_error_at`; a `Divider`; `CardActions` with Send test, [push: Edit, Duplicate], Delete (disabled with tooltip "Used by {N} subscriptions. Remove it from them first.").
- [ ] Push card chip: `HealthChip` as today, except when any member device is blocked: `Chip color="warning" label="{N} device(s) blocked"`. Devices per card come from one `listPushDevices()` call on the page (their `destination_ids`), never per card.
- [ ] Alerts above the grid: the failing alert per page 1 ("{name} is failing" / "The last {N} deliveries returned {error}. Spots for {M} subscription(s) are not being sent. Check the URL, then send a test." with a Send test action, replacing today's single-sentence alert) and the blocked alert per page 5 ("{Device} cannot receive notifications" / "Notifications are blocked for longlines.io in {agent} on that device. Allow them in the browser site settings, or remove the device from {destination}." with Manage devices → the editor).
- [ ] Duplicate: `duplicateDestination(id)` then navigate to `/destinations/{newId}`; toast "Duplicated {name}".
- [ ] Tests: both layouts; each card type; the chips; the meta variants; Delete disabled tooltip; Duplicate navigation; both alerts.
- [ ] Commit `Destinations: card grid with push cards`.

### Task 8: Add destination as a type picker

**Files:** `web/src/destinations/DestinationDialog.tsx` (+ test), `web/src/destinations/types.ts`.

- [ ] `DEST_TYPES` gains push and the page 5 help strings for all three (Copy section); each entry gets an icon (`ForumOutlined`, `WebhookOutlined`/`Http`, `NotificationsOutlined`).
- [ ] Step 1 (page 5 `PushType`): intro sentence, three selectable cards (a `RadioGroup` whose labels are `Card variant="outlined"` rows with icon, label and help; the selected card uses the `primary` border through a prop, not `sx`), Cancel and **Continue**. Step 2 for Discord and webhook: today's Name and URL fields with **Add destination**. Continue with push selected closes the dialog and navigates to `/destinations/new?type=push`.
- [ ] Tests: picker renders three types; Continue → step 2 for Discord/webhook keeps today's assertions; Continue with push navigates (assert through `LocationProbe`).
- [ ] Commit `Destinations: pick a type, then its details`.

---

## Part 4: Push destination editor (PR 4 draft)

### Task 9: Editor page, routes, name, enabled, delivery settings

**Files:** `web/src/destinations/PushDestinationPage.tsx` (new, + test), `web/src/destinations/pushModel.ts` (new, pure, + test), `web/src/App.tsx`.

- [ ] Routes `/destinations/new?type=push` and `/destinations/:id` (a non-push id redirects to `/destinations`, like the subscription editor does for unknown ids). Layout mirrors `SubscriptionEditorPage`: `Breadcrumbs` (Destinations › New destination / {name}), `PageTitle` with Cancel and **Add destination** / **Save destination** (phones: **Save**), the Name field with helper "Names are unique…" and the taken-name error from the RPC, the Enabled `Switch`, the type `Chip` and the sentence "Filtering and repeat limits are set on each subscription. This page controls where and how notifications arrive.", then a `Grid` with `size={{xs: 12, md: 7}}` (Devices, Notification content, Delivery cards) and `size={{xs: 12, md: 5}}` sticky (Preview).
- [ ] `pushModel.ts`: the default settings (same values as `push_default_settings()`; a node test pins them against `supabase/seed.sql`'s push row or a fixture), the field list, `insertField(template, cursor, field)`, `dirty(initial, current)`, the select option lists for Urgency, Drop if offline for and During quiet hours, and `toInput`.
- [ ] Delivery card (page 5 copy): Urgency `Select`, Drop if the device is offline for `Select`, Replace the earlier notification `Switch`, divider, Sound and vibration `Switch`, divider, Quiet hours `Switch` with "Uses your account time zone, {profile.timezone}.", From/Until (`TextField type="time"`) and During quiet hours `Select`, the time row disabled while quiet hours are off.
- [ ] Save: `savePushDestination({id, name, enabled, settings, deviceIds})` → toast "Added {name}" / "Saved changes", navigate to `/destinations`. Errors through `errorText`.
- [ ] Tests: new and edit modes; redirect on a non-push id; name error; every delivery control round-trips into the saved input; phone layout.
- [ ] Commit `Destinations: push destination editor with delivery settings`.

### Task 10: Devices card, Add a device dialog, rename and remove

**Files:** `web/src/destinations/DevicesCard.tsx`, `web/src/destinations/AddDeviceDialog.tsx`, `web/src/destinations/RenameDeviceDialog.tsx` (new, + tests).

- [ ] Devices card (page 5): header "Devices" / subheader; one row per account device: `Checkbox` (`aria-label="Send to {label}"`, disabled when blocked), `PhoneIphone`/`Laptop` icon from `agent`, name with "This device" and "Blocked" chips, caption "{agent}[, installed app] · last delivery {age} ago" or "{agent} · notifications blocked in this browser" or "{agent} · no deliveries yet", Rename and Remove `IconButton`s (`aria-label="Rename device"`, `"Remove device"`), then **Add a device**. Empty state: the dashed box with "No devices yet", its sentence, **Add this device** (contained) and **Add my phone** (outlined; opens the dialog). Checked ids are the form's `deviceIds`; a newly added device is checked automatically.
- [ ] Add a device dialog (page 5 `PushDevice`): **This device** with the icon, the `{agent}` chip, the permission sentence, the Device name field (prefilled with `deviceAgent()`), **Enable notifications** → `enablePush(name)`; then a `Divider` and **Another device** with the two numbered steps and the iPhone info alert; Cancel. When `pushSupport()` is `denied`: the This device section shows the spec's denied sentence in place of the button. When `unsupported`: the spec's unsupported sentence. On phones the dialog is `fullScreen` with a close button in the title bar, as drawn.
- [ ] iPhone not installed (page 5 `PushDevice-iOS-Mobile`): the same dialog when `pushSupport()` is `ios-needs-install`: the warning alert, the three steps, the disabled **Enable notifications** button and its caption.
- [ ] Rename: a small dialog with one field, **Rename**; Remove: `deletePushDevice` with the toast "Removed {label}"; removing the current device also runs `disablePush()`.
- [ ] Tests: rows in every state; checkbox round-trip; empty state buttons; the dialog in `off`, `denied`, `unsupported` and `ios-needs-install`; Enable calls `enablePush` with the typed name and checks the new device; rename; remove current and other; phone layout.
- [ ] Commit `Destinations: devices card and the Add a device dialog`.

### Task 11: Notification content and the preview

**Files:** `web/src/destinations/NotificationContentCard.tsx`, `web/src/destinations/PushPreviewCard.tsx`, `web/src/destinations/NotificationMockup.tsx` (new, + tests).

- [ ] Notification content card (page 5): Title and Body `TextField`s in a monospace input (`slotProps.input` with the theme's monospace family, no hex), helper texts, "Insert a field" chips that insert at the cursor of the last focused field, "When tapped, open" `Select` (Callsign profile / Source site), "Show action buttons" `Switch` with its sentence, **Reset to default text**.
- [ ] Preview card: "Preview" overline, "Preview with this spot" `Select` of the last 10 recent spots from `listRecentSpots` across sources, labelled "{CALL}, {Source} {reference}, {MHz} {MODE}" (built in the web from `recent_spots` columns; this is display only, never a template render), plus "Sample spot"; `previewPushNotification(title, body, spotId)` debounced 300 ms; three `NotificationMockup` variants (android, iphone, desktop) with their captions, built from `Paper` elevation, `Avatar` and palette colours only; **Send test notification** (`variant="outlined"`, full width) with the caption rules from decision 10, calling `sendTest(id, spotId)`.
- [ ] Tests: field insertion, reset, tap target and action switch round-trip; the preview RPC is called with the typed templates and the chosen spot, and the mock-ups show its result; the Send test states (new, dirty, saved).
- [ ] Commit `Destinations: notification content and live preview`.

---

## Part 5: Install, refresh on load, docs and the end-to-end check (PR 4 ready)

### Task 12: Install app, refresh, sign-out cleanup

**Files:** `web/src/pwa/install.ts` (+ test), `web/src/layout/InstallDialog.tsx`, `web/src/layout/AppShell.tsx` (+ test), `web/src/account/AccountPage.tsx`, `web/src/app/AppContext.tsx`, `web/src/pwa/register.ts`, `web/src/main.tsx`.

- [ ] `install.ts`: capture `beforeinstallprompt` from `main.tsx` before render; `installState()` → `prompt | ios | none`; `promptInstall()`; a subscribe/notify pair so the menu re-renders.
- [ ] AppShell: **Install app** between Account and Sign out when state isn't `none`; `ios` opens `InstallDialog` (spec Copy: "Install Long Lines", three steps, Done).
- [ ] With a session, call `refreshPushRegistration()` once per load (reports blocked when denied). `register.ts` listens for `push-subscription-changed` and calls it again.
- [ ] Every local sign-out (`AppShell`, both in `AccountPage`) passes `pushCleanup` (a `disablePush` that resolves even when push is unsupported); "Sign out others" passes nothing.
- [ ] Tests for each.
- [ ] Commit `Install app, re-register on load and on subscription change, unregister on sign out`.

### Task 13: Docs, rules, gates and end to end

- [ ] README: `dev:full` needs the three `LONGLINES_VAPID_*` lines in `supabase/functions/.env` and `LONGLINES_VAPID_PUBLIC_KEY` in `web/.env.local`. OPERATIONS: the Vercel `VAPID_PUBLIC_KEY` step. ARCHITECTURE: the browser side. CLAUDE.md: the push rules from Task 0 are already in; add the web ones from Global Constraints if Task 0 didn't. Spec: Status → shipped.
- [ ] Gates: `npm run coverage`, `npm run build` (`dist/sw.js` check), `npm run lint`, `npm run test:all` on a reset stack.
- [ ] End to end on the local stack with generated VAPID keys:
  1. Desktop Chrome at `localhost:5173`: Add destination → Push notification → Continue → the editor. Add this device → Enable notifications → the device appears checked with "This device". Save. The card shows the device chip and "Never used".
  2. Edit → Send test notification with the sample spot: the notification shows the default template ("N0CALL on 14.062 CW" / "POTA US-0000, Test Park. Spotted by LONGLINES."); clicking opens `/call/N0CALL`; the Open on POTA action opens the park page.
  3. Change the title template, watch the preview update, save, Send test again: the new title.
  4. Quiet hours on, From/Until around now, Send silently: `npm run db:match` and `npm run invoke:deliver` against a seeded subscription deliver silent notifications; Don't send marks them sent with no notification.
  5. A second push destination with the same device, a different template: both arrive. Duplicate → "Copy of …" disabled.
  6. Revoke the permission in Chrome, reload: the device shows Blocked, the alert appears; deliver: the device is skipped.
  7. Sign out: the device row is gone.
- [ ] On a Vercel preview with Brad's steps done: Chrome's Installable audit, Android, and an iPhone after Add to Home Screen (the not-installed screen first, then the real flow).
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
- Notification content card: Notification content · Write the title and body using fields from the spot
  - Title helper: Shown in bold. Phones cut off long titles.
  - Body helper: A field the spot does not have is left out. place_name is the park or summit.
  - Insert a field; chips: {callsign} {frequency} {band} {mode} {source} {reference} {place_name} {state} {spotter} {comment} {time}
  - When tapped, open: Callsign profile · Source site
  - Show action buttons · Open profile, Open on the source site.
  - Button: Reset to default text
  - Default title: {callsign} on {frequency} {mode}; default body: {source} {reference}, {place_name}, {state}. Spotted by {spotter}.
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

- #158 (per-device retry) stays open; the 15-to-240-minute TTL window makes it low priority.
- Discord and webhook editors (page 1 shows none), the Connections rename (page 3), and any change to notification shaping beyond what page 5 draws.
- Device management through the Management API.

## Prompts: one per part

Paste the part's block into a new Claude Code session. Each session reads only what its part needs.

### Part 0 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web. Run `git fetch origin` and `git switch -c push-spec-2 origin/main`.

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: the sections "What page 5 changes against the approved spec", "Decisions needed", "Copy", and Task 0. Then read docs/superpowers/specs/2026-10-13-push-notifications-design.md and the "Push rules" section of CLAUDE.md.

Do Task 0 only: the spec amendment and the CLAUDE.md push rules. My answers to the decisions are below; where I say nothing, use the plan's proposal and mark it "proposed" in the spec.

Decisions:
<paste answers here, numbered 1–16>

Write no code. Commit as "Spec: push destinations follow canvas page 5", push with `git push -u origin push-spec-2`, and open the PR with `gh pr create --base main`. Tick Task 0's boxes in the plan in the same commit. Don't merge.
```

### Part 1 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web on branch push-pwa (it exists; `git fetch origin && git merge origin/main` first).

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", decisions 13–15, and Tasks 1–2. Read the "Push rules" and "Web app rules" sections of CLAUDE.md. Read the spec's "PR 2: PWA shell" section only for background; the plan wins where they differ.

Do Tasks 1 and 2 in order, one commit each, ticking the boxes in the plan. No new dependency; no file generated at build time. Run the gates in the plan (`npm run coverage`, `npm run build` with the dist/sw.js check, `npm run lint`, then `npm run test:all` once). Run /code-review before opening the PR and fix what it finds.

Push with `git push -u origin push-pwa` and open PR 2 with `gh pr create --base main`, PR text per the plan's "Branches and PRs". Don't merge.
```

### Part 2 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web. Run `git fetch origin`. If the spec PR (branch push-spec-2) is merged, `git switch -c push-schema-2 origin/main`; otherwise `git switch -c push-schema-2 push-spec-2` and say in the PR text that it is stacked.

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Decisions needed" (use the answers recorded in the spec amendment), and Tasks 3–5. Read the spec's 2026-10-15 amendment and its PR 1 section, CLAUDE.md in full, supabase/migrations/20261014000100_push_destinations.sql, and supabase/tests/push_devices.test.sql.

Do Tasks 3, 4 and 5 in order, one commit each, ticking the boxes. Recheck the migration number against every worktree and remote branch before creating it. Never edit an applied migration. Gates: `deno task coverage`, `deno task check`, `deno task lint`, `supabase db reset && supabase test db`, `scripts/smoke-test.sql`, `npm run supabase:types`, then `cd web && npm run test:all`. Run /code-review before opening the PR.

Push with `git push -u origin push-schema-2` and open PR 3 with `gh pr create --base <main or push-spec-2>`. The PR text must say the merge applies the migration to hosted and that deliver, send-test and api need redeploying afterwards. Don't merge, push, deploy or set secrets.
```

### Part 3 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web. Run `git fetch origin`. If PRs 2 (push-pwa) and 3 (push-schema-2) are both merged, `git switch -c push-ui origin/main`; otherwise branch from the unmerged one (or merge the other into it first) and say in the PR text what it is stacked on.

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Copy", and Tasks 6–8. Read CLAUDE.md's "Web app rules", "Push rules" and "Testing" sections, web/src/lib/api.ts, web/src/destinations/, web/src/subscriptions/SubscriptionEditorPage.tsx (for the page pattern only), and web/src/test/render.tsx. Canvas page 5 is already transcribed in the plan's Copy section; don't read the canvas.

Do Tasks 6, 7 and 8 in order, one commit each, ticking the boxes. Copy word for word from the plan's Copy section ("subscription", never "connection"). Gates after each task: `cd web && npm run coverage`, `npm run build`, `npm run lint`.

Push with `git push -u origin push-ui` and open PR 4 as a draft (`gh pr create --draft --base <base>`). Don't merge.
```

### Part 4 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web on branch push-ui (`git fetch origin && git merge origin/main` first if main moved).

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Copy", decisions 4–11, and Tasks 9–11. Read CLAUDE.md's "Web app rules", "Push rules" and "Testing" sections, web/src/lib/api.ts (the push wrappers Part 3 added), web/src/destinations/, web/src/subscriptions/SubscriptionEditorPage.tsx, and web/src/lib/database.types.ts for push_destination_settings.

Do Tasks 9, 10 and 11 in order, one commit each, ticking the boxes. The web never renders a template: previews come from the preview_push_notification RPC. Mock-ups use Paper elevation and palette colours, never hex. Gates after each task: `cd web && npm run coverage`, `npm run build`, `npm run lint`.

Push to origin push-ui. PR 4 stays a draft. Don't merge.
```

### Part 5 prompt

```
Work in the worktree /home/brad-bazemore/Dev/longlines-push-web on branch push-ui (`git fetch origin && git merge origin/main` first if main moved).

Read docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md: "Global Constraints", "Review Focus", "Brad's steps", decisions 12–13, and Tasks 12–13. Read CLAUDE.md's "Push rules" and "Web app rules", web/src/pwa/, web/src/layout/AppShell.tsx, web/src/account/AccountPage.tsx and web/src/app/AppContext.tsx.

Do Tasks 12 and 13 in order, one commit each, ticking the boxes. For the end-to-end steps, generate local VAPID keys with `deno run scripts/generate-vapid-keys.ts mailto:test@example.com` into supabase/functions/.env and web/.env.local (both are gitignored) and run `npm run dev:full`. Record in the PR text exactly which end-to-end steps you ran and which you couldn't. Run the full gates in Task 13 and /code-review, fix what it finds.

Push to origin push-ui and run `gh pr ready`. Don't merge. Never run supabase secrets set, functions deploy, db push, fly deploy or vercel.
```
