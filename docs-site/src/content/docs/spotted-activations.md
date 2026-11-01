---
title: Spotted activations
description: See the activations Long Lines worked out from a station's spots, and share a link to one.
---

**Spotted activations** is a tab on every callsign profile. It lists the park, summit, WWFF, bunker
and island activations Long Lines worked out from a station's spots, and each one has its own page
you can share, such as `longlines.io/activations/kjw2khkyj47f`.

These are estimated from spots, not logs. Long Lines doesn't see contacts, so it can't tell whether an
activation met the program's minimum.

## Why you'd use it

You finished a POTA activation and want to show where you were heard. Open your profile's **Spotted
activations** tab, select **View** on the activation, then **Copy link** and paste the link wherever
you like.

## How it works

An activation is a run of one station's spots at one reference with no gap longer than 45 minutes.
Long Lines groups spots from POTA, SOTAwatch, WWFF and WWBOTA, and DX Cluster spots that name an IOTA
island. Then it adds RBN and DX Cluster spots of the same station, on the same bands, from the first
spot to the last.

- **Portable calls count as one station.** `KK4PWJ/P`, `KK4PWJ/M` and `KK4PWJ` land in the same
  activation.
- **Two-fers are one activation.** Spots at two parks at the same time make one activation with
  both references and a **Two-fer** chip. A park and its WWFF reference stay two activations, one per
  program.
- **A rover's parks are separate.** Each park is its own activation. When a day has more than one,
  its heading says so, such as "3 parks in one day".
- **POTA splits at 00:00 UTC.** POTA counts each UTC day as its own activation, so a POTA activation
  that runs past midnight UTC is two, both marked **Split at 00:00 UTC**. Other programs don't split.
- **A single spot counts.** It shows a **1 spot** chip: the activation may have ended early, or
  nobody spotted it again.
- **An activation shows up once it's over.** It appears about 45 minutes after its last spot. A spot
  that arrives after that isn't added.

Activations start from when Long Lines began recognizing them; older spots aren't grouped.

### The tab

| Section | What it shows |
| --- | --- |
| Figures | **Spotted activations** and **References** in the past 12 months, **Time on air** (first spot to last spot, each activation) and the **Most activated** reference |
| **Recent** | Activations grouped by UTC day, newest first: references and names, time on air, bands and modes, spots, and the states and countries it was heard in. Select **View** (or the row, on a phone) to open one. **Show all** lists up to 200. |

### A spotted activation's page

| Section | What it shows |
| --- | --- |
| Header | The station, references and names, the UTC day and time, and **Copy link** |
| **Where KK4PWJ was heard** | A US map with a line from the reference to each state a spotter was in, and the countries in words |
| **On the air** | Time on air, bands, modes, spots by source, states and countries, the farthest place heard, and contacts (never known) |
| **Spots over time** | Each spot on a timeline, one row per source |
| **Spots** | Every spot: time, source, who heard it and where, frequency, mode and reference |
| **How this was estimated** | How Long Lines built this activation |

A spotter's place is its license state for a US call, otherwise its country. Self-spots count as
spots but not as places heard. The map draws lines only for parks, summits and WWFF references with
a known location; bunkers and islands have none. Times are UTC.

The tab and the page can be up to 5 minutes old: your browser keeps them that long.

### Limits

Opening the tab or a page counts toward the lookup limit of 30 a minute per visitor, shared with
callsign profiles, reference pages, reference searches and public group pages.

## Set it up

1. Open **Callsign lookup** and look up a callsign, or open your own profile.
2. Select the **Spotted activations** tab.
3. Select **View** on an activation.
4. Select **Copy link**. The page says "Link copied." and the link is on your clipboard.

## When it doesn't work

**"Long Lines hasn't spotted an activation by KK4PWJ yet."** No activation of that station has been
spotted since Long Lines began recognizing them, or the last one ended less than 45 minutes ago.

**"Spotted activation not found."** The link is wrong, or the station's profile is hidden.

**"Couldn't copy the link."** Your browser refused the clipboard. Copy the address from the
address bar instead.

**An activation I made is split in two.** A gap of more than 45 minutes between spots starts a new
activation, and POTA activations split at 00:00 UTC.

**It says I wasn't heard somewhere I made contacts.** Long Lines only sees spots. A contact nobody
spotted doesn't show.
