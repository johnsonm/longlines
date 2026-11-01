---
title: Destinations
description: Where matched spots go, how fast they're sent, and what the health chips mean.
---

A destination is a place Long Lines sends the spots your connections match: a Discord channel, your
own webhook URL, push notifications on your phone or computer, or the bandmap in your logging
software through Long Lines Relay. One destination can serve many connections.

## Why you'd use it

Your club has a Discord channel for POTA activity, and you also want urgent DX alerts on your phone.
Make one Discord destination and one push destination, then link each connection to whichever fits.

## How it works

| Type | What you get | Detail |
| --- | --- | --- |
| **Discord channel** | A message in a channel, as a card or one line | [Discord channel](/destinations/discord/) |
| **Webhook** | An HTTPS POST with a JSON body, signed | [Webhook](/destinations/webhook/) |
| **Push notification** | A notification on the devices you pick | [Push notifications](/destinations/push/) |
| **Local DX cluster** | DX cluster spots in your logging software's bandmap | [Local DX cluster](/destinations/local-dx-cluster/) |

You choose which fields each one carries and in what order. You can't add your own text or
templates; every destination is a pick from a fixed list of fields.

### Pacing

Long Lines sends the newest spots first, and each type has its own limits per destination:

| Type | Most spots per minute | A waiting spot is dropped after |
| --- | --- | --- |
| Discord channel | About 30 messages, up to 10 spots each | 24 hours |
| Webhook | 1,000 | 24 hours |
| Push notification | 3 | The destination's **Drop if the device is offline for** setting (30 minutes by default) |
| Local DX cluster | 120 (also 120 per relay across all its destinations) | 2 minutes |

When more spots match than a destination can take, the newest go first and the older ones wait.
They are sent later or, once they pass the age above, dropped. Push is the tightest: a connection
that matches 20 spots a minute sends 3 notifications a minute, the newest each time.

If a receiving service answers with HTTP 429 (too many requests), Long Lines holds that destination
for the time the service asks, or 60 seconds doubling up to 15 minutes if it doesn't say, then sends
the same spots. A rate limit is never counted as a failure.

### Health

Each destination on the **Destinations** page has a chip:

| Chip | Meaning |
| --- | --- |
| **Healthy** | Deliveries are going through. |
| **Failing** | The last 5 delivery attempts failed in a row. The next success clears it. |
| **Paused** | A webhook turned itself off after repeated failures or an HTTP 410, or a Discord destination's webhook no longer exists. Turn **Enabled** on and save to resume. |
| **Relay offline** | A Local DX cluster's relay isn't connected, so its spots are dropped. |
| **1 device blocked** | A push device has notifications blocked in its browser. |

While a destination is failing, the navigation shows a red dot on **Destinations**, and the page
shows a banner such as "Club Discord is failing" with a **Send test** button.

Turning **Enabled** off on a destination stops new spots and drops the ones queued for it.

## Set it up

1. Open **Destinations** and select **Add destination**.
2. Pick **Discord channel**, **Webhook**, **Push notification** or **Local DX cluster**, then select
   **Continue**.
3. Give it a **Name**. Names are unique in your account.
4. Fill in the type's cards. The type's page covers each one.
5. Select **Add destination** (or **Save destination** on the Local DX cluster editor).
6. Select **Send test** on the destination's card to check it (not available for Local DX cluster).
7. Link it to a connection: open the connection, select **Add destination** under **Destinations**,
   and save.

Each card on the **Destinations** page has **Send test**, **Edit**, **Duplicate** and **Delete**.
**Duplicate** makes "Copy of {name}" with the same settings, turned off, and opens it. **Delete** lists
the connections that use the destination and warns you about any that would be left with no
destination. Those connections stay saved and wait until you add another.

You can have up to 50 destinations. **Send test** is limited to 10 a minute per destination and 30 a
minute across your account.

## When it doesn't work

**Failing.** Open the destination and read the banner: it shows the error the service returned, for
example HTTP 404 from a Discord webhook that was deleted. Fix the cause, then **Send test**. Changing
a Discord or webhook URL clears **Failing** right away.

**"This destination asked Long Lines to slow down. Try the test again in a few minutes."** The
service rate-limited it. Spots resume once the hold ends.

**"Too many tests. Wait a minute and try again."** You hit the test limit.

**Spots arrive late or some never arrive.** Check the pacing table. A push destination fed by a busy
connection drops most spots by design; narrow the connection's filter or raise its repeat interval.

**A connection says it's sending but this destination gets nothing.** Make sure the destination is
enabled and linked to the connection. Disabled destinations get no spots, and the connection's
switch doesn't show that.

<!--
Verified against:
- web/src/destinations/DestinationDialog.tsx, types.ts (picker labels and order)
- web/src/destinations/DestinationsPage.tsx, DestinationCard.tsx, HealthChip.tsx, cardMeta.ts (chips, banners, delete copy, duplicate)
- supabase/migrations/20261028000500_local_cluster.sql (destination_budget, destination_max_age, local_cluster_relay_cap, claim unwanted sweep, duplicate disabled)
- supabase/migrations/20261021000600_url_change_health.sql (failing after 5), 20261029000700_webhook_url_clears_headers.sql (URL change resets health)
- supabase/migrations/20261015000400_rate_aware_claim.sql, 20261016000300_throttle_cap.sql (429 backoff)
- supabase/migrations/20261019000530_send_test_limit.sql, supabase/functions/_shared/handlers/test_delivery.ts (test limits)
- supabase/migrations/20261029001100_goals.sql (50-destination cap)
Flagged: the Failing banner says "Check the URL" for push destinations too, which have no URL.
-->
