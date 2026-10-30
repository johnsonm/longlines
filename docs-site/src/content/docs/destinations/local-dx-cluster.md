---
title: Local DX cluster
description: Feed matched spots into your logging software's bandmap through Long Lines Relay.
---

A Local DX cluster destination sends matched spots to Long Lines Relay on your computer. The relay
runs a small DX cluster there, and your logging software connects to it as it would to any telnet
cluster, so the spots show up in its bandmap.

## Why you'd use it

You hunt parks from N1MM or Log4OM and want only the POTA activators on bands you can work, in the
bandmap, instead of a full cluster feed.

## How it works

Each spot goes out as a standard DXSpider-style line, for example:

```
DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z
```

The comment always starts with the mode word (some logging software hides spots without one). After it
come the fields you pick on the **Spot line** card, in your order:

- **Reference**: the park, summit or other reference with its program, such as `POTA K-0039`.
- **Source**: where the spot came from, such as POTA or RBN.
- **Spotter's comment**: the note the spotter added.

The comment is cut to 30 characters. SSB is shown as LSB below 10 MHz (except on 60m) and USB above.
A spot with no spotter, such as a logged contact, shows `LONGLINES` as the spotter.

What it does not do:

- **Nothing is queued while the relay is offline.** Spots only go out while the relay is connected.
  A spot that waits more than 2 minutes is dropped, because an old spot is no use in a bandmap.
- **No tuning.** Nothing changes on your radio until you pick a spot in your logging software.
- **No spots without a frequency**, and never your own logged contacts, so the relay doesn't feed
  your log back to you.
- **No Send test** in the web app. Use **Send test spot** in the relay instead.
- **Limits:** 120 spots a minute per destination, and 120 a minute per relay across all destinations
  that target it, newest first.

A Local DX cluster destination never shows **Failing**. When its relay isn't connected, the card says
**Relay offline**.

## Set it up

You need Long Lines Relay installed and signed in with permission to receive spots. See
[Long Lines Relay](/relay/).

1. Open **Destinations**, select **Add destination**, pick **Local DX cluster** and select
   **Continue**.
2. Enter a **Name**, such as `Shack PC bandmap`.
3. On the **Relay** card, pick the computer under **Relay**. Only relays allowed to receive spots are
   listed. The chip says **Connected** or **Offline**.
4. On the **Spot line** card, pick the comment fields and their order.
5. Check the **Preview**, which shows one spot as your logging software will see it.
6. Select **Save destination**.
7. Add the destination to a connection.
8. Turn on the relay's DX cluster and connect your logging software to it. See
   [The relay's DX cluster](/relay/dx-cluster/).

You can make the destination only in the web app; the management API refuses to create one.

## Common setups

**POTA hunting bandmap.** Connection: Parks on the Air, **Band is** 40m, 20m, 17m. Spot line:
Reference. Your bandmap shows `CW POTA US-2763` next to each activator.

**Skimmer hits for your friends.** Connection: Reverse Beacon Network, **Callsign group is in**
`Friends`. Spot line: Source, Spotter's comment, so the comment reads like `CW RBN 18 dB 24 WPM CQ`
(cut to 30 characters).

**Everything you'd chase, one feed.** Two connections, Parks on the Air and SOTA, both sending to the
same Local DX cluster destination. Spot line: Reference, Source.

## When it doesn't work

**The card says Relay offline.** The relay isn't running, isn't signed in, or its spots stream isn't
open. Open the relay on that computer. Spots that matched while it was offline are gone.

**The relay isn't in the Relay list.** It was paired without permission to receive spots, or it was
revoked. Sign the relay in again and allow "Receive the spots that match your connections" on the
approval page.

**The relay was revoked.** The destination is left with no relay. Edit it and pick another.

**Spots show in the relay but not in the logger.** Check the logger's cluster address and port
against what the relay shows.

**Some spots never appear.** Spots without a frequency are never sent, and a busy connection can pass
120 a minute; the oldest age out after 2 minutes.

<!--
Verified against:
- web/src/destinations/LocalClusterDestinationPage.tsx, LocalClusterRelayCard.tsx, LocalClusterLineCard.tsx, LocalClusterPreviewCard.tsx, localClusterModel.ts
- web/src/destinations/DestinationCard.tsx (no Send test), HealthChip.tsx (Relay offline)
- supabase/migrations/20261028000500_local_cluster.sql (line layout, comment fields, LSB/USB rule, LONGLINES spotter, 2-minute max age, 120 caps, loop guard, API refusal)
- supabase/tests/local_cluster.test.sql (example line)
- supabase/functions/_shared/delivery/send.ts ("Send a test spot from the relay.")
- sonyccd/longlines-relay at cd60f2c: src/copy.ts ("Send test spot"), docs/loggers.md (DX cluster section)
-->
