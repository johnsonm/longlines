---
title: Goals
description: Track the states, parks and bands you still need, and stop alerts for what you've already worked.
---

A goal is a list of what you're still chasing: US states, POTA parks or bands. Add it to a connection
with a **Goal is in** rule, and the connection only alerts for spots that would work something you
still need. Contacts you log through Long Lines Relay mark entries worked automatically, or you can
mark them by hand.

## Why you'd use it

You're working all 50 states on 20m this year. You have 41. A goal with a US states requirement, plus
a **Goal is in** rule on your DX Cluster and POTA connections, means you get alerts only for stations
in the 9 states you're missing, and each state drops out the moment you log it.

## How it works

A goal has a name, a time window, a marking method and 1 to 10 requirements. Each requirement is one
kind with its entries:

| Kind | Entries |
| --- | --- |
| **US states** | Any of the 50 states (no DC or territories) |
| **Parks** | POTA references such as `US-2763`. The reference need not be in the POTA list. |
| **Bands** | 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, 6m, 2m, 70cm |

A requirement is complete when you've worked **All of these**, or **At least** a number you choose.
Under "At least", once you reach the number the remaining entries stop alerting too. A goal is
complete when every requirement is. You can have up to 50 goals, with up to 500 entries in a
requirement.

### What marks an entry worked

Only a contact you logged, or your own hand mark. **A spot never marks anything worked.**

With **From my log, using the relay**, every contact Long Lines Relay posts for your callsign is
checked against the goal, if its UTC date is inside the goal's window:

- **Band** comes from the contact's frequency.
- **Park** comes from POTA spots of the station you worked, within 30 minutes either side of the time
  you logged it. Exactly one park in that window marks it. No spot, or spots at two or more parks, and
  Long Lines can't tell (see Reviews below).
- **State** comes from the first of these that applies:
  1. The state your logger sent with the contact, if it is one of the 50. (DC or a non-US code gives
     no state.)
  2. If the station had a POTA spot within 30 minutes, the park's state. For a park that straddles a
     state line, the station's FCC license state if it is one of the park's states, else none. A park
     outside the US gives none.
  3. Otherwise, the worked station's FCC license state.

With **By hand only**, logged contacts don't mark anything; you mark entries yourself.

Either way, a hand mark is kept until you clear it.

### Reviews

When you log a station that had a POTA spot that day but none within 30 minutes of your contact, or
that was spotted at two parks around then, the contact goes to **Needs a look** on the goal's page.
Reviews only open on relay goals while a Parks requirement is incomplete. Choose the park, or **Not a
park contact**. A station with no POTA spot at all that day is treated as not a park contact without
asking.

If the two parks are in different states, the contact's state also waits for your pick. On a goal with
no incomplete Parks requirement, no review opens, so such a contact marks no state.

### The goal rule in a connection

**Goal is in** passes a spot when it matches something still needed in a requirement that isn't
complete: the spot's band, its POTA park, or its US state. A POTA spot's state is its park's state (by
the same straddling rule as above); any other spot's state is the spotted station's FCC license state.
DC and territories never match. How the goal is marked doesn't affect matching.

The rule turns itself off when the goal is complete or ended: it then passes every spot, so the
connection alerts for everything its other rules allow. The goal's page tells you when this happens.

Only Parks on the Air spots carry a POTA park. On a connection with another source, park entries can
never match, and the editor warns: "Parks in this goal can't match here", with a **Create a Parks on
the Air connection** button.

The connection's **Preview** adds a line such as "3 more matched your other rules but were skipped.
You've already worked those."

## Set it up

1. Open **Goals** and select **Add goal**.
2. Enter a **Name**, such as `WAS 20m 2026`.
3. Under **Time window**, choose **Counts contacts**: **Between dates** with **Starts** and **Ends**
   (UTC days, end day included), or **No end date** for a lifetime award.
4. Under **How entries get marked**, choose **Mark entries worked**: **From my log, using the relay**
   or **By hand only**.
5. Under **Requirements**, a new goal starts with all 50 US states. Change the **Kind**, add or remove
   entries with **Add a state**, **Add a park** or **Add a band**, and set **Complete when you've
   worked** to **All of these** or **At least**.
6. Select **Add requirement** for more (up to 10).
7. Select **Save goal**.
8. Open a connection, select **Add rule**, choose **Goal** in **Field**, pick the goal, and save.

On the goal's page, select a needed entry and **Mark as worked** to mark it by hand. To clear one,
select **Show 9 worked** (the number is your count), then **Mark as needed** on the entry. Each worked entry shows its evidence, such as "Worked K4ABC · Oct
3, 21:14 UTC · Logged in N1MM, matched to a POTA spot at 21:09".

Relay contacts count only from when your first logged contact reached Long Lines. Mark anything you
worked earlier by hand.

## Common setups

**Worked All States on 20m this year.** Kind: US states, all 50, **All of these**. Window: Between
dates, Jan 1 to Dec 31. Marking: From my log. Add the rule to a DX Cluster connection with **Band is**
20m and to a Parks on the Air connection with **Band is** 20m.

**Parks in your state you haven't hunted.** Kind: Parks, the 40 parks you still need in North Carolina.
**At least** 30. Window: No end date. Rule on a Parks on the Air connection.

**A weekend QSO party.** Two requirements: US states (all 50, **At least** 25) and Bands (80m, 40m,
20m). Window: Between dates covering the weekend. When it ends, the rule turns off; select **Copy for
2027** on the ended banner to start next year's.

## When it doesn't work

**"Entries aren't being marked automatically".** The relay hasn't sent a contact in 7 days. The page
says "Not connected" whenever no logged contact arrived in the last 7 days, even if the relay is
running and you weren't on the air. Open the relay on your logging computer, or mark entries by
hand.

**A contact didn't mark its park.** Check **Needs a look**. If the station had no POTA spot that day,
Long Lines treats it as not a park contact; mark the park by hand.

**A logged contact didn't count at all.** Its UTC date is outside the window, the goal is set to **By
hand only**, the goal was already complete, or the relay rejected it (wrong callsign, or logged more
than 30 minutes before it was posted). See [Long Lines Relay](/relay/).

**The connection alerts for everything.** The goal is complete or ended, so its rule is off. Change the
dates, add a different goal, or delete the rule.

**"Can't delete WAS 20m 2026 yet".** A connection still uses the goal. Open each one listed, remove the
goal rule, then delete.

**Saving with new dates warns that entries "go back to needed".** Contacts that marked those entries
fall outside the new window. Hand marks are never undone.

<!--
Verified against:
- web/src/goals/GoalsPage.tsx, GoalEditPage.tsx, GoalPage.tsx, RequirementEditor.tsx, RequirementCard.tsx, ReviewCard.tsx, Panels.tsx, model.ts, editModel.ts, useDeleteGoal.tsx, BlockedDeleteDialog.tsx
- web/src/subscriptions/FilterStep.tsx (goal helper and warning)
- supabase/migrations/20261029001100_goals.sql (kinds, caps, goal_status, goal_contact_facts, goal_mark, goal_park_state, reviews, relay status 7 days, copy_goal)
- supabase/migrations/20261029001200_goals_matching.sql (goal_matches, spot_us_states, skipped_worked)
- docs/superpowers/specs/2026-10-29-goals-design.md
Flagged: "Not connected" means no contact in 7 days, not relay presence; "Add as many requirements as you like" vs the 10 cap; the band picker offers 13 of the 25 bands SQL accepts.
-->
