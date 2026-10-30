---
title: The relay window
description: Read the relay's Logging feed, Contacts seen list and status messages, and use test mode and settings.
---

Signed in, the relay window has two tabs: **Contacts**, for the contacts you log, and **DX cluster**,
for spots going to your logging software (see [The relay's DX cluster](/relay/dx-cluster/)). The top
bar shows a status chip and your callsign, which opens the account menu with **Sign out**.

## Why you'd use it

You've set up N1MM Logger+ for the first time and want to know whether it worked. Tick **Test
mode**, log a contact, and the **Contacts seen** list shows what would have happened, without posting
anything.

## How it works

### The status chip

| Chip | Meaning |
| --- | --- |
| **Connected** | Signed in, and contacts are going through. |
| **Retrying** | The last send failed. The Contacts tab says why and when the next try is. Failed sends wait 5 seconds at first, longer each time, up to 5 minutes. |
| **Paused** | Long Lines asked the relay to slow down. Contacts wait in the queue and go again when the pause ends. |
| **Can't read sign-in** | The relay couldn't read its sign-in from the credential store. Unlock your keychain or keyring; the relay keeps trying. |

### Logging feed

The **Logging feed** card shows whether contacts are arriving: "Listening on UDP port 12060", "Last
contact 2 minutes ago" or "Nothing received yet". Its chip says one of:

| Chip | Meaning |
| --- | --- |
| **Receiving** | Packets are arriving from your logger. |
| **Waiting for logging software** | Nothing has arrived yet. |
| **Ignoring contacts** | Contacts are logged under another callsign, so none are posted. The card names the callsign. |
| **Port in use** | Another program has the port. The relay takes it as soon as that program lets go. |
| **Test mode** | Test mode is on. |

### Contacts seen

**Contacts seen** lists everything the relay receives, newest first, up to the last 50. Each row
reads like `W4ABC · 40 m CW` with its time and a status:

| Status | What happened |
| --- | --- |
| Waiting to send | In the queue. |
| Sent as a spot | Posted to Long Lines. |
| Edited in logger. Spot updated. | You edited the contact; its spot was replaced. |
| Deleted in logger. Spot removed. | You deleted the contact; its spot was taken down. |
| Not sent. Test mode is on. | Test mode was on when it arrived. |
| Ignored. Logged as K4XYZ. | Logged under a callsign that isn't your account's. |
| Ignored. No station callsign in the logger. | The logger sent no station callsign. |
| Not sent. Logged more than 30 minutes ago. | Too old to post. |
| Not sent. Logged more than 5 minutes ahead of this computer's clock. | The contact's time is in the future. |
| Ignored. Forwarded by another N1MM station. | Logged on another computer in an N1MM network. That computer's relay posts it. |
| Couldn't read packet | Not in the N1MM format. |
| Couldn't send: ... | Long Lines refused it. The reason follows, such as "This computer isn't allowed to post contacts. Sign in again." |

### Test mode

With **Test mode** ticked on the **Logging feed** card, the relay checks each contact and shows what
would have happened, but sends nothing. A contact that arrives in test mode is never sent later, even
after you turn test mode off. Test mode turns itself off when the relay restarts.

### Settings

The **Settings** card at the bottom of the Contacts tab has:

- **UDP port**: the port the relay listens on for your logger, `12060` by default. Enter a port from
  1 to 65535 and select **Change port**.
- **Start when I log in**: on by default.
- The relay's version.

Closing the window keeps the relay running in the system tray (the menu bar on macOS). **Quit** and
**Open log folder** are in the tray menu. The relay keeps 14 days of log files, and never writes its
sign-in to them.

## Set it up

1. Open the relay from the tray or your applications.
2. On the **Contacts** tab, tick **Test mode**.
3. Log a test contact in your logger, such as `W1AW` on 14.025 MHz CW.
4. Check that **Contacts seen** shows `W1AW · 20 m CW` with "Not sent. Test mode is on."
5. Delete the test contact in your logger, untick **Test mode**, and log for real.

## When it doesn't work

**"Contacts are logged as K4XYZ".** The relay is signed in to an account with a different callsign.
Change the station callsign in your logging software, or sign out and sign in with the account for
K4XYZ.

**"Contacts aren't going through".** The last send failed; the alert gives the reason and the next
try. The relay retries by itself, and contacts wait in the queue meanwhile. A contact still waiting
30 minutes after you logged it is dropped.

**"Long Lines asked the relay to slow down".** More than 120 contacts a minute. They go out when the
pause ends.

**"Couldn't send: Long Lines doesn't accept contacts from this version of the relay."** Update the
relay.

**"Couldn't send: This computer isn't allowed to post contacts. Sign in again."** The relay was
revoked on the API tokens page, or its sign-in no longer works. Sign in again.

**A contact you logged a while ago isn't there.** The list keeps only the last 50 contacts.

For logger-side problems ("Waiting for logging software", "Port 12060 is in use by another program",
"Couldn't read packet"), see [Set up your logging software](/relay/loggers/#when-it-doesnt-work).

<!--
Verified against:
- sonyccd/longlines-relay at cd60f2c: src/copy.ts (header, feed, contacts, settings copy), src/components/FeedCard.tsx (Test mode checkbox on the feed card), SettingsCard.tsx, PortField.tsx (Change port, 1 to 65535), ContactsCard.tsx
- crates/relay-core/src/status.rs (row statuses and Couldn't send reasons), state.rs (feed chip labels, STREAM_LIMIT 50, test mode not persisted), engine.rs (test-mode contacts never queued, CONTACTS_PER_MINUTE), upstream/queue.rs (backoff 5 s to 5 min, 30-minute expiry), logging.rs (LOG_FILES_KEPT 14), settings.rs (defaults)
- src-tauri/src/tray.rs (Open, Open log folder, Quit)
Not verified: "Paused" appears only after a 429 from Long Lines; the relay keeps under 120 a minute itself, so in practice the pause is rare.
-->
