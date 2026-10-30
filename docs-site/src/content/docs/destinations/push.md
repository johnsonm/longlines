---
title: Push notifications
description: Get matched spots as notifications on your phone or computer, from the browser, with no app to install.
---

A push destination shows matched spots as notifications on the devices you pick. A device is a
browser where you allowed Long Lines to notify you: Chrome on your laptop, Safari on your iPhone once
Long Lines is on the Home Screen, and so on.

## Why you'd use it

You want your phone to buzz when VP8PJ is spotted on the DX Cluster, even while Long Lines isn't open,
and you want silence between 22:00 and 07:00.

## How it works

Your devices belong to your account. Each push destination picks some of them, so you can send DX
alerts to your phone and POTA spots to your laptop. Only devices you check get notifications.

A notification has a **Title** (1 to 4 fields, always joined with " · ") and a **Body** (up to 8
fields). With the defaults it looks like this:

> **KK4PWJ/P · 14.062 MHz · CW**
> POTA · US-2763 · Pisgah National Forest · NC

The fields are Callsign, First name, Last name, Frequency, Band, Mode, Source, Reference, Place name,
State, Spotter, Comment and Time. You can't add your own text. Tapping the notification opens the
callsign's Long Lines profile or, if you choose, the spot on the source site. On Android and desktop
Chrome you also get **Open profile** and **Open on POTA** (or **Open on SOTAwatch**, **Open on WWFF**)
buttons; the second appears only for sources with a page per spot. iPhone doesn't show action buttons.

Limits you should know about:

- **3 notifications a minute per push destination.** When more spots match, the newest go first and
  the rest wait. There is no summary notification.
- **Old spots are dropped, not queued.** A spot that can't be delivered within **Drop if the device
  is offline for** (30 minutes by default) is dropped.
- **Replace the earlier notification for the same station** (on by default) means a station that
  keeps getting spotted updates one notification instead of stacking many.
- **Quiet hours** use your account time zone (set on the **Account** page). **Send silently** still
  delivers, without sound; **Don't send** skips the spots for good. Quiet hours can cross midnight.
- A device whose browser blocks notifications gets nothing. Its chip says **Blocked**, and the
  destination's chip shows "1 device blocked".
- A push destination with no devices that can receive counts as failing.

### Supported devices

Any browser that supports web push: Chrome, Edge, Firefox and Safari on desktop, and Chrome on
Android. On iPhone and iPad, Safari allows notifications only for web apps added to the Home Screen,
so add Long Lines there first and open it from the Home Screen icon. You can turn notifications on for
up to 20 devices.

## Set it up

On iPhone or iPad, first install Long Lines: in Safari, tap the Share button, choose **Add to Home
Screen**, then **Add**, and open Long Lines from the new icon. (Signed in, **Install app** in the
account menu shows the same steps.)

1. Open **Destinations**, select **Add destination**, pick **Push notification** and select
   **Continue**.
2. Enter a **Name**, such as `Phone: DX`.
3. On the **Devices** card, select **Add this device**. Edit the **Device name** if you like, select
   **Enable notifications**, and choose Allow when the browser asks.
4. To add another device, open Long Lines on it, sign in, go to **Destinations** and select **Add this
   device** there. It then appears in the list; check it.
5. On **Notification content**, arrange the **Title** and **Body** fields and choose what a tap opens.
6. On **Delivery**, set **Urgency**, **Drop if the device is offline for**, and **Quiet hours** if
   you want them.
7. Check the **Preview**, which draws the notification for Android, iPhone and desktop.
8. Select **Add destination**.
9. Select **Send test notification**. It goes to the checked devices and ignores quiet hours.
10. Add the destination to a connection.

**Rename device** changes a device's label. **Remove device** removes it from your account and from
every push destination. Signing out of Long Lines on a device also turns its notifications off.

## Common setups

**Urgent DX on the phone.** Devices: your phone. Title: Callsign, Frequency, Mode. Body: Spotter.
**Urgency**: High, which can wake a sleeping phone. **Drop if the device is offline for**: 5 minutes.
**Quiet hours**: off.

**POTA on the laptop during the day.** Devices: your laptop. Defaults for content. **Urgency**:
Normal. **Quiet hours** 22:00 to 07:00, **Don't send**.

**Club calls, quiet at night.** Devices: phone and laptop. **Replace the earlier notification for the
same station** on. **Quiet hours** 23:00 to 06:30, **Send silently**.

## When it doesn't work

**"Notifications are blocked for Long Lines."** You (or the browser) denied permission. Allow
notifications for longlines.io in the browser's site settings, reload, and select **Add this device**
again.

**"This browser can't receive push notifications."** The browser doesn't support web push. On iPhone
or iPad, open Long Lines from the Home Screen, not from a Safari tab.

**Enable notifications is greyed out on iPhone.** It says "Available once Long Lines is opened from
the Home Screen." Install it as above.

**A device shows Blocked.** Its browser stopped allowing notifications. Allow them in that browser's
site settings, or remove the device from the destination.

**The destination is Failing.** None of its checked devices can receive notifications. Add or unblock
a device.

**I get far fewer notifications than matches.** That's the limit of 3 a minute plus **Drop if the
device is offline for**. Narrow the connection, or raise its **Repeat spots for the same station**
interval.

**Nothing arrives at night.** Quiet hours are set to **Don't send**, or your account time zone is
wrong. Check **Time zone** on the **Account** page.

<!--
Verified against:
- web/src/destinations/PushDestinationPage.tsx, DevicesCard.tsx, AddDeviceDialog.tsx, RenameDeviceDialog.tsx, NotificationContentCard.tsx, PushPreviewCard.tsx, pushModel.ts
- web/src/pwa/push.ts (support checks, iOS Home Screen requirement, messages, sign-out cleanup)
- web/src/layout/InstallDialog.tsx (install steps)
- supabase/migrations/20261016000400_push_destinations_v2.sql (defaults, rendering, quiet hours, 60-char labels)
- supabase/migrations/20261017002000_push_device_rotation.sql (20-device cap)
- supabase/migrations/20261028000500_local_cluster.sql (3 a minute budget, ttl_seconds max age)
- supabase/functions/_shared/delivery/format.ts (tag per station, actions, silent), send.ts (no devices = failure)
- supabase/tests/push_destinations.test.sql (example title and body)
Not verified: the exact list of browsers; the code checks for Notification, service worker and PushManager support, not browser names.
-->
