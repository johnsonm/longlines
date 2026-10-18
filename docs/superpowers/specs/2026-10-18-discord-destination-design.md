# Discord destination editor: design

Date: 2026-10-18. Status: **Decisions 1 to 11 agreed with Brad while planning (2026-10-18). This
spec, its proposed decisions 12 to 15 and its Copy section are waiting for his review.** No code
ships until he approves it. Items marked *proposed* need an explicit yes. If the design changes
during a PR, update this file in that PR.

Source: page 8 of Brad's design canvas, "Discord destination (draft)", artboards
`DiscordList-Desktop`, `DiscordEdit-Desktop` (card style), `DiscordEditPlain-Desktop` (plain line),
`DiscordNew-Desktop` (invalid URL) and `DiscordEdit-Mobile`. Where the canvas and this file disagree,
this file wins; the differences are listed under Decisions.

## Purpose

Today a Discord destination is created in step 2 of the Add destination dialog (a name and a URL)
and can never be edited in the app: its card has no Edit button, and `/destinations/:id` sends a
Discord id back to the list. Its message is one fixed embed built in TypeScript (`embedForSpot`,
`_shared/delivery/format.ts`): the callsign as title, "14062.0 kHz CW (20m)" as description and
inline fields Reference, Park, Summit, WWFF, Reserve, Source, Spotter and Time. It has no color, no
link, no footer, and no `allowed_mentions`.

Page 8 gives Discord a full-page editor like push's (page 5): per-destination message settings (a
card or a plain line, ordered field picks, separator, field names, footer, title link, card color),
Replace URL, timed grouping of spots into one message, a live Discord-styled preview, and Send test
with a chosen spot. Webhooks (page 7) are not part of this work.

The model is push's (#211, #212): a settings table with a defaults trigger, text rendered in SQL and
carried in the claim's jsonb, a preview RPC and a service-role test RPC that call the same renderer,
a sender that only shapes what SQL rendered, and an editor whose pure model is pinned to SQL's
defaults by a test.

## Decisions

1. **A full-page editor** at `/destinations/new?type=discord` and `/destinations/:id`, the same
   skeleton as the push editor. The Add destination dialog's Continue goes there for Discord; step 2
   of the dialog stays for webhooks only. *Decided 2026-10-18.*
2. **Settings live in `discord_destination_settings`**, one row per Discord destination (RLS on, no
   policies, no client grants), created with defaults by a trigger and backfilled for existing
   destinations. *Decided 2026-10-18.*
3. **Two styles**, `card` and `plain`. They share `separator` and `show_field_names`; each keeps its
   own field lists, so switching styles loses nothing. *Decided 2026-10-18.*
4. **Fields, not templates**, as push decision 4: the push field set minus Comment (callsign,
   frequency, band, mode, source, reference, place_name, state, spotter, time), each with push's
   fixed rendering and display name. Comment is excluded because it is text typed by the spotter.
   Limits: title 1 to 4, details 0 to 8, small grid 0 to 6, plain line 1 to 8, each field once per
   list. *Decided 2026-10-18.*
5. **SQL renders everything** (`discord_spot_fields`). The preview, Send test and real deliveries
   call the same function. The sender builds an embed or a content line from SQL's keys and never
   joins or formats fields. *Decided 2026-10-18.*
6. **Mentions are always off.** Every message carries `allowed_mentions: {parse: []}`. Users cannot
   add text or markup. *Decided 2026-10-18.*
7. **Card color is a named palette.** By source (POTA green, SOTA purple, WWFF teal, DX Cluster blue,
   RBN orange, anything else grey), or one of Blue, Green, Purple, Orange, Red, Grey for every spot.
   No color input. The integers are fixed in SQL. *Decided 2026-10-18.*
8. **Timed grouping is a claim knob.** `batch_seconds` in {0, 10, 30, 60}. With a window,
   `claim_deliveries` skips a Discord destination until its oldest visible delivery is that old or
   ten are waiting; held rows keep their vt and are never dropped or delayed by anything else. With
   0 each spot is its own message. The budget stays `destination_budget('discord')`, 300 spots a
   minute. When a cycle's claim would need more than Discord's 30 messages, the sender groups spots
   (up to ten per message) so the per-run cap is never hit, which is what the canvas alert promises.
   *Decided 2026-10-18.*
9. **Auto-pause is deferred.** The canvas draws "Pause this destination after repeated failures"
   (20 in a row, with an email). Nothing sets `health = 'paused'` today and the system has no email
   path, so the row is not built. The Delivery card ships with the Messages select and the rate-limit
   note. *Decided 2026-10-18.*
10. **Replace URL.** The edit page shows the masked URL and a Replace URL button, which opens an
    empty Webhook URL field. Saving with the field empty keeps the stored URL. A new URL goes through
    `validate_destination_url` and clears failing health, as `update_destination` does.
    *Decided 2026-10-18.*
11. **Duplicate works for Discord.** It copies the URL and the settings, starts disabled, and is
    named "Copy of {name}" by the rule push already uses. *Decided 2026-10-18.*
12. *Proposed:* **The plain line links the callsign.** The callsign is a masked link to its profile,
    `[KK4PWJ](https://app.longlines.io/call/KK4PWJ)`, and "Link preview: Hidden" sends Discord's
    SUPPRESS_EMBEDS flag (`flags: 4`) so the link does not expand. Without a link the Link preview
    control has nothing to act on. The card style never sends the flag, since it would hide the card.
13. *Proposed:* **Messages select labels:** One message per spot · Group spots every 10 seconds ·
    Group spots every 30 seconds · Group spots every 60 seconds. The canvas draws only the first
    label and the helper.
14. *Proposed:* **A test is marked in SQL.** The card footer becomes "Test message from Long Lines ·
    POTA · 17:42 UTC" (just "Test message from Long Lines" when the footer is off), and the plain line
    starts "Test message from Long Lines · ".
15. *Proposed:* **Links are absolute** through one knob, `app_site_url()` = `https://app.longlines.io`
    (the Site URL in `docs/OPERATIONS.md`). Push's tap URL is a path; Discord needs a full URL.

## Schema (migration `20261018000100_discord_destinations.sql`)

- `discord_fields()` = `push_fields()` minus `comment`; `discord_fields_valid(fields, min, max)`
  mirrors `push_fields_valid`; `app_site_url()`.
- `discord_destination_settings`: `destination_id` (pk, cascades), `style`, `title_fields`,
  `detail_fields`, `grid_fields`, `title_link` (profile, source, none), `card_color` (source, blue,
  green, purple, orange, red, grey), `footer`, `line_fields`, `bold_first`, `link_preview` (hidden,
  shown), `show_field_names`, `separator` (dot, comma, newline), `batch_seconds` (0, 10, 30, 60).
  All not null, with check constraints.
- `discord_default_settings()`: card; title Callsign, Frequency, Mode; details Source, Reference,
  Place name, State; grid Band, Spotter; title links to the profile; color by source; footer on;
  plain line Callsign, Frequency, Mode, Source, Reference, Place name; bold first on; link preview
  hidden; field names off; separator a dot; one message per spot.
- Trigger `destinations_discord_settings` inserts the defaults for a new Discord destination; the
  migration backfills existing ones.
- `validate_discord_fields` / `validate_discord_settings` raise the Errors in Copy.
- Client RPCs (`authenticated`): `save_discord_destination(p_id, p_name, p_enabled, p_url,
  p_settings)` (creates through `create_destination`, updates through `update_destination`, merges
  and validates settings), `get_discord_destination(p_id)` (never the URL, only `url_display`),
  `list_discord_destination_settings()` (style and field count per destination, for the list
  cards), `preview_discord_message(p_settings, p_spot_id)`.
- Service role: `discord_test_delivery(p_destination_id, p_spot_id)` for `send-test` and the API.
- `duplicate_destination` accepts Discord; `api_destination_json` gains a read-only `discord` object.
- `claim_deliveries` keeps its signature and result columns. It gains the batch hold and attaches
  `discord` (settings) to the destination jsonb and the nine `discord_*` keys to the spot jsonb of
  Discord rows.

## Rendering

`discord_spot_fields(settings, spot)` always returns nine keys, reusing push's field renderers:

| Key | Content |
| --- | --- |
| `discord_style` | card or plain |
| `discord_title` | title fields joined by the separator, the callsign when empty, at most 256 characters |
| `discord_description` | detail fields, labels when field names are on, at most 4096 |
| `discord_grid` | `[{name, value}]` per grid field, name the field label, value at most 1024 |
| `discord_footer` | "POTA · 17:42 UTC", or null when the footer is off |
| `discord_color` | the integer of decision 7 |
| `discord_url` | the profile, the source page (profile when the source has none), or null |
| `discord_line` | the plain line of decision 12, first field bold when bold first is on, at most 190 so ten lines fit in 2000 |
| `discord_suppress_embeds` | true only for plain style with link preview hidden |

A field a spot lacks is skipped. Discord renders markdown in values; fields are structured and
Comment is excluded, so nothing is escaped at first. If a name with `_` or `*` misrenders, the
escaping goes in SQL.

## Sender

- `discordBatches(spots, destination)` builds the messages: one card embed or one line per spot, one
  spot per message when `batch_seconds` is 0, ten otherwise, and more per message only when needed
  to stay within `DISCORD_MESSAGES_PER_RUN`. Plain lines go in `content`, joined by a newline (a
  blank line when the separator is a new line).
- A claim without the `discord` key uses the old `embedForSpot` path, so the sender and the migration
  ship in either order. That path goes once the migration is hosted.
- `sendDiscord` counts `sent` by spots per message. `wait=false`, the cap, the timeout, redirect
  refusal and 429 handling are unchanged.
- `send-test` calls `discord_test_delivery` for Discord, as it calls `push_test_delivery` for push,
  so it sends a chosen spot instead of the TypeScript sample. Webhooks keep the sample.

## Web

- Routing by type in `DestinationRoute`; a new `DiscordDestinationPage` with the cards Discord
  channel, Message, Delivery and Preview.
- The field picker moves out of `NotificationContentCard` as a generic `FieldPicker`; the list
  helpers move to a generic `fieldList.ts`.
- `discordModel.ts` holds the field list, limits, defaults (pinned to `discord_default_settings()` by
  a test), options, the form shapes and the Send test blocker.
- The preview is a Discord dark-theme mock-up of SQL's keys, with a tiny renderer for `**bold**` and
  `[text](url)` only.
- Destination cards get Edit and Duplicate for Discord and the type line from
  `list_discord_destination_settings`.
- The dead `updateDestination` in `api.ts` is removed (its RPC was never granted to clients).

## PR order

1. **This spec** (branch `discord-spec`). Brad reviews it before any code.
2. **Schema and sender** (branch `discord-schema`): migration, pgTAP, `format.ts`, `send.ts`,
   `types.ts`, `test_delivery.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`. A merge deploys the sender.
   Brad then runs `supabase db push` and deploys `send-test` and `api`, in that order. Existing
   Discord destinations change look at the push: a colored card with a band and spotter grid and a
   footer, one spot per message until a window is picked.
3. **Web** (branch `discord-ui`), once PR 2's migration is on hosted. It ends with a CLAUDE.md
   "Discord rules" section and this spec marked shipped.

## Verification

- Schema and sender: `deno task test`, `check`, `lint`, `fmt`; `supabase db reset` and
  `supabase test db` (a new `discord_destinations.test.sql`, the hold cases in
  `deliveries_rpc.test.sql`, the advisor list); `scripts/smoke-test.sql`; the sender's db test. By
  hand: `send-test` to a local receiver, checking `allowed_mentions`, the embed's color, footer and
  URL, and the plain `content` and `flags`.
- Web: `npm run test:all`, `build`, `lint`; then in `dev:full`, add a Discord destination through the
  new page, see the invalid-URL helper, save, check the card's type line, replace the URL, switch to
  plain line, duplicate, and compare phone width with `DiscordEdit-Mobile`.
- After the hosted push: Send test to a real channel; a 30-second window groups spots, 0 sends one
  message per spot.

## Out of scope

- Auto-pause after repeated failures and its email (decision 9).
- The webhook editor (page 7).
- Changing Discord settings through the management API; it reads them only, like push's.

## Copy

Use these word for word. "KK4PWJ" becomes the signed-in callsign; `{…}` marks a value. Anything not
listed comes from the push spec's Copy.

**Destinations page**
- Card type line: Discord channel · Card · {N} fields | Discord channel · Plain line · {N} fields
- Card: the masked URL in a code block; meta as today; actions Send test · Edit · Duplicate · Delete
- Toasts: Added {name} · Saved changes · Duplicated {name} · Test spot sent to {name}

**Discord destination editor**
- Breadcrumb: Destinations › New destination | {name}
- Titles: New destination · Edit destination; buttons: Cancel · Add destination | Save destination (phones: Save)
- Name helper: Names are unique. A name can be reused after the destination that has it is deleted.
- Switch: Enabled
- Type chip: Discord channel · Sentence: Filtering and repeat limits are set on each connection. This page controls what the Discord message looks like.
- Discord channel card: Discord channel · Where messages are posted
  - Edit: the masked URL · button Replace URL · Treat the URL like a password. Anyone who has it can post to the channel. It is hidden after saving.
  - New or replacing: field Webhook URL · error helper: That is a channel link, not a webhook URL. A webhook URL starts with https://discord.com/api/webhooks/
  - Box: Get a webhook URL from Discord · 1. Open the channel settings and choose Integrations. · 2. Choose Webhooks, then New Webhook. · 3. Copy the webhook URL and paste it here.
  - Sentence: Treat the URL like a password. Anyone who has it can post to the channel.
- Message card: Message · Choose the style, then which fields appear and in what order.
  - Message style: Card · A colored card with a title, details and a small grid. Easiest to scan. | Plain line · One line of text, like a chat message. Takes the least space.
  - Card lists: Title · Shown in bold at the top of the card. | Details · Shown under the title. | Small grid · Short values shown side by side under the details. Leave empty for no grid.
  - Plain list: Message · Place name is the park or summit.
  - Rows numbered 1, 2, 3…; row buttons: Move {field} up · Move {field} down · Remove {field}
  - Under each list a select: Add a field · placeholder Choose a field; field names: Callsign · Frequency · Band · Mode · Source · Reference · Place name · State · Spotter · Time
  - Card selects: Title links to (Callsign profile · Source site · Nothing) · Or the spot on the source site, or nothing. | Card color (By source · Blue · Green · Purple · Orange · Red · Grey) · POTA green, SOTA purple and so on. Or one color for all. | Separate fields with (A dot · A comma · A new line)
  - Card switches: Show field names in details · Adds a label before each value, such as State: NC. | Footer with source and time · For example POTA, 17:42 UTC.
  - Plain: Separate fields with (A dot · A comma · A new line) | Bold the first field · Makes the callsign stand out in a busy channel. | Show field names · Adds a label before each value, such as State: NC. | Link preview (Hidden · Shown) · Stops Discord from expanding links in the message.
  - Sentences: Messages can only contain the fields chosen above. You cannot add your own text or markup. Mentions such as @everyone are always turned off. · If a spot does not have a field, that field is skipped. Comment is not available here, because it is text typed by the spotter.
  - Button: Reset to default fields
- Delivery card: Delivery · How messages are sent
  - Messages (decision 13) · Or group spots into one message every 10, 30 or 60 seconds, up to 10 spots each.
  - Info alert: Discord allows about 30 messages a minute per webhook. If a connection is busier than that, spots are grouped automatically so none are dropped.
- Preview card: Preview · Preview with this spot (Sample spot, then recent spots)
  - Mock-up: author Long Lines with an APP badge and the time
  - Caption: Shown in Discord dark theme. Light theme and mobile follow the viewer's settings.
  - Button: Send test message; captions: Posts this example to the channel, marked as a test. | Add a webhook URL to send a test. | Save your changes to send a test.

**Errors**
- Use a Discord webhook URL. (exists)
- A destination named {name} already exists. Choose a different name. (exists)
- Give the destination a name. · Destination not found. · Spot not found. · Unknown setting {key}.
- Unknown field {name}. · Comment is not available here. · Pick each field once.
- Pick 1 to 4 fields for the title. · Pick up to 8 fields for the details. · Pick up to 6 fields for the grid. · Pick 1 to 8 fields for the message.
