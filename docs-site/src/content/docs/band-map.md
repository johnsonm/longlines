---
title: Band map
description: See who has been spotted in the last 5 minutes, laid out by frequency on each HF band and 6m.
---

The **Band map** shows every station spotted in the last 5 minutes on POTA, SOTA and the DX Cluster,
placed by frequency on a strip for each band. Select a station to open its profile.

## Why you'd use it

You have half an hour to hunt. The band map shows at a glance that 20m has a dozen park activators
between 14.060 and 14.075 and 17m has two, so you know where to tune first.

## How it works

There is one strip per band, always drawn: 160m, 80m, 40m, 30m, 20m, 17m, 15m, 12m, 10m and 6m. Each
runs left to right by frequency in MHz, with dashed markers for the CW, digital and phone segments.
Each strip has three lanes: DX Cluster at the bottom, POTA in the middle, SOTA on top. The **Show**
chips turn a source on or off without reloading.

Each station appears once per band, at its latest spot. Hover a dot for its call, frequency, mode and
age. Select it to open the station's profile. Where stations are crowded, the click opens a menu such
as "26 stations near 14.082" that lists each one, with a link to the park or summit for POTA and SOTA.

What it leaves out:

- **Reverse Beacon Network, APRS-IS, WWFF, WWBOTA and logged contacts.** RBN spots are on each
  station's profile.
- **Bands without a strip**, such as 60m and 2m, and spots outside a strip's range.
- **Hidden callsigns.**

The map is rebuilt at most every 30 seconds and reloads every 30 seconds while the tab is visible. The
page shows "Updated 12 seconds ago". The band map is public and has no lookup limit.

## Set it up

1. Open **Band map**.
2. Use the **Show** chips to pick DX Cluster, POTA and SOTA.
3. Select a station, or a crowded spot and then a station from the menu.

## When it doesn't work

**A band says "Nothing heard in the last 5 minutes."** No POTA, SOTA or DX Cluster spot on that band
in the last 5 minutes.

**A station I can hear isn't on the map.** It was spotted more than 5 minutes ago, only on RBN or WWFF,
or outside the strip's range.

**"Couldn't load the band map."** The last map stays on screen; it tries again in 30 seconds.

<!--
Verified against:
- web/src/bandmap/BandMapPage.tsx, BandStrip.tsx, model.ts, useBandMap.ts
- web/src/lib/bandplan.ts (strips and ranges)
- supabase/migrations/20261014000600_band_map.sql (sources, 5 minutes, one per base call per band, hidden calls, 30 s cache)
- supabase/functions/_shared/handlers/band_map.ts (no rate limit)
-->
