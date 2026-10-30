---
title: The relay's DX cluster
description: Turn on the relay's local DX cluster and connect N1MM Logger+ or other logging software to it for matched spots in your bandmap.
---

The relay can run a small DX cluster on your computer. Your logging software connects to it through
its Telnet (DX cluster) window, as it would to a DXSpider node on the internet, and gets each spot that
one of your Long Lines connections matches for a [Local DX cluster](/destinations/local-dx-cluster/)
destination.

## Why you'd use it

You hunt parks from N1MM Logger+. Instead of a full cluster feed, your bandmap shows only POTA
activators on 40m and 20m, because that's what your connection passes.

## How it works

- **It only receives.** Nothing your logger sends through the cluster reaches Long Lines, and spots
  you enter in the logger go nowhere ("Spots can't be sent through Long Lines Relay."). Nothing tunes
  your radio.
- **Nothing listens until you turn it on.** Then it listens at `127.0.0.1` on port `7373`. If another
  program has 7373, the relay uses the next free port up to 7399 and shows that one. A port you pick
  with **Change port** is always used.
- **Any callsign logs in.** The relay asks `login:`, accepts any callsign, and greets the logger. There
  is no password.
- **No backlog.** Spots arrive as they are spotted, only while the relay is running and connected. A
  spot already shown isn't shown again within 10 minutes.
- **Other computers** can connect only while **Let other computers on this network connect** is
  ticked. Anyone on your network can then read your spots.

The tab's chip says **Off**, **Listening** (on, no spot sent yet), **Running** (spots have gone out),
**Port in use** or **Sign in again**. Below the switch it shows "Last spot sent 3 minutes ago · 12
spots today" and how many programs are connected. Once spots flow, **Spots sent** lists the last 50, such as
`K4ABC · 14062.0 kHz CW` with "POTA K-0039 · from POTA states, CW".

Each spot reaches your logger as one line:

```
DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z
```

The relay answers `bye` and `quit` by closing the connection, and ignores the commands loggers send on
connect, such as `set/page 0` or `sh/dx`.

## Set it up

You need the relay signed in with permission to receive spots, and a Local DX cluster destination for
this relay linked to at least one connection.

1. In Long Lines, add a [Local DX cluster](/destinations/local-dx-cluster/) destination and choose
   this computer's relay. **Add destination** on the relay's **DX cluster** tab opens that page.
2. Link the destination to the connections whose spots you want in the bandmap.
3. In the relay, open the **DX cluster** tab and turn on **Local DX cluster**.
4. Note the **Address** and **Port** for **This computer**, such as `127.0.0.1` and `7373`. **Set up
   logging software** shows them with copy buttons and the steps for **N1MM Logger+** or **Other
   software**.
5. In N1MM Logger+, open **Window > Telnet**. Add a new cluster with address `127.0.0.1` and port
   `7373`. (N1MM keeps its cluster list behind the **Edit** button next to the cluster drop-down.)
6. Select the cluster and **Connect**. Answer `login:` with your callsign if N1MM doesn't. You'll
   see:

   ```
   Hello KK4PWJ, this is Long Lines Relay on SHACK-PC. Spots from your Long Lines connections appear here.
   KK4PWJ de LONGLINES 28-Oct-2026 2114Z >
   ```

7. Select **Send test spot** in the relay. A spot for `LLTEST` on 14050.0 kHz CW should show up in the
   Telnet window and the bandmap:

   ```
   DX de KK4PWJ:    14050.0  LLTEST       CW Long Lines Relay test spot  2102Z
   ```

For other logging software, open its DX cluster or Telnet settings, add a cluster with the relay's
address and port, connect, and send a test spot.

## Common setups

**One shack computer.** Relay and N1MM Logger+ on the same PC. Address `127.0.0.1`, port `7373`.

**Logger on a second computer.** Tick **Let other computers on this network connect**. The tab adds
**Other computers** with this computer's network address, such as `192.168.1.42`. Use that address
and port `7373` in the other computer's logger, and allow the relay through this computer's firewall.

**Another program on port 7373.** Select **Change port**, enter `7380`, and use port `7380` in your
logger.

## When it doesn't work

**"No destination sends spots to this computer yet."** Add a Local DX cluster destination for this
relay in Long Lines and link it to a connection.

**"Sign in again to use the DX cluster".** This computer was signed in before the relay could receive
spots. Select **Sign in again** and select **Allow** in your browser.

**"Port 7373 is in use by another program".** Another program has the port you chose, or on the
default port, every port from 7373 to 7399. Choose another port in the relay and in your logger.

**"Couldn't reach Long Lines for spots. Trying again in 0:30."** The relay retries by itself. Your
logger stays connected and gets spots again once the relay is back. Spots that matched meanwhile are
not replayed.

**The test spot shows in the Telnet window but not the bandmap.** N1MM Logger+ applies its own spot
filters and band limits. The test spot is on 20m CW.

**Spots show under "Spots sent" but not in the logger.** Check that the logger is connected (the tab
counts programs connected), then its spot filters and band limits.

**"Couldn't send the test spot. Check that the DX cluster is on."** Turn on **Local DX cluster**
first. **Send test spot** works only while it's listening.

<!--
Verified against:
- sonyccd/longlines-relay at cd60f2c: docs/loggers.md (DX cluster section, greeting and test spot lines, N1MM steps), README.md
- src/copy.ts (cluster and dxSetup copy), src/components/DxClusterCard.tsx (switch, details table, LAN checkbox, Add destination, Set up logging software, Change port, Send test spot only while listening), src/screens/DxSetupScreen.tsx, MainScreen.tsx (Spots sent shown once spots exist)
- crates/relay-core/src/state.rs (cluster chip labels, SENT_LIMIT 50, row title and detail), engine.rs (SPOT_REPEAT_WINDOW 600 s, LLTEST), cluster/server.rs (7373 to 7399, bye/quit/DX handling), settings.rs (DEFAULT_CLUSTER_PORT)
- src-tauri/src/lib.rs (ADD_DESTINATION_URL)
- supabase/migrations/20261028000500_local_cluster.sql (2-minute max age: matched spots are not replayed)
Not verified by hand (the relay's own docs list these under "Still to confirm by hand"): that N1MM Logger+ answers login: by itself, where it keeps its cluster list, and that the test spot reaches its bandmap. The 0:30 countdown is an example.
-->
