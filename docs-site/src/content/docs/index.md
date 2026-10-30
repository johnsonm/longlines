---
title: Getting started
description: How spots move through Long Lines, and how to set up your first alert.
---

Long Lines reads spots from POTA, SOTA, WWFF, WWBOTA, the DX Cluster, the Reverse Beacon Network and
logged contacts, and sends the ones you care about to Discord, a webhook, your phone or your logging
software's bandmap.

## Why you'd use it

You want a push notification on your phone when a POTA activator in North Carolina is spotted on 20m
CW, without watching the spotting page all afternoon.

## How it works

Three pieces do the work:

- A **source** is where spots come from. See [Sources](/sources/).
- A **connection** takes spots from one source, filters them with your rules, and passes the ones that
  match on. See [Connections](/connections/) and [Filter rules](/filter-rules/).
- A **destination** is where matching spots are sent. See [Destinations](/destinations/).

A connection with no destination sends nothing, and one destination can serve many connections. From
a spot appearing upstream to Long Lines matching it usually takes seconds for the DX Cluster and RBN,
up to 30 seconds for SOTA, and up to a minute for POTA, WWFF and WWBOTA. Each destination then has its
own pacing; push notifications, for example, are limited to 3 a minute per destination.

Long Lines doesn't remove duplicates across sources. A park that is both a POTA and a WWFF reference
can reach you twice if you have connections on both.

Signed in, the **Home** page draws your setup: each source, the connections that take from it, and
the destinations they feed, with how many spots each matched (**Matched**) and sent (**Delivered**) in
the last 24 hours. A dash means there is no count, usually because the connection is off or has no
enabled destination.

## Set it up

This sets up the example above: a push notification for 20m CW activators in North Carolina parks.

1. Go to [longlines.io](https://longlines.io), select **Sign in**, then **Create account**. Enter your
   callsign, email and a password, and confirm your email. See [Your account](/account/).
2. On iPhone or iPad, add Long Lines to the Home Screen first (Share, **Add to Home Screen**) and open
   it from there. Push notifications need it.
3. Open **Destinations**, select **Add destination**, pick **Push notification** and select
   **Continue**.
4. Name it `My phone`, select **Add this device**, then **Enable notifications**, and allow
   notifications when the browser asks.
5. Select **Add destination**, then **Send test** on its card to check a notification arrives.
6. Open **Connections**, select **New connection**, pick **Parks on the Air** and select **Continue**.
7. Name it `NC parks 20m CW`.
8. Under **Filter**, select **Add rule** three times and set:
   - **Where** **Band** **is** `20m`
   - **And** **Mode** **is** `CW`
   - **And** **Park, summit, or location** **contains** `US-NC`
9. Under **Destinations**, select **Add destination** and pick `My phone`.
10. Check the **Preview**, then select **Save connection**.

The next matching spot sends a notification. To see it working sooner, try a looser filter such as
**Band is** 20m alone, and watch the **Preview** count.

## Where to go next

- Alerts for your club: [Callsign groups](/callsign-groups/).
- Alerts only for what you still need: [Goals](/goals/) with [Long Lines Relay](/relay/).
- Spots in your logger's bandmap: [Local DX cluster](/destinations/local-dx-cluster/).
- Look around without an account: [Band map](/band-map/), [Callsign lookup](/callsign-lookup/),
  [Reference lookup](/reference-lookup/), [Stats](/stats/), [Health](/health/).

<!--
Verified against:
- web/src/layout/AppShell.tsx (navigation labels)
- web/src/home/HomePage.tsx, FlowDiagram.tsx, model.ts (Home diagram, Matched/Delivered, en dash)
- web/src/subscriptions/SubscriptionEditorPage.tsx, FilterStep.tsx (steps)
- web/src/destinations/DestinationDialog.tsx, PushDestinationPage.tsx, DevicesCard.tsx, AddDeviceDialog.tsx
- supabase/migrations/20261028000300_logged_contacts_source.sql (home_flow 24-hour counts)
- supabase/migrations/20261028000500_local_cluster.sql (push 3 a minute)
-->
