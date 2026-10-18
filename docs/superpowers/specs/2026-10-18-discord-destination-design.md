# Discord destination editor: design

Date: 2026-10-18. Status: **Decisions 1 to 15 accepted: the spec PR (#215) merged 2026-10-18
without changes. PR 2 (schema and sender) is in progress.** Its review changed the design in three
places, recorded below: values are escaped for Discord markdown (Rendering), a Discord destination
is claimed on average every 10 seconds, at most 50 spots a claim (decision 8), and the sender sends
at most five messages a claim (unless ten cards pass 6,000 characters) and no embed timestamp
(Sender). If the design changes during a PR, update
this file in that PR.

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
   0 each spot is its own message. The rate stays `destination_budget('discord')`, 300 spots a
   minute. *Decided 2026-10-18.* Amended in PR 2's review: one spot per message made the 300-spot
   budget allow up to 300 messages a minute against Discord's 30 (and its 5 requests per 2 seconds
   per webhook), so the limit is now kept per minute in SQL. A new knob
   `destination_claim_max(type)` (Discord 50, five messages of ten; others none) caps one claim,
   `destination_budget('discord')`'s burst is 100 (two claims' worth, so a claim `p_limit` cut
   short or a long gap keeps its tokens), and a new knob `destination_claim_interval(type)`
   (Discord 10 seconds, other types none) paces claims on a schedule: each claim moves
   `destinations.claim_due_at` on by the interval from where it was (from now when that is past),
   and a destination may be claimed from half an interval before it is due. The sender claims
   only when it polls (5 s after a cycle), so a plain "10 s since the last claim" would take every
   other poll and sustain only 3,000 / (10 + 2 x cycle seconds) spots a minute (about 250); the
   schedule averages one claim per 10 s whatever the poll and never two within 5 s. The sender
   sends at most five messages a claim (`DISCORD_MESSAGES_PER_CLAIM`), grouping spots up to ten
   per message when a claim holds more than five. Six claims of five messages are Discord's 30 a
   minute, and 300 spots still fit, so a busy connection is grouped, not dropped, which is what the
   canvas alert promises. Poll timing can put a seventh claim in some 60 s window (35 messages);
   a 429 then throttles like any other rate limit, and nothing is lost. The per-run cap
   (`DISCORD_MESSAGES_PER_RUN`, 30) stays as a safety net the claim keeps unreachable.
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
12. **The plain line links the callsign.** The callsign is a masked link to its profile,
    `[KK4PWJ](https://app.longlines.io/call/KK4PWJ)`, and "Link preview: Hidden" sends Discord's
    SUPPRESS_EMBEDS flag (`flags: 4`) so the link does not expand. Without a link the Link preview
    control has nothing to act on. The card style never sends the flag, since it would hide the card.
    A call that is not letters, digits, `/` and `-` gets no link (Rendering). *Decided 2026-10-18.*
13. **Messages select labels:** One message per spot · Group spots every 10 seconds ·
    Group spots every 30 seconds · Group spots every 60 seconds. The canvas draws only the first
    label and the helper. *Decided 2026-10-18.*
14. **A test is marked in SQL.** The card footer becomes "Test message from Long Lines ·
    POTA · 17:42 UTC" (just "Test message from Long Lines" when the footer is off), and the plain line
    starts "Test message from Long Lines · ". The marked line keeps the line's 190 characters: the
    line is rendered with the marker's 31 taken off its budget, so it never nears Discord's 2,000.
    *Decided 2026-10-18.*
15. **Links are absolute** through one knob, `app_site_url()` = `https://app.longlines.io`
    (the Site URL in `docs/OPERATIONS.md`). Push's tap URL is a path; Discord needs a full URL.
    *Decided 2026-10-18.*

## Schema (migration `20261018000100_discord_destinations.sql`)

- `discord_fields()` = `push_fields()` minus `comment`; `discord_fields_valid(fields, min, max)`
  mirrors `push_fields_valid`; `app_site_url()`.
- Knobs: `destination_claim_interval(type)` (Discord 10 seconds, others none) and
  `destination_claim_max(type)` (Discord 50, others none) are new, `destination_budget` is
  replaced with Discord's burst at 100, and `destinations.claim_due_at` (not in the client column
  grant) holds the claim schedule (decision 8).
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
- `validate_discord_fields(p_fields, p_what)` / `validate_discord_settings(p_settings)` raise the
  Errors in Copy; `check_discord_setting_keys(p_settings jsonb)` raises "Settings must be an
  object." and "Unknown setting {key}." before either, for save and preview.
- Rendering helpers (see Rendering): `discord_escape(text)`, `discord_clip(text, max)`,
  `discord_profile_url(spot)`, `discord_source_color(source)`, `discord_color(settings, spot)`,
  `discord_footer(spot)`, `discord_field_values(p_spot)`, `discord_join(p_fields, p_values,
  p_separator, p_labels)`, `discord_grid(p_fields, p_values)`, `discord_title_url(settings, spot)`,
  `discord_plain_line(p_settings, p_values, p_spot, p_max default 190)` and
  `discord_spot_fields(settings, spot)`. All are service role only.
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

`discord_spot_fields(settings, spot)` always returns nine keys, reusing push's field renderers.
It renders each field once: `discord_field_values(p_spot)` calls `render_push_field` for every
Discord field, escapes the value and returns `{field: text}` without the fields the spot lacks;
`discord_join`, `discord_grid` and `discord_plain_line` pick from that jsonb. They are plpgsql
loops over the one rendering, not `render_push_fields` per list, because the claim renders every
Discord spot at claim time (up to 300 a minute) and rendering once per spot costs a fraction of
rendering per list. `discord_field_values`, `discord_grid`, `discord_spot_fields` and
`discord_test_delivery` are `stable`, since `jsonb_build_object` is (plpgsql_check flags it in an
immutable body); no index or check constraint uses them. The rest are `immutable`.

| Key | Content |
| --- | --- |
| `discord_style` | card or plain |
| `discord_title` | title fields joined by the separator, the (escaped) callsign when empty, at most 256 characters |
| `discord_description` | detail fields, labels when field names are on, at most 4096 |
| `discord_grid` | `[{name, value}]` per grid field, name the field label, value at most 1024 |
| `discord_footer` | "POTA · 17:42 UTC", or null when the footer is off |
| `discord_color` | the integer of decision 7 |
| `discord_url` | the profile, the source page (profile when the source has none), or null; null too when the call is not safe in a URL |
| `discord_line` | the plain line of decision 12, first field bold when bold first is on, at most 190 so ten lines fit in 2000, clipped only inside a value |
| `discord_suppress_embeds` | true only for plain style with link preview hidden |

A field a spot lacks is skipped.

**Escaping (PR 2 review).** Discord renders markdown, masked links included, in embed titles,
descriptions, field values and content. The fields are not as structured as this spec first
assumed: DX Cluster takes any run without spaces as a call, and the callsign, spotter and park name
are whatever the upstream sent, so a call such as `[FREE-QSL](HTTPS://EVIL.EXAMPLE)` would post a
working masked link. So `discord_escape` puts a backslash before every markdown character
(`\ * _ ~ | > [ ] ( ) < @ #` and the backtick) and before a list marker (`-` or `1.` followed
by a space) at the start of a line, indented or not, since Discord takes leading spaces or tabs as
a nested list, and `discord_field_values` escapes every value once, so the title, description, grid and line all
use escaped text. `discord_clip` is `push_clip` that never leaves a lone backslash before the
ellipsis. `discord_profile_url(spot)` is the profile as a full URL, or null when the call it would
name is not letters, digits, `/` and `-` (`spot_source_url`'s rule); the title link and the plain
line's masked link both use it, and without it the callsign is plain text. Push keeps
`render_push_field` unescaped, since a notification is plain text. A bare URL in a value is still
shown as a link by Discord, but its text is its address.

**Clipping the plain line.** The 190-character budget counts the markup. Items are added whole
while they fit; the first that does not is clipped inside its bold and link (without the link when
even a clipped value would not fit beside it), the rest are left out, and when not even a clipped
value fits, an ellipsis follows the last whole item. So no cut opens a `**` or a `[..](..)`.
`discord_plain_line` takes `p_max` (default 190) so Send test can render a shorter line.

## Sender

- `discordBatches(spots, destination)` builds the messages: one card embed or one line per spot.
  The group size is `min(10, max(batch_seconds == 0 ? 1 : 10, ceil(spots / 5)))`: one spot per
  message when `batch_seconds` is 0, ten otherwise, and more per message (never past ten) only when
  a claim would otherwise need more than `DISCORD_MESSAGES_PER_CLAIM` (5) messages. The claim's
  cap (`destination_claim_max`, 50) keeps a claim within five messages of ten. Cards are packed in
  order: a new message starts at the group size or where the next embed would take the message
  past Discord's 6,000 characters (titles, descriptions, field names and values and footers,
  counted in UTF-16 units), so a short message's room goes to the next spots; every spot is still
  sent. Only cards of about 600 characters or more (the largest settings with long place names)
  make a claim need more than five messages, at most a sixth for 50 such cards; the extra request
  may meet a 429, which throttles, and nothing is lost.
- A card embed carries SQL's title, description, URL, color, inline grid fields and footer, and no
  `timestamp`: Discord shows a timestamp in the footer row even with the footer off, and the
  footer already has the time, so the delivered card matches the preview.
- Plain lines go in `content`, joined by a newline (a blank line when the separator is a new line).
  A plain message sets `flags: 4` when any of its spots has `discord_suppress_embeds` true; all of
  a destination's spots share its settings, so in practice that is all or none.
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
  `[text](url)` only. It drops a backslash before any ASCII punctuation character, as Discord does,
  so SQL's escapes (`\[`, `\*`, `\_`, `\@`, `1\.`, `\-`) do not show literally.
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
- Pick a message style. · Pick what the title links to. · Pick a card color. · Pick a link preview. · Pick a separator. · Pick a batch window. · Turn each switch on or off. · Settings must be an object. (The editor's selects and switches cannot produce these; the API and a malformed request can.)
