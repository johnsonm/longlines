---
title: Stats
description: What Long Lines took in over the last 7 days, by source, band, state, country and station.
---

The **Stats** page summarizes the last 7 days: spot counts, the busiest hours, activity by US state
and country, band and mode charts, and the most active activators and references. It's public.

## Why you'd use it

You're picking a time for a POTA activation. **Peak POTA/SOTA/WWFF hour** and the **Spots processed per
hour** chart show when hunters are most active, and **POTA bands** shows where they are.

## How it works

The window is the 7 complete UTC days ending at the last midnight; the hourly chart covers the last 168
complete hours. The page is rebuilt every hour, a few minutes past the hour, and says "Updated hourly,
last at 14:05 UTC Oct 30." Your browser keeps it until the next update is due, so reloading doesn't
change it. All times are UTC. There are no filters or date pickers.

Definitions used on the page:

- A **spot** is one report from a source.
- An **activation** is one callsign at one reference on one UTC day.
- A **chaser** is a spotter who isn't the activator.

What each part covers:

| Section | Sources |
| --- | --- |
| **Spots processed** | RBN, APRS-IS packets, POTA, SOTA, WWFF |
| **Spots processed per hour** | All sources, DX Cluster included |
| **Spots per day** | One chart each for RBN, APRS, POTA, SOTA and WWFF |
| **POTA activity by state** | POTA parks; a multi-state park counts in each state |
| **Activity by country** | POTA, SOTA, WWFF, DX Cluster and RBN, by the country of the station on the air |
| **RBN bands**, **POTA bands**, **SOTA bands**, **WWFF bands** | That source |
| **Top SOTA associations**, **Top WWFF programs**, **Modes** | SOTA, WWFF, and POTA/SOTA/WWFF |
| **Most active activators**, **Most spotted parks, summits and WWFF references** | POTA, SOTA, WWFF; top 8 |
| **Most heard on RBN** | RBN; top 8 |
| **APRS-IS** | Packets, stations and igates, counting every packet on the feed, not only the beacons connections match. |

WWBOTA, IOTA and logged contacts aren't shown here. Hidden callsigns are removed from the top lists,
which can then hold fewer than 8 rows, but still count in the totals.

## Set it up

Open **Stats**. Hover a chart for exact values. Callsigns link to their profiles and references to
their pages.

## When it doesn't work

**"Not enough data yet. Stats appear after the first full day of spots."** Shown only on a new
installation.

**Today's activity isn't there.** The window ends at the last UTC midnight; today is in the hourly
chart only.

**The numbers didn't change after a reload.** The page updates once an hour.

<!--
Verified against:
- web/src/stats/StatsPage.tsx, format.ts, cache.ts, useStats.ts
- supabase/migrations/20261028000300_logged_contacts_source.sql (build_stats_snapshot_at window and sections)
- supabase/migrations/20261006000015_stats_snapshots.sql (cron at :05)
- supabase/migrations/20261012000080_stats_hidden_callsigns.sql (hidden calls removed from top lists only)
-->
