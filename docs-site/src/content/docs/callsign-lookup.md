---
title: Callsign lookup
description: See everything Long Lines has heard from a station, with its FCC license details.
---

**Callsign lookup** opens a profile for any callsign: FCC license details, when and where the station
was last heard, a year-long activity heat map, and who hears it. Profiles are public and each has its
own link, such as `longlines.io/call/KK4PWJ`.

## Why you'd use it

You want to know when a friend is usually on the air before setting up an alert. Their profile's
**When they're on the air** chart shows spots by hour of day in UTC, and **Bands** shows where to
listen.

## How it works

A profile covers one base call. `KK4PWJ/P`, `KK4PWJ/QRP` and `W4/KK4PWJ` all open the `KK4PWJ`
profile, and the page address changes to the base call. **Also heard as** lists up to 5 other forms
the station was spotted under.

The profile counts spots from every source except APRS-IS: POTA, SOTA, WWFF, WWBOTA, DX Cluster, RBN
and logged contacts. It runs from when Long Lines started collecting.

The profile has three tabs under its header: **Activity** (the sections below, except **Recent
spots**), **Spotted activations** (see [Spotted activations](/spotted-activations/)) and **Spots**
(**Recent spots**). Each tab has its own link, such as `longlines.io/call/KK4PWJ?tab=spots`.

| Section | What it shows |
| --- | --- |
| Header | The call, its country flag, the license name, class and state, **Get alerts**, **Share** and **QRZ** |
| **Last heard** | Frequency, mode, band, source and time of the latest spot; **On the air now** if it was within 30 minutes; the park or summit and spotter |
| Figures | **Spots** (all time), **Days on the air**, **Heard from** (countries and continents), park, summit and other reference visits |
| **Activity over the past year** | A heat map of spots per day. Pick **Past 12 months** or a single year (on desktop). Shading is relative to the period shown. |
| **License** | Name, class, status, granted and expiry dates, state. From the FCC Universal Licensing System, refreshed weekly. |
| **Activity**, **Last 30 days**, **When they're on the air** | Spots per month, per day, and by hour of day (UTC) |
| **Bands**, **Modes** | Where and how the station operates |
| **Where they've been spotted** | Parks, summits, WWFF references, bunkers and islands, most recent first, with a US state map |
| **Heard from** | The countries of the spotters and skimmers who heard it. Self-spots don't count. |
| **Hunting** | Spots this station posted for other activators |
| **Heard by** | The spotters and skimmers that picked it up in the last 7 days, with best SNR |
| **Recent spots** (Spots tab) | The newest 25 spots from the last 7 days |

License data is FCC only. A non-US call shows "No FCC record. This looks like a callsign issued outside
the United States." Long Lines never shows street addresses.

A profile can be up to about 20 minutes old: Long Lines caches it for 15 minutes, and your browser for
5 more. Times are UTC, except the **Recent spots** table when you're signed in with **Show spot times
in UTC** off.

### Limits

Lookups are limited to 30 a minute per visitor, shared with reference pages, reference searches,
public group pages and spotted activations. Over the limit you see "Too many lookups. Try again in a minute." Going back to a
page you opened in the last 5 minutes doesn't count.

## Set it up

1. Open **Callsign lookup**.
2. Type a callsign in the search box (it says "Callsign, like KK4PWJ") and select **Look up**. Or select one of the **Busy this
   week** chips, the most active activators from the Stats page.
3. To get alerts for the station, select **Get alerts for KK4PWJ**, pick a source and select
   **Continue**. A new connection opens with **Callsign is KK4PWJ**. Signed out, the button says
   **Sign in to get alerts**.
4. To send someone the profile, select **Share**.

## When it doesn't work

**"KK4PWJ! isn't a valid callsign."** The lookup takes letters and digits in up to three
`/`-separated parts, at most 20 characters.

**"Long Lines hasn't heard KK4PWJ on the air yet."** No spot of that base call has reached Long Lines.
If the station posted spots for others, the **Hunting** card still shows.

**"No FCC record found for this callsign."** The call has a US prefix but isn't in the weekly FCC load:
it's new, expired, or mistyped. A hidden profile shows the same.

**Today's activity looks low.** The heat map and charts include today, but the profile can be 20
minutes behind.

**I want my profile hidden.** There is no setting for this. If the profile footer shows a contact
address, email it; the operator hides calls by hand. A hidden call shows the not-heard page and drops
out of the band map, reference pages and Stats top lists.

<!--
Verified against:
- web/src/profile/LookupPage.tsx, LookupForm.tsx, CallsignPage.tsx, format.ts, calendar.ts, ActivityHeatMap.tsx, HeatMapCard.tsx
- supabase/migrations/20261019000300_callsign_calendar.sql (callsign_profile sections, periods, limits)
- supabase/migrations/20261021000550_profile_cache_ttl.sql (15-minute cache)
- supabase/migrations/20261012000060_callsign_profile.sql (hidden_callsigns managed by the operator)
- supabase/functions/_shared/handlers/callsign_profile.ts (30 a minute, shape check, max-age 300)
- supabase/migrations/20261028000300_logged_contacts_source.sql (spot_stream includes logged)
Flagged: the "To have this page hidden, email ..." line only appears when the build sets VITE_CONTACT_EMAIL; unknown whether production sets it.
-->
