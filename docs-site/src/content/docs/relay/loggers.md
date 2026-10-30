---
title: Set up your logging software
description: Point N1MM Logger+, DXLog.net, MacLoggerDX or Not1MM at Long Lines Relay so each contact you log is posted.
---

The relay listens for the contact broadcasts your logging software sends on your computer, in the
N1MM Logger+ format. You set your logger to send them to the relay once; after that, every contact
you save is posted to Long Lines.

## How it works

Your logger needs three things set:

1. **Contact broadcasts on.** Each saved contact goes out as a small network packet.
2. **Sent to this computer on the relay's port.** The address is `127.0.0.1` and the port is
   `12060` unless you changed **UDP port** in the relay's **Settings** card. The relay shows its port
   under **Logging feed**.
3. **Your station callsign as the logged callsign.** The relay only posts contacts logged under the
   callsign of the Long Lines account it is signed in to. Portable forms such as `W4/KK4PWJ`,
   `KK4PWJ/P`, `KK4PWJ/M` and `KK4PWJ/QRP` count as the same station, and the call is posted exactly
   as you logged it.

| Logger | Works with the relay | Notes |
| --- | --- | --- |
| N1MM Logger+ | Yes | New contacts, edits and deletes. |
| DXLog.net | Yes, with "Use N1MM QSO format" on | Its own (traditional) format doesn't work. |
| MacLoggerDX | Version 6.58 or later | Set the broadcast address to `127.0.0.1`. Not yet tested with a real packet. |
| Not1MM | New contacts only, with two settings changed | Sends the operator, not the station callsign, and uses port 12061 by default. Edits and deletes are not sent. |

Other loggers that send N1MM-format contact packets should work.

What the relay does not read:

- WSJT-X's own UDP format, ADIF files or log files.
- Packets from other computers. It reads only packets sent to `127.0.0.1`, so it also ignores
  packets sent to your computer's network or broadcast address.

### State and grid square

When your logger puts the other station's US state or grid square in the contact, the relay sends
it, and Long Lines uses the state to mark [goals](/goals/). The relay never looks a callsign up.

- **State.** Sent when the contact's `state`, `section`, `qth` or `exchange1` field is exactly a
  two-letter state code such as `NC` (or `DC`). In ARRL Sweepstakes and Field Day the section is
  often the state. A longer value, such as the section `ENY` or a county, sends no state, and neither
  do two fields that name different states.
- **Grid square.** Sent when the contact's `gridsquare` field is a 4, 6 or 8 character locator, such
  as `FM05` or `FM05pu`. VHF contests log it.

## Set it up

Tick **Test mode** on the relay's **Logging feed** card first if you want to check the setup without
posting anything.
Then follow the steps for your logger, log a contact, and look for it under **Contacts seen**.

### N1MM Logger+

1. Open **Config > Configure Ports, Mode Control, Winkey, etc.** and select the **Broadcast Data**
   tab.
2. Tick **Contacts** and enter `127.0.0.1:12060` beside it. If something else already listens for
   contacts, add the relay after it with a space between the two addresses, for example
   `127.0.0.1:12060 127.0.0.1:2333`.
3. Select **OK**.

Edits and deletes in N1MM reach Long Lines too: an edited contact updates its spot, and a deleted
contact's spot is removed. In a multi-computer N1MM network, each computer's relay posts only the
contacts logged on that computer; contacts forwarded from other stations show "Ignored. Forwarded by
another N1MM station."

### DXLog.net

1. Open **Options > Broadcast**.
2. Turn on the contact (QSO) broadcast to `127.0.0.1`, port `12060`.
3. Tick **Use N1MM QSO format**.

### MacLoggerDX

You need version 6.58 or later.

1. Turn on the N1MM-format contact broadcast in MacLoggerDX. Its help describes where.
2. MacLoggerDX sends to your network's broadcast address by default, which the relay ignores. Quit
   MacLoggerDX, run this in Terminal, then start MacLoggerDX again:

   ```sh
   defaults write com.dogparksoftware.MacLoggerDX broadcast_ip_address 127.0.0.1
   ```

3. Make the port match the relay's. MacLoggerDX keeps it in its `n1mm_radio_port` setting; its help
   has the details.

### Not1MM

1. In **File > Station Settings**, leave **Operator** empty or set it to the station callsign.
   Not1MM sends the operator as the logged callsign, so another operator's contacts are ignored.
2. In **File > Configuration Settings**, on the **N1MM** tab, tick **Send N1MM packets**, tick the
   box beside **Contact**, and set the contact address to `127.0.0.1:12060`. Or set the relay's
   **UDP port** to 12061 instead.

Not1MM sends a packet only when a contact is saved. Editing or deleting a contact in Not1MM doesn't
change or remove its spot.

## Common setups

**N1MM Logger+ with another program already on the broadcast.** In **Broadcast Data**, set
**Contacts** to `127.0.0.1:12060 127.0.0.1:2333`. Both programs get every contact.

**POTA hunting with a state goal.** N1MM Logger+ in a DX log with the state in the exchange. Each
contact sends its state, which marks your [goal](/goals/) directly instead of guessing from the
license.

**Another program already uses port 12060.** In the relay's **Settings** card, enter `12070` in
**UDP port** and select **Change port**. Use `127.0.0.1:12070` in your logger.

## When it doesn't work

**"Waiting for logging software" and "Nothing received yet".** Nothing has arrived on the relay's
port. Check that broadcasts are on, the address is `127.0.0.1` and the port matches the one under
**Logging feed**.

**"Port 12060 is in use by another program".** Another program already listens on that port. The
relay takes the port as soon as the other program lets it go, or you can choose another port in the
relay and use the same one in your logger.

**"Ignoring contacts" and "Ignored. Logged as K4XYZ."** The logger's station callsign isn't the
callsign of the account the relay is signed in to. Change it in the logger, or sign in with the
account for that callsign.

**"Ignored. No station callsign in the logger."** Set your callsign in the logger's station
settings.

**"Couldn't read packet".** The packet isn't in the N1MM format. For DXLog.net, tick **Use N1MM QSO
format**.

**Not1MM: the relay says Receiving but no contacts appear.** Not1MM sends radio packets to port 12060
and contacts to 12061 by default. Check the contact port.

<!--
Verified against:
- sonyccd/longlines-relay at cd60f2c: docs/loggers.md (logger table, per-logger steps, state and grid rules, troubleshooting), README.md
- src/copy.ts (Logging feed, Settings card UDP port, Change port, Test mode, port-in-use copy)
- crates/relay-core/src/status.rs and state.rs (row and feed status text), settings.rs (default port 12060), location.rs
Not verified by hand: MacLoggerDX and DXLog.net packets (the relay's own docs mark them "capture wanted"); which exchange field N1MM fills with the state outside Sweepstakes. The "POTA hunting with a state goal" setup assumes the logger puts the state in state, section, qth or exchange1. The N1MM second address 127.0.0.1:2333 is an example.
-->
