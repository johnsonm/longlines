---
title: Discord channel
description: Post matched spots to a Discord channel through a channel webhook.
---

A Discord channel destination posts each matched spot to a channel, as a colored card or a single
line of text. It uses a webhook you create in the channel's settings. There is no Long Lines bot to
invite.

## Why you'd use it

Your club runs a `#pota-spots` channel. You want a card there whenever a member activates a park, with
the call, frequency and park name, linked to the activator's profile.

## How it works

Long Lines posts through the channel's webhook URL. You pick the message style and which fields appear,
in order:

- **Card**: a colored embed with a **Title** (1 to 4 fields), **Details** (up to 8) and a **Small grid**
  (up to 6 short values side by side). The title links to the callsign's profile, the spot on the
  source site, or nothing. A footer such as "POTA · 17:42 UTC" is on by default.
- **Plain line**: one line of text with up to 8 fields, such as
  `**KK4PWJ** · 14.062 MHz · CW · POTA · US-2763 · Pisgah National Forest`.

The fields are Callsign, First name, Last name, Frequency, Band, Mode, Source, Reference, Place name,
State, Spotter and Time. First and last name come from the spotted call's FCC license, so they are
empty for non-US calls and club calls. Comment is not offered, because it is text typed by the
spotter. A field a spot doesn't have is skipped.

What Long Lines guarantees about every message:

- Every value is escaped, so a spotter can't inject Discord formatting or links.
- Mentions such as @everyone are always turned off.
- You can't add your own text.

**Card color** is **By source** by default: POTA green, SOTA purple, WWFF teal, WWBOTA gold, DX
Cluster blue, RBN orange, Logged contacts magenta, and APRS-IS its own color. You can pick one color
for everything instead.

### Pacing

Discord allows about 30 messages a minute per webhook. With **One message per spot**, Long Lines
sends spots as they match, and when a connection is busier than Discord allows, it groups several
spots into one message so none are dropped (up to 10 cards a message). With **Group spots every 10
seconds** (or 30 or 60), the first spot after a quiet spell waits that long so others can join it;
10 waiting spots go at once.

A spot that has waited 24 hours is dropped. If Discord rate-limits the webhook, Long Lines waits as
Discord asks and then sends the same spots.

## Set it up

1. In Discord, open the channel's settings and choose **Integrations**.
2. Choose **Webhooks**, then **New Webhook**, and copy the webhook URL. It looks like
   `https://discord.com/api/webhooks/1234567890/AbCd…`.
3. In Long Lines, open **Destinations**, select **Add destination**, pick **Discord channel** and
   select **Continue**.
4. Enter a **Name**, such as `Club POTA channel`.
5. Paste the URL into **Webhook URL** on the **Discord channel** card.
6. On the **Message** card, pick **Message style** and arrange the fields. Use **Add a field** to add
   one and the arrows to reorder.
7. On the **Delivery** card, choose **Messages**: **One message per spot** or a grouping interval.
8. Check the **Preview**, which draws the message in Discord's dark theme. **Preview with this spot**
   lets you try a recent real spot.
9. Select **Add destination**.
10. Select **Send test message** on the preview, or **Send test** on the destination's card. The test
    is marked "Test message from Long Lines".
11. Add the destination to a connection.

After saving, the URL is hidden. To change it, select **Replace URL**.

## Common setups

**Club activity card.** Style **Card**. Title: Callsign, Frequency, Mode. Details: Source, Reference,
Place name, State. Small grid: Band, Spotter. Title links to **Callsign profile**. **Card color**: By
source. These are the defaults.

**Busy DX channel.** Style **Plain line**. Message: Callsign, Frequency, Mode, Spotter. **Bold the
first field** on, **Link preview** Hidden. **Messages**: Group spots every 30 seconds.

**One channel per program.** Two destinations, `POTA channel` and `SOTA channel`, each linked to its
own connection, both with **Card color** set to one fixed color so the two channels look different.

## When it doesn't work

**"That is a channel link, not a webhook URL."** You copied the channel's link. Copy the URL from
**Integrations > Webhooks** instead.

**"Use a Discord webhook URL."** The URL must start with `https://discord.com/api/webhooks/` or
`https://discordapp.com/api/webhooks/`. Links from `ptb.discord.com` or `canary.discord.com` are
refused; change the host to `discord.com`.

**Failing with HTTP 404 or 401.** Someone deleted or reset the webhook in Discord. Create a new one,
select **Replace URL**, paste it and save.

**Messages arrive in bunches.** The connection is busier than about 30 messages a minute, so spots
are being grouped. Narrow the connection, or choose a grouping interval so it happens predictably.

**First name and Last name are blank.** The station isn't in the FCC database, or it is a club call.

<!--
Verified against:
- web/src/destinations/DiscordChannelCard.tsx (URL steps, error copy, Replace URL)
- web/src/destinations/DiscordMessageCard.tsx, discordModel.ts (styles, limits, options, defaults)
- web/src/destinations/DiscordDeliveryCard.tsx (Messages options, 30 a minute copy)
- web/src/destinations/DiscordPreviewCard.tsx (Send test message)
- supabase/migrations/20261018000100_discord_destinations.sql (defaults, rendering, escaping, mentions)
- supabase/migrations/20261028000500_local_cluster.sql (URL validation, max age 24 h)
- supabase/migrations/20261028000300_logged_contacts_source.sql (source colors and names)
- supabase/migrations/20261029000800_previews_skip_retracted.sql (test footer)
- supabase/functions/_shared/delivery/format.ts (10 cards a message, 6,000 characters)
- supabase/tests/discord_destinations.test.sql (plain line example)
-->
