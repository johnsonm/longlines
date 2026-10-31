---
title: Filter rules
description: Every field a connection can filter on, how And and Or combine, and how each one matches a spot.
---

A connection's filter is a list of rules. Each rule is a field, a condition and one or more values,
such as **Band is** 20m, 40m. A spot passes the filter when it satisfies the rules as you joined them
with And and Or.

## Why you'd use it

You want SOTA activators on 2m FM, plus anyone on HF from your favorite association. Two groups of
rules joined by Or do it: **Band is** 2m **And** **Mode is** FM **Or** **Park, summit, or location
contains** `W4C/`.

## How it works

### And and Or

The first rule starts with **Where**. Every rule after it has a **Join** of **And** or **Or**. And
binds tighter than Or: a spot passes when it matches every rule between two Ors.

So `Band is 20m And Mode is CW Or Callsign is KK4PWJ` reads as "(20m CW) or KK4PWJ on anything". The
heading above the rules changes to say which you built: "Pass spots that match all of these rules",
"…any of these rules", or, when you mix them, "And comes before Or".

An empty filter passes every spot. A rule row with no values is ignored when you save, so an
unfinished row never widens the filter. You can have up to 50 rules, up to 1,000 values in one rule
and 5,000 values across the connection.

### "is" and "is not"

**is** passes a spot that has any of the values. **is not** passes a spot that has none of them,
including a spot that has no value for that field at all. **Park, summit, or location is not**
`US-2763` passes every DX Cluster spot, because those carry no park.

### The fields

Which fields you see depends on the source. Reverse Beacon Network and Logged contacts connections
have no reference or island rule, because those spots carry no reference. APRS-IS spots carry no
frequency, band, mode or reference either, so only Callsign, Callsign group and Goal rules mean
anything there.

| Field | Conditions | Values |
| --- | --- | --- |
| **Callsign** | is, is not | Calls you type. Press Enter after each, or paste a list separated by spaces or commas. |
| **Callsign group** | is in, is not in | One or more of your [callsign groups](/callsign-groups/) |
| **Goal** | is in | Exactly one of your [goals](/goals/) |
| **Band** | is, is not | 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, 6m, 2m, 70cm |
| **Mode** | is, is not | Any digital, CW, SSB, FM, AM, FT8, FT4, RTTY, PSK |
| **Park, summit, or location** | is, is not, contains, does not contain | References such as US-2763 or W4C/CM-001, or text |
| **Frequency (kHz)** | is, is not, is greater than, is less than | One number in kHz, such as 14074 |
| **IOTA island** (DX Cluster only) | is, is not | References such as EU-005, continents, or Any island |

There are no rules for the spotter, country, grid square, comment text or US state (states come in
only through a goal).

**Callsign.** A value matches the call as spotted or its base call. `KK4PWJ` catches `KK4PWJ/P`,
`W4/KK4PWJ` and `KK4PWJ/QRP`. A value with a suffix, such as `KK4PWJ/P`, matches only that exact
form. There are no wildcards or prefix matches: `KK4` does not catch `KK4PWJ`.

**Callsign group.** Matches when the spot's base call is a member of any of the groups you pick.
Membership is live: when you edit the group, every connection that uses it changes. A **Callsign
group is in** rule whose groups are all empty passes nothing. The helper under the rule says how
many stations your callsign and group rules name.

**Band.** The band is worked out from the frequency. A frequency outside the amateur bands has no
band.

**Mode.** **Any digital** catches every digital mode: FT8, FT4, JS8, RTTY, PSK31, Olivia, WSPR, SSTV
and the generic DATA that SOTAwatch reports. **SSB** catches USB and LSB. The other choices match
that exact mode only. **PSK** does not catch spots stored as PSK31 or PSK63; use **Any digital** for
those.

**Park, summit, or location** with **is** or **is not** is an exact match against the spot's POTA
park, SOTA summit, WWFF reference, IOTA reference, or any of a WWBOTA spot's bunkers. `US-1000` never
matches `US-10000`. As you type, Long Lines suggests entries from the POTA, SOTA and WWFF lists (only
the one program your source carries, if it carries one). A reference that isn't in any list still
goes in when you press Enter. Values are upper-cased and must be letters, digits, `/` and `-`, up to
64 characters.

**Park, summit, or location** with **contains** or **does not contain** looks for your text anywhere
in the spot's references and its POTA location, ignoring case. `US-NC` catches every park located in
North Carolina, `W4C/` every summit in that association, `KFF-` every WWFF reference in the US.

**Frequency (kHz).** **is** is an exact match, so it is rarely what you want. Use **is greater than**
and **is less than** together to cover a range: `is greater than 14000` **And** `is less than 14070`
gives you the 20m CW segment.

**IOTA island.** A reference such as `EU-005` matches that island group. A continent code such as
`EU` matches every island on it. **Any island** fills in all seven continents. Spots without an IOTA
reference never pass **is**.

**Goal.** Passes a spot that matches something the goal still needs: a band, a POTA park or a US
state. When the goal is complete or has ended, the rule is off and passes every spot. See
[Goals](/goals/).

### Reverse Beacon Network and APRS-IS need a station

RBN sends hundreds of thousands of spots a day, and APRS-IS millions of packets. On an RBN or
APRS-IS connection, every group of rules between two Ors must contain a **Callsign is** or **Callsign group is in** rule. Save stays disabled until it
does, with the message "High volume source: at least one callsign or group is required." A goal rule
does not count, because it names no stations.

## Set it up

1. In the connection editor, under **Filter**, select **Add rule**.
2. Choose the **Field**. Changing the field clears the row's values.
3. Choose the **Condition**.
4. Enter the **Values**. For calls and references, press Enter after each one.
5. To add a second rule, select **Add rule** again and set **Join** to **And** or **Or**.
6. Watch the **Preview** card update as you edit.
7. Select **Save connection**.

## Common setups

**20m CW in North Carolina parks.** Source: Parks on the Air.

| Join | Field | Condition | Values |
| --- | --- | --- | --- |
| Where | Band | is | 20m |
| And | Mode | is | CW |
| And | Park, summit, or location | contains | US-NC |

**Any digital mode, except FT8.** Source: SOTA.

| Join | Field | Condition | Values |
| --- | --- | --- | --- |
| Where | Mode | is | Any digital |
| And | Mode | is not | FT8 |

**Friends on RBN, but only below 7040 kHz.** Source: Reverse Beacon Network.

| Join | Field | Condition | Values |
| --- | --- | --- | --- |
| Where | Callsign group | is in | Friends |
| And | Frequency (kHz) | is less than | 7040 |

## When it doesn't work

**A rule row is red.** The value is not valid for that field. Examples: "Enter a frequency in kHz,
such as 14074." or "Type a reference such as EU-005, or pick a continent."

**A park I added never matches.** Check the condition. **is** needs the exact reference; to catch a
whole state or prefix, use **contains**.

**The connection sends spots I excluded.** Check the joins. `Band is 20m Or Band is 40m And Mode is
CW` means "anything on 20m, or CW on 40m", not "CW on 20m or 40m". Put both bands in one **Band is**
rule instead.

**"Parks in this goal can't match here".** The connection's source doesn't carry POTA parks. See
[Goals](/goals/#when-it-doesnt-work).

<!--
Verified against:
- web/src/subscriptions/FilterStep.tsx (Where/Join, Add rule, headings, helpers, RBN messages)
- web/src/subscriptions/model.ts (fields per source, ops wording, 50 rows, rulesOf drops empty rows)
- web/src/sources/sources.ts (band and mode choices)
- supabase/migrations/20261029001200_goals_matching.sql (normalize_subscription_rules limits, rule_matches)
- supabase/migrations/20261014000500_subscription_rules.sql (spot_matches, rules_name_stations, empty rules pass)
- supabase/migrations/20261012000010_base_callsign.sql (callsign_matches)
- supabase/functions/_shared/modes.ts (digital family, PSK31/PSK63 kept distinct)
Flagged: whether "PSK" missing PSK31/PSK63 spots is intended.
-->
