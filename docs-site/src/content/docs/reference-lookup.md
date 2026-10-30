---
title: Reference lookup
description: Find a POTA park, SOTA summit or WWFF reference and see its activation history.
---

**Reference lookup** searches the POTA, SOTA and WWFF lists by reference or name. Each reference has a
public page with its details, when it was last activated, a heat map of activations and its top
activators.

## Why you'd use it

You're planning a SOTA activation and want to know how often W4C/CM-001 gets activated and by whom.
Its page shows every activation Long Lines has seen, the bands and modes used, and the top activators.

## How it works

### Searching

Type a reference, part of one, or words from the name: `US-2763`, `mitchell`, `falls lake`. Every word
must appear in the reference or the name. A search is 2 to 64 characters and at most 6 words. Filter
with **All programs**, **POTA parks**, **SOTA summits** or **WWFF references**.

Results are ordered by activations, most first, and show the top 25. Retired references and ones never
activated are included. With no search, the page shows **Most spotted this week** from the Stats page.

Activation counts in search results come from completed days only, so a reference activated today
shows a lower count in search than on its page.

### The reference page

Pages exist for POTA, SOTA and WWFF only, at addresses like `/ref/pota/US-2763` and
`/ref/sota/W4C/CM-001`. WWBOTA bunkers and IOTA islands have no pages.

An **activation** is one activator (by base call) spotted at the reference on one UTC day. Only spots
from the matching source count: POTA spots for a park, SOTAwatch spots for a summit, WWFF spots for a
WWFF reference. A DX Cluster spot that names a park never counts. Long Lines sees spots, not logs, so
its counts aren't the program's own.

| Section | What it shows |
| --- | --- |
| Header | Reference, name, location, grid, status, **Get alerts**, **Share**, and a link to the program's own page |
| **Last activated** | The latest activator, frequency, mode and time, if within the last 14 days |
| Figures | **Activations**, **Activators**, **Spots** and **First activated** |
| **Activations in the past year** | A heat map; hover a day to see who |
| **About this park** (or summit, reference) | Details from the program's list, refreshed weekly |
| **Activity**, **Bands**, **Modes** | Activations per month, spots by band and mode |
| **Top activators** | The 10 with the most activations here |
| **Recent activations** | The latest 10, with bands and modes |
| **Recent spots** | The newest 25 from the last 7 days |

A reference that isn't in the program's list but has been spotted still gets a page, with a note that
it may be new or a typo. A retired reference shows when it was retired and has no **Get alerts**
button.

Pages are cached for 15 minutes. Searches and pages count toward the 30-lookups-a-minute limit shared
with callsign profiles.

## Set it up

1. Open **Reference lookup**.
2. Type into **Reference or name** and select **Look up**.
3. Select a result to open its page.
4. To be told when someone activates it, select **Get alerts for US-2763**. A new connection opens on
   the matching source with **Park, summit, or location is US-2763**, named "Activators at US-2763".
   Save it with a destination.

## When it doesn't work

**"A search is 2 to 64 characters, at most 6 words."** Shorten or lengthen the search.

**"No parks, summits or WWFF references match".** Every word must appear in the reference or the name.
Drop a word, or check spelling. A reference that isn't in the program's list can't be found by search;
type its page address instead.

**"Reference not found".** The reference isn't in the list and has never been spotted, or it's
mistyped. SOTA references keep their slash: `W4C/CM-001`.

**"Showing the top 25. Add a word to narrow it down."** More references match than the page shows.

**An activation is missing.** It came only from DX Cluster spots, or the activator's call is hidden.

<!--
Verified against:
- web/src/references/ReferenceLookupPage.tsx, ReferencePage.tsx, ReferenceHeatMap.tsx, search.ts, format.ts, paths.ts
- supabase/migrations/20261027001500_reference_search.sql (bounds, word matching, 25 results, rolled-up days only)
- supabase/migrations/20261027001200_reference_profile.sql (activation definition, source rule, 14-day last activated, list lengths, 15-minute cache)
- supabase/functions/_shared/handlers/reference_profile.ts, reference_search.ts
-->
