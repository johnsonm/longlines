---
title: Sources
description: Where Long Lines gets its spots, how fast each source arrives, and which spots it drops.
---

A source is a feed of spots that Long Lines reads around the clock: POTA, SOTA, WWFF, WWBOTA, the
DX Cluster, the Reverse Beacon Network, APRS-IS, IOTA references in DX Cluster spots, and contacts
operators log through Long Lines Relay. Every connection you build starts from exactly one of them.

## Why you'd use it

You want to know whether a SOTA alert will reach you in time to chase the activator. The **Sources**
page tells you that SOTAwatch is read every 30 seconds, whether the feed is running right now, and how
many spots an hour it carries, so you know what to expect before you build the connection.

## How it works

Open **Sources** in the navigation. Each tile shows the source's status, its volume (**High volume**
or **Standard volume**) and its average rate over the last 7 days in spots/hour. The status chip is
**Connected** while the feed is current and **Delayed** when Long Lines hasn't read it successfully
for three times its normal interval (3 minutes for most sources, 90 seconds for SOTA).

| Source | How it arrives | Usual delay before matching |
| --- | --- | --- |
| Parks on the Air | Spot list read every 60 seconds | Up to about a minute |
| SOTA | SOTAwatch spot list read every 30 seconds | Up to about 30 seconds |
| WWFF | Spot list read every 60 seconds | A minute or a bit more (the WWFF feed is itself cached for 60 seconds) |
| WWBOTA | Spot list read every 60 seconds | Up to about a minute |
| DX Cluster | Live telnet stream from a DXSpider node | About 10 seconds |
| Reverse Beacon Network | Live telnet stream of skimmer spots | About 10 seconds |
| IOTA | Read out of DX Cluster spots | Same as DX Cluster |
| Logged contacts | Posted by Long Lines Relay as you log | Seconds |
| APRS-IS | Live stream of the full APRS-IS feed | About 10 seconds (see below) |

The streamed sources hand spots over in batches: a batch goes when its oldest line is 10 seconds old
or 1,000 lines have built up. After a spot is stored, matching runs right away, and the destination's
own pacing applies from there (see [Destinations](/destinations/)).

### Spots Long Lines drops

Not every spot a feed carries reaches your connections.

- **Old spots.** A POTA, SOTA, WWFF, WWBOTA, DX Cluster, RBN or APRS-IS spot whose own time is more
  than 5 minutes before Long Lines reads it is skipped. A feed that stalls and then catches up does not
  flood you with stale spots.
- **Test spots.** A POTA, SOTA, WWFF or WWBOTA spot whose comment has the word "test" or "testing" is
  skipped. DX Cluster and RBN spots have no such check.
- **SOTA QRT and other non-normal spots.** Only SOTAwatch spots of the normal type are kept, so QRT
  spots never arrive.
- **WWBOTA test and QRT spots.** A WWBOTA spot marked Test is skipped, and so is a QRT spot with no
  frequency. A QRT spot that does carry a frequency is kept.
- **Skimmer lines on the DX Cluster.** A DX Cluster line from a skimmer (a spotter ending in `-#`, or
  an RBN-style "12 dB 22 WPM" comment) is dropped, because the Reverse Beacon Network already covers
  those.
- **APRS-IS packets that aren't positions.** Only position, Mic-E, object and item packets become
  spots, at most one per station every 15 minutes. Messages, status, weather, telemetry and the rest
  are stored but never matched.

A spot whose content changes upstream (a new frequency, mode or comment) counts as a new spot and can
be delivered again. Reading the same unchanged spot twice never delivers it twice. To limit repeats
from one activator, use **Repeat spots for the same station** on the connection.

### Bands and modes

Long Lines works out the band from the frequency. A frequency outside every amateur band has no band,
so it never passes a **Band is** rule.

The mode comes from the feed when the feed has one. USB and LSB are stored as SSB. When a feed says
only "DATA" or "DIGI" and the comment names a mode such as FT8, the comment wins. SOTAwatch offers only
DATA for digital modes, so an FT8 activation on SOTA often arrives as plain digital. Pick **Any
digital** in a Mode rule to catch it.

DX Cluster lines have no mode field. Long Lines takes the first mode named in the comment (CW, SSB,
RTTY, FT8, FT4, PSK31 and so on). With none, it uses the band plan: the FT8 and FT4 dial frequencies
first, then the CW, digital and phone segments for 160m through 6m. It does not read FM or AM from a
comment, and it does not guess on 60m or on VHF and up, so those spots often have no mode.

### Notes on each source

**Parks on the Air.** Activator spots from api.pota.app, with the park reference, park name and
location (for example `US-NC`). Shown on the band map and in Stats.

**SOTA.** Summit spots from SOTAwatch, with the summit reference. When a spot was posted by the
RBNHole bot, Long Lines takes the real skimmer's call from the comment as the spotter. Shown on the
band map and in Stats.

**WWFF.** Activator spots from spots.wwff.co, with the reference and its name. WWFF overlaps POTA
heavily and Long Lines does not merge the two, so a park that is both a POTA and a WWFF reference can
reach you twice if you have connections on both sources. Shown in Stats, not on the band map.

**WWBOTA.** Bunker spots from api.wwbota.net. One spot can name several bunkers; Long Lines keeps all
of them (up to 50) and the first bunker's name. Not in Stats or on the band map.

**DX Cluster.** Human-entered spots from a DXSpider node. DXSpider cuts comments at 30 characters.
There is no park, summit or reference on a DX Cluster spot, except an IOTA reference when the comment
has one. Shown on the band map.

**Reverse Beacon Network.** Skimmer spots from telnet.reversebeacon.net, CW and RTTY only. FT8 and FT4
skimmer spots are not read. The comment holds the signal strength and speed, such as `18 dB 24 WPM CQ`.
This is a high-volume source: a connection on it must name stations with a Callsign or Callsign group
rule, and only spots for stations some connection names are matched at all. See
[Filter rules](/filter-rules/#reverse-beacon-network-and-aprs-is-need-a-station).

**IOTA.** Not a feed of its own. Long Lines reads the first IOTA reference in the form `EU-005` out of
each DX Cluster comment (`EU005` and `EU 005` are not recognized) and names the island group from the
IOTA list, refreshed monthly. Picking IOTA when you create a connection gives you a DX Cluster
connection with an **IOTA island is Any island** rule.

**Logged contacts.** Contacts that operators log, posted by [Long Lines Relay](/relay/). The operator
who logged the contact is the spotter, and the station worked is the callsign. There is no comment
and no reference. A connection on Logged contacts gets every Long Lines operator's logged contacts,
not only yours. When an operator edits a contact in their logger, the old spot is replaced; when
they delete it, the spot is taken down. Deliveries already sent are not recalled.

**APRS-IS.** Every packet on the full APRS-IS feed, stored for about two days and then archived, and
counted on the [Stats](/stats/) page. Like RBN it is high volume: a connection on it must name
stations with a Callsign or Callsign group rule, and only those stations' position beacons are
matched, at most one spot per station every 15 minutes. The spot's callsign is the station that sent
the packet, the spotter is the igate that heard it (when one did), and the comment is the packet as
sent, such as `=3546.12N/07838.55W>Mobile`. An APRS-IS spot has no frequency, band or mode, so a
Band, Mode or Frequency rule never passes it, except with **is not**, which always does: only
Callsign and Callsign group rules tell APRS-IS spots apart. "Any source" never includes APRS-IS, and
APRS-IS spots never reach profiles, the band map or the
[Local DX cluster](/destinations/local-dx-cluster/).

### The source page

Select a tile to open its page. It shows:

- **Average, 7 days**, **Peak, 7 days**, **Minimum, 7 days** and **Busiest moment**, from the hourly
  Stats snapshot. New sources show "No rates yet" until the next hourly refresh.
- **Rate over time** for the last 7 days, with a red dot on the busiest hour.
- **Schema** and **Example spot**: every field on a spot from this source, as a webhook receives it.
- **Recent spots**: the newest 100 spots from the last 24 hours, before any connection filters,
  refreshed every 30 seconds while the tab is open. The footer says when the source was last read,
  for example "Last fetch 12s ago, every 60s". APRS-IS has no Recent spots list.
- **Your connections**: the connections you have on this source.
- **Create connection**, which starts a new connection on this source.

## Set it up

There is nothing to set up. To use a source:

1. Open **Sources** and select the source's tile.
2. Check the status chip and the **Recent spots** list to see what the feed carries right now.
3. Select **Create connection**. The connection editor opens with this source already chosen. See
   [Connections](/connections/).

## When it doesn't work

**The tile says Delayed.** Long Lines hasn't read the feed for three intervals. Most often the
upstream site is down or slow. Check [Health](/health/), where **Pulled sources** and **Inbound
feeds** show the same thing in more detail. Spots that arrive more than 5 minutes late are dropped,
so an outage leaves a gap rather than a burst of late alerts.

**An activator is on the air but no spot arrived.** Look at the source's **Recent spots**. If the
spot isn't there, Long Lines never stored it: it may have been older than 5 minutes when read, had
"test" in the comment, or (SOTA) been a QRT spot. If it is there, the problem is in your connection's
filter or its destination.

**FT8 SOTA spots don't match a Mode is FT8 rule.** SOTAwatch reports digital modes as DATA. Use **Any
digital**.

**A DX Cluster spot has no mode.** The comment named none and the frequency fell outside the band
plan's guesses (60m, VHF and up, or a gap). Filter on band or frequency instead.

**An IOTA activation was missed.** The spotter wrote the reference without the dash (`EU005`) or put
it in a form Long Lines doesn't read. Only `XX-NNN` with a continent code is recognized.

<!--
Verified against:
- web/src/sources/sources.ts (catalog copy, pollSeconds, volume, LIVE_SOURCES)
- web/src/sources/status.ts (Delayed = 3 x pollSeconds)
- web/src/sources/SourcesPage.tsx, SourceTile.tsx, SourceDetailPage.tsx, RecentSpotsCard.tsx, rates.ts
- supabase/functions/_shared/pota.ts, sotawatch.ts, wwff.ts, wwbota.ts, dxcluster.ts, rbn.ts, iota.ts, logged.ts (MAX_AGE_MS, skips)
- supabase/functions/_shared/normalize.ts (isTestComment, bounds)
- supabase/functions/_shared/modes.ts (resolveMode, resolveDxMode, band plan)
- inbound/feeds.ts (RBN port 7000, DX Cluster node), inbound/forwarder.ts (10 s / 1,000 lines)
- supabase/migrations/20261021000100_health.sql, 20261026001000_wwbota_source.sql (cron cadence)
- supabase/migrations/20261028000300_logged_contacts_source.sql (source_matches)
- supabase/migrations/20261031000100_aprs_connections.sql, supabase/functions/_shared/aprs.ts (APRS-IS spots, 15-minute bucket)
Not verified: real-world WWFF delay with the upstream 60 s cache; which DX Cluster node production uses.
-->
