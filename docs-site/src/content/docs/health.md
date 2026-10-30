---
title: Health
description: Check whether Long Lines is running normally, from feeds and queues to the sender, the database and scheduled jobs.
---

The **Health** page shows how Long Lines is running right now: whether each feed is current, how long
spots wait to be matched and sent, and whether scheduled jobs are succeeding. It's public.

## Why you'd use it

Your alerts went quiet during a contest weekend. Before changing your connections, check Health: if
**Pulled sources** says Delayed, the problem is upstream, not your filter.

## How it works

The **Current status** table lists each check with **Healthy**, **Delayed**, **Failing** or **No data**,
what it measures now, and the rule that changes its status:

| Check | Rule |
| --- | --- |
| **Pulled sources** (POTA, SOTAwatch, WWFF, WWBOTA) | Delayed after 3 min without a success |
| **Inbound feeds** (RBN, DX Cluster, APRS-IS) | Delayed after 3 min without a push |
| **Match queue** | Delayed when the oldest waits over 2 min |
| **Delivery queue** | Delayed when the oldest ready waits over 2 min |
| **Sender** | Failing after 2 min without progress |
| **Database** | Delayed over 80% of either connections or disk |
| **Scheduled jobs** | Failing when a job fails 3 runs in a row; delayed when one is slower or fails more than usual |
| **Archive** | Delayed after 2 hours |

When any check isn't healthy, a banner at the top names it, for example "Pulled sources are behind".

Below the table are charts for **Queues**, **Throughput and speed** (spots ingested per source and the
time from match to sent) and **Capacity**, and a **Scheduled jobs** table. Pick **1 hour**, **24
hours** or **7 days**. Times are in your local time.

The page refreshes every 60 seconds while it's open, and its data is at most 30 seconds old. It shows
numbers and statuses only, never error messages or anyone's settings. Logged contacts aren't
monitored here.

## Set it up

Open **Health**. Pick a range to see whether a problem is new or ongoing.

## When it doesn't work

**Pulled sources or Inbound feeds is Delayed.** An upstream feed is down or slow. Long Lines keeps
retrying. Spots that arrive more than 5 minutes late are dropped, so there will be a gap in alerts.

**Delivery queue is Delayed but everything else is Healthy.** Some destinations are rate-limited or
busy. The **Now** column shows how many are throttled. If it's your destination, see
[Destinations](/destinations/#when-it-doesnt-work).

**Sender is Failing.** Nothing is being delivered to anyone. The sender restarts on its own.

<!--
Verified against:
- web/src/health/HealthPage.tsx, model.ts, useHealth.ts
- supabase/migrations/20261028000200_inbound_worker.sql (health_snapshot thresholds, pulled list)
- supabase/migrations/20261021000100_health.sql (30 s cache)
Not verified: that the sender restarts on its own is from CLAUDE.md "Sender rules" (watchdog exits, Fly restarts), not observed.
-->
