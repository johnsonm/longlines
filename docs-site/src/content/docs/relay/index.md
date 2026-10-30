---
title: Long Lines Relay
description: Connect the desktop relay to your account so your logged contacts become spots, and spots reach your logging software.
---

Long Lines Relay is a desktop app that runs on your logging computer. Once you connect it to your
account, it posts each contact you log to Long Lines as a spot, and it can run a small DX cluster
that feeds matched spots into your logging software's bandmap. It runs on Windows 10 and 11, macOS
and Linux.

## Why you'd use it

You're working toward Worked All States. With the relay running beside your logger, each contact you
log marks its state on your [goal](/goals/) within seconds, and your connections stop alerting for
that state.

## How it works

### Connecting a relay

The relay signs in with a code, not your password. It shows a code such as `KQ7M-X4PD` and opens
`longlines.io/relay/approve` in your browser. You approve it there while signed in. Codes last 10
minutes. Typing the code is forgiving: case doesn't matter, and O reads as 0, I and L as 1.

The approval page lists what the relay is asking for:

- "Post contacts logged as KK4PWJ as spots" (your account's callsign).
- "Receive the spots that match your connections, for its local DX cluster" (needed for a
  [Local DX cluster](/destinations/local-dx-cluster/) destination). The current relay always asks
  for this; a relay signed in with an older version may not have it.
- "Can't read or change your connections, groups, destinations or settings". A relay never can.

You can connect up to 10 relays. The relay keeps its sign-in in your operating system's credential
store (on Linux, GNOME Keyring or KWallet), never in its settings or log files.

### What happens to a logged contact

Your logging software broadcasts each contact on your computer in the N1MM Logger+ format. The relay
catches it, checks it, and posts it. See [Set up your logging software](/relay/loggers/) for which
loggers work.

Each contact becomes a spot from the **Logged contacts** source. The spotter is your call as logged,
and the callsign is the station you worked. The band comes from the frequency. There is no comment or
reference.

**Logged contacts are public, like any other spot.** Any Long Lines user with a connection on Logged
contacts gets them, and they count on callsign profiles. The approval page says so: "Spots from your
log are visible to other Long Lines users, like spots from any other source."

A contact is not posted when:

- The call you logged as doesn't match your account's callsign, compared by base call (so `W1AW/P`
  matches an account holding `W1AW`). If several accounts hold the same base call, only the one that
  has held it longest can post contacts as it.
- It was logged more than 30 minutes ago.
- Its time is more than 5 minutes ahead of the clock.
- It's malformed.

The relay checks these itself before sending, and shows the reason next to the contact (see
[The relay window](/relay/window/)).

When you edit a contact in your logger, its old spot is replaced. When you delete one, the spot is
taken down. Spots already delivered to destinations are not recalled. A relay posts up to 120
contacts a minute.

If the relay can't reach Long Lines, contacts wait in a queue on your computer, which survives a
restart. A contact still waiting 30 minutes after you logged it is dropped. Deletes never expire.

Your own logged contacts are never sent back to your own Local DX cluster destinations.

## Set it up

1. [Install Long Lines Relay](/relay/install/) on your logging computer. Signed in to Long Lines,
   the **Get the relay** button on the **API tokens** page links to the latest release.
2. In the relay, select **Sign in with Long Lines**. The relay shows **Your code** with a countdown
   (**Expires in**) and opens your browser.
3. If the browser didn't open, select **Open browser again**, or go to `longlines.io/relay`, enter
   the **Code**, and select **Continue**.
4. Sign in to Long Lines if asked. Accounts made with Google must add a callsign first.
5. Check that the code on the page matches the one in the relay, read the permissions, and select
   **Allow**.
6. The page says "Relay connected". Go back to the relay, which now shows **Connected** at the top.
7. [Set up your logging software](/relay/loggers/) to send contacts to the relay.

To stop using a relay on one computer, open its account menu (your callsign, top right) and select
**Sign out**. That removes the sign-in from that computer only. To disconnect it for good, open
**API tokens** on Long Lines, find it on the **Long Lines Relay** card, and select **Revoke**. It
stops posting at once.

On that card, the **Connected** column is the date you paired the relay. A green **Connected** chip
next to the computer's name means its local DX cluster stream is open right now.

## Common setups

**Contacts for goals only.** Sign the relay in and use goals with **From my log, using the relay**.
You don't need a Logged contacts connection, and you can leave the DX cluster off.

**Bandmap feed.** Sign the relay in, then make a
[Local DX cluster](/destinations/local-dx-cluster/) destination and turn on the relay's
[DX cluster](/relay/dx-cluster/).

**Two shack computers.** Pair each one separately; each appears as its own row on the **Long Lines
Relay** card, and each can be its own Local DX cluster destination.

## When it doesn't work

**"We don't recognize this code."** Check it against the relay. If the relay now shows a different
code, use the new one.

**"This code expired".** Codes last 10 minutes, and a code that was already answered also shows as
expired. The relay says "The code expired". Select **Sign in with Long Lines** again.

**"Sign-in was denied".** **Deny** was selected in the browser. Sign in again to get a new code.

**"You can connect up to 10 relays. Disconnect one in API tokens first."** Revoke a relay you no
longer use.

**"Add your callsign to your account first."** Your account has no callsign yet (Google sign-up). Add
one on the page Long Lines shows you.

**"Can't read the sign-in on this computer".** The relay couldn't open the credential store. Unlock
your keychain or keyring; the relay keeps trying. On Linux, signing in needs a running Secret Service
(GNOME Keyring or KWallet).

**Contacts don't show up.** See [The relay window](/relay/window/#when-it-doesnt-work). The most
common cause is a callsign mismatch: check **Callsign** on the **Account** page against the call in
your logger.

**The relay isn't offered for a Local DX cluster destination.** It was paired without permission to
receive spots. On the relay's **DX cluster** tab, select **Sign in again** and allow the spots line.

<!--
Verified against:
- web/src/relay/ApprovePage.tsx, model.ts (approval copy, scopes, Set up logging software link)
- web/src/tokens/RelayTokensCard.tsx, model.ts (Long Lines Relay card, Get the relay, Revoke, Connected column vs chip)
- supabase/migrations/20261028000400_relay_pairing.sql (10-minute codes, code alphabet, 10-relay cap, 120 a minute, errors)
- supabase/migrations/20261028000500_local_cluster.sql (spots:read scope, loop guard)
- supabase/migrations/20261029001100_goals.sql (apply_logged_contacts mycall_mismatch by base call)
- supabase/migrations/20261029000600_shared_callsigns.sql (longest holder posts)
- supabase/functions/_shared/logged.ts (30-minute too_old, 5-minute clock skew), handlers/relay_api.ts
- sonyccd/longlines-relay at cd60f2c: README.md (platforms, credential store, Linux Secret Service), src/copy.ts (signedOut, signingIn, header copy), crates/relay-core/src/engine.rs (sign_out deletes the local token only, CONTACTS_PER_MINUTE), upstream/queue.rs (SQLite queue, 30-minute expiry, deletes never expire), upstream/token_store.rs, upstream/client.rs (SCOPES: the relay always asks for contacts:write and spots:read), freshness.rs
-->
