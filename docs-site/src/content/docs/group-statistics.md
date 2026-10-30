---
title: Group statistics
description: See how a callsign group is doing on the air, and share a public statistics page.
---

Every callsign group has a **Statistics** tab: spots heard, active members, activations, a year-long
heat map and rankings. You can share it on a public page that anyone with the link can open.

## Why you'd use it

Your club newsletter wants "who was most active this month". Open the club group's statistics, pick
**Last 30 days**, and read the **Who is most active** lists, or send members the public link.

## How it works

The figures are built from spots Long Lines has seen for the group's members, from every source except
APRS-IS. Hidden callsigns (stations whose profile was hidden on request) count nowhere.

- **Period**: **Last 7 days** or **Last 30 days** (UTC days ending today). Changes compare with the
  same number of days before.
- **Spots heard**, **Active members** (heard at least once), **Activations** (one member at one
  reference on one UTC day, split by program) and **Places activated**.
- **Club activity over the past year**: a heat map of club spots per day, shaded at fixed levels (1 to
  99, 100 to 199, 200 to 399, 400 or more). It ignores the period. **View as table** shows the same
  data as rows.
- **Who is most active**: the top 3 for Most spots, Most days on the air, CW, SSB, Digital (FT8 and
  FT4) and POTA activations.
- **Members**: every member ranked by spots in the period, with days on the air, main mode and last
  heard. **Search members** filters it.
- **Bands**, **Modes**, and **Most activated places** (top 10).

The statistics are built when someone opens them and kept for up to an hour; the page says "Updated 12
minutes ago. Statistics refresh every hour." Changing the members rebuilds them on the next visit. On
the **Groups** list, each card also shows who is on the air now (heard in the last 30 minutes), which
is live.

### The public page

When you turn on the public page, the group gets a link like `longlines.io/g/7f3kq9xm2a`. The code is
made once and never changes, so a printed link works again if you turn sharing back on later. Anyone
with the link can see the page without signing in. It is not listed anywhere, and search engines are
asked not to index it. Turn it off and the link stops working on the next load.

**Show each member's callsign** decides how much the public sees. Off (the default), the public page
shows club totals, charts, the heat map and places, but no rankings, no member table and no "By"
column. You always see callsigns on your own page. Members are not notified when you make a page
public, so tell them first.

## Set it up

1. Open **Groups** and select **Statistics** on the group's card.
2. Choose the **Period**.

To share the page:

1. Open the group's **Settings** tab.
2. Turn on **Public statistics page**. The **Make the statistics page public?** dialog lists what
   anyone with the link will see.
3. Check **Show each member's callsign on the public page** if you want names and rankings shown.
4. Select **Make public**, then **Save changes**.
5. The link appears with **Copy link** and **Open page**.

## Common setups

**Club newsletter.** Public page on, **Show each member's callsign** on, link in the newsletter.
Members see the rankings.

**Privacy-minded club.** Public page on, **Show each member's callsign** off. Visitors see the club's
totals and places, not who did what.

**Owner only.** Leave the page private. Only you see it, signed in.

## When it doesn't work

**The public link says "This page is private".** The page is off, the link is mistyped, or the group
was deleted. Those look the same on purpose.

**A member is missing from the rankings.** Members with no spots in the period are left out of the top
lists, and a hidden callsign never appears. The member count in the header includes hidden calls,
while **Active members** doesn't.

**Numbers look stale.** They can be up to an hour old. The on-air line on the **Groups** list is live.

**"Too many lookups. Try again in a minute."** Public group pages share the per-visitor limit of 30
lookups a minute with callsign and reference pages.

<!--
Verified against:
- web/src/groups/GroupStatistics.tsx, GroupHeatMap.tsx, GroupSettings.tsx, PublicConfirmDialog.tsx, PublicGroupPage.tsx, GroupPrivate.tsx, GroupsPage.tsx, stats/model.ts
- supabase/migrations/20261019000400_group_statistics.sql (periods, one-hour cache, slug, redaction, hidden calls)
- supabase/migrations/20261027001000_iota.sql (activations and places split)
- supabase/functions/_shared/handlers/group_page.ts (no-store, shared lookup limit), callsign_profile.ts (30 a minute)
- web/vercel.json (X-Robots-Tag noindex)
Flagged: the owner header's member count includes hidden calls while statistics use the visible count.
-->
