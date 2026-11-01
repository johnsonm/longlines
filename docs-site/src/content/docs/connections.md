---
title: Connections
description: Take spots from one source, filter them, and send the ones that pass to your destinations.
---

A connection takes spots from one source, runs them through your filter, and sends the ones that
pass to zero or more destinations. It is the piece that decides which spots reach you.

## Why you'd use it

You chase parks on 20m CW and only care when someone is on the air in North Carolina. A connection on
Parks on the Air with **Band is 20m**, **Mode is CW** and **Park, summit, or location contains
US-NC** sends you those activators and nothing else.

## How it works

Every spot that arrives from a source is checked against each connection on that source. If it
passes the filter, Long Lines sends it to every destination linked to the connection. Matching runs
right after each batch of spots is stored, and once a minute as a backstop, so a spot reaches the
sender within seconds of arriving. How long it then takes to reach you depends on the destination
(see [Destinations](/destinations/)).

A few rules govern what goes out:

- **One source per connection.** You pick it when you create the connection and can't change it
  later. To use another source, create another connection. IOTA is the exception in name only: it
  makes a DX Cluster connection with an island rule.
- **No destination, no spots.** A connection runs only while it is on and linked to at least one
  enabled destination. You can save one with no destinations; it stays off until you add one.
- **A disabled destination doesn't count.** If every destination on a connection is turned off,
  nothing is sent, even though the connection's switch still shows on.
- **One copy per destination.** If two of your connections match the same spot and both send to the
  same destination, the destination gets it once.
- **Repeats.** **Repeat spots for the same station** limits how often one callsign comes through.
  With **At most once per 10 minutes** (the default), after a spot of K4ABC goes out, further K4ABC
  spots on that connection are skipped for 10 minutes. The callsign is compared as spotted, so
  K4ABC and K4ABC/P count as two stations here. Pick **Every spot** to turn this off.
- **Turning a connection off** stops new matches and drops the spots it had queued but not yet sent.
  The same happens when you remove a destination from it.

You can have up to 100 connections.

## Set it up

1. Open **Connections** and select **New connection**.
2. In **Pick your source**, choose a source and select **Continue**. Each row shows its average
   spots per hour. Reverse Beacon Network and APRS-IS are marked "High volume. Needs a callsign
   filter".
3. Type a **Name**, for example `NC parks on 20m`.
4. Under **Filter**, add rules. Select **Add rule**, then choose a **Field**, a **Condition** and the
   **Values**. Leave the filter empty to pass every spot. See [Filter rules](/filter-rules/) for each
   field.
5. Choose **Repeat spots for the same station**.
6. Under **Destinations**, select **Add destination** and pick one or more of your destinations. If
   you have none yet, the menu offers **Add one on the Destinations page**.
7. Check the **Preview** card on the right. It shows how many of the last 200 spots from the past 24
   hours on this source would have passed, with up to four examples.
8. Select **Save connection**.

The **Enabled** switch is on for a new connection. It stays greyed out until the connection has a
destination.

### Reading the preview

The preview uses the source's most recent spots from the last 24 hours, up to 200. It runs your filter
on them as the matcher would, but it ignores the repeat setting and whether the connection or its
destinations are on.

- "37 of the last 200 POTA spots would pass" is a fair guide to volume.
- "This passes everything. Add a filter or expect a lot of messages." means the filter lets every
  recent spot through.
- "Nothing recent passes. That can be fine for a narrow filter." is normal for a filter on one
  callsign who isn't on the air.

### The Connections list

Each card shows the source, the filter in words (such as **Band is** 20m **and** **Mode is** CW), the
destinations, and a status line such as "Once per 10 min · 37 of the last 200 POTA spots passed". The
switch turns the connection on or off. **Delete** asks first; the connection's destinations are kept.

### Shortcuts that start a connection for you

Several pages fill in a new connection. Nothing is saved until you select **Save connection**.

| Where | What it fills in |
| --- | --- |
| **Create connection** on a source page | The source |
| **Get alerts for KK4PWJ** on a callsign profile | Your chosen source, **Callsign is KK4PWJ**, named "KK4PWJ on the air" |
| **Get alerts** on a callsign group | Your chosen source, **Callsign group is in** the group, named "{group} on the air" |
| **Get alerts for US-2763** on a reference page | The program's source, **Park, summit, or location is US-2763**, named "Activators at US-2763" |
| **Create a Parks on the Air connection** in a goal warning | Parks on the Air, with the goal rule |

## Common setups

**Your club on any band, from POTA.** Source: Parks on the Air. Rule: **Callsign group is in** `Club
roster`. Repeat: **At most once per 30 minutes**. Destination: your club's Discord channel.

**A rare one on the DX Cluster.** Source: DX Cluster. Rules: **Callsign is** `VP8PJ` **Or**
**Callsign is** `3Y0J`. Repeat: **Every spot**, so you see each new frequency. Destination: a push
destination with **Urgency** set to High.

**Hear yourself on RBN.** Source: Reverse Beacon Network. Rules: **Callsign is** `KK4PWJ` **And**
**Band is** `20m`. Repeat: **At most once per 5 minutes**. Destination: a webhook that logs the
signal reports.

## When it doesn't work

**The switch is greyed out.** The connection has no destinations. Add one under **Destinations** and
save.

**The card says "Waiting for a destination" or "Paused".** The first means no destination is linked;
the second means the connection is off.

**The preview shows spots passing but nothing arrives.** Check that at least one linked destination
is enabled; the connection's switch doesn't show this. Then check the destination itself on the
**Destinations** page for **Failing**, **Paused** or **Relay offline**. Also check the repeat setting:
with **At most once per hour**, an activator who keeps getting spotted reaches you once an hour.

**Save connection stays disabled.** The name is empty, a rule row has an invalid value (shown in red
under the row), or, on Reverse Beacon Network or APRS-IS, a group of rules has no Callsign or
Callsign group rule.

**"You can have up to 100 connections."** You're at the account limit. Delete one first.

**A new RBN or APRS-IS connection's preview shows nothing.** Long Lines matches RBN and APRS-IS spots
only for stations that some live connection names, so a callsign nobody watches has no stored spots
to preview yet. Save the
connection with an enabled destination and spots start flowing.

<!--
Verified against:
- web/src/subscriptions/SubscriptionsPage.tsx (list, switch, status line, delete copy)
- web/src/subscriptions/SourcePickerDialog.tsx (Pick your source, Continue)
- web/src/subscriptions/SubscriptionEditorPage.tsx (Name, Enabled, steps, Add destination, preview copy, Save connection)
- web/src/subscriptions/FilterStep.tsx, model.ts (Add rule, repeat options, defaults, prefills)
- supabase/migrations/20261029000100_match_pending_spots_lock.sql (live check, quiet window per callsign as spotted, on conflict per destination)
- supabase/migrations/20261029001200_goals_matching.sql (preview_subscription: 200 spots, 24 h, quiet ignored)
- supabase/migrations/20261029001100_goals.sql (100-connection cap message)
- supabase/functions/_shared/ingest.ts, rbn_push.ts (matcher after ingest; RBN watched calls only)
- web/src/profile/CallsignPage.tsx, web/src/references/ReferencePage.tsx, web/src/groups/useGetAlerts.tsx (Get alerts)
Not verified: the RBN empty-preview case is inferred from rbn_push.ts, not observed.
-->
