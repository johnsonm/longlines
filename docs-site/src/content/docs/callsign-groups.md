---
title: Callsign groups
description: Keep a named list of callsigns, like a club roster, and use it in connection rules.
---

A callsign group is a named list of up to 1,000 callsigns, such as a club roster or the stations you
need for an award. You use it in connections with a **Callsign group is in** rule, and you can see and
share its statistics.

## Why you'd use it

Your club has 140 members and you want a Discord post whenever any of them is spotted on POTA, SOTA or
RBN. Put the roster in one group and use it in three connections. When someone joins, add them once
and all three connections pick them up.

## How it works

**Members are base calls.** Long Lines stores each member without portable prefixes or suffixes:
`W1AW/P`, `VP2V/W1AW` and ` w1aw ` all become `W1AW`. A group member W1AW then matches spots of
W1AW/P, W1AW/M, VP2V/W1AW and so on. Suffixes dropped are `/P`, `/M`, `/MM`, `/AM`, `/QRP`, `/QRPP`,
`/R` and single digits; of what's left, the longest part is kept.

**Membership is live.** A connection stores the group, not a copy of its calls, so editing the group
changes every connection that uses it on the next spot.

**An empty group matches nothing.** A **Callsign group is in** rule whose groups are all empty passes
no spots; it never falls back to "any station".

**A group counts as naming stations,** so it satisfies the Reverse Beacon Network requirement for a
Callsign or Callsign group rule.

**Delete is blocked while a connection uses the group.** Remove the rule from those connections first.
Delete has no confirmation step once it's allowed.

You can have up to 50 groups. Names are unique in your account, ignoring case.

## Set it up

1. Open **Groups** and select **New group**.
2. Enter a **Name**, such as `Club roster`.
3. Enter **Callsigns**, separated by commas, spaces or new lines:
   `KK4PWJ, W4DOG, N4XYZ/P`.
4. Leave **Public statistics page** off unless you want to share the statistics now.
5. Select **Create group**. If any value isn't a callsign, nothing is saved and you see "Not a
   callsign: {value}." Fix it and try again.

To edit members later, open the group's **Settings** tab. The **Members** card has three ways in:

- **Type**: enter a **Callsign** and press Enter or select **Add**. Spaces or commas add several.
- **Paste**: paste a list into **Paste callsigns** and select **Add callsigns**.
- **Import CSV**: select **Choose file**. Long Lines uses the column headed Call or Callsign (or Call
  sign, Call_sign), or the first column if there is none, and tells you how many calls it found and
  skipped. Select **Add**.

Values that aren't callsigns are left out with a warning listing them. Remove a member with the x on
its chip, or all of them with **Remove all**. Nothing is saved until you select **Save changes** at the
top of the page.

To use the group, select **Get alerts** on its card or page, pick a source and **Continue**. A new
connection opens with **Callsign group is in** your group, named "Club roster on the air". If you
already have a connection with that rule, Long Lines opens it instead.

## Common setups

**Club roster on POTA.** Group `Club roster` imported from the club's member CSV. Connection: Parks on
the Air, **Callsign group is in** Club roster, repeat **At most once per 30 minutes**, to the club
Discord.

**Award chase list.** Group `DXCC needed` with the calls of current DXpeditions you still need.
Connection: DX Cluster, **Callsign group is in** DXCC needed, to push with **Urgency** High.

**Friends on RBN.** Group `Friends` with six calls. Connection: Reverse Beacon Network, **Callsign group
is in** Friends **And** **Band is** 20m, 40m, to a Local DX cluster.

## When it doesn't work

**"Not a callsign: W1AW/12345."** Long Lines accepts a call with at most one `/suffix`, and the base
call must look like an amateur callsign. Remove or fix the value.

**"A group can hold up to 1,000 callsigns."** Split the list into two groups and use both in the rule.

**Delete group is greyed out.** The tooltip says how many connections use it. Remove the group from
each one under **Used by**, then delete.

**A member's spots don't match.** Check the spot's callsign. A member `W1AW` matches `W1AW/P`, but a
spot of `W1AWX` or a different base call doesn't. Members are whole calls; there are no prefixes or
wildcards.

<!--
Verified against:
- web/src/groups/GroupsPage.tsx, NewGroupDialog.tsx, GroupSettings.tsx, MemberEditor.tsx, model.ts, parse.ts, useGetAlerts.tsx
- supabase/migrations/20261013000210_callsign_groups_ui.sql (normalize_group_callsigns)
- supabase/migrations/20261012000040_callsign_rollups.sql (base_callsign suffix list)
- supabase/migrations/20261013000330_callsign_group_matching.sql (empty group passes nothing, base-call match)
- supabase/migrations/20261019000400_group_statistics.sql (1,000 cap, Not a callsign error)
- supabase/migrations/20261021000500_api_fixes.sql (delete guard)
- supabase/migrations/20261029000200_account_caps.sql (50 groups)
- supabase/tests/callsign_groups.test.sql (normalization examples)
Flagged: group delete has no confirmation, unlike connections, destinations and goals.
-->
