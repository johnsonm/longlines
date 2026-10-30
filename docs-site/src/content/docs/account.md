---
title: Your account
description: Create an account, sign in, change your callsign, time zone or password, install the app, or delete your account.
---

Your account holds your callsign, email and password, and everything you build: connections,
destinations, groups, goals, API tokens and paired relays. The lookup pages, Stats and Health work
without one.

## How it works

**Sign-in is by email**, never by callsign, because several accounts can hold the same callsign (a club
call and its trustee's own account, for example). After 10 failed attempts in 15 minutes you see "Too
many attempts. Try again in a few minutes."

**Your callsign** must look like an amateur call, with at most one `/suffix`. It labels your
connections and is the call Long Lines Relay must post contacts as. If you change it to a different
base call, you join the back of the line of accounts holding that base call for posting logged
contacts.

**Time zone** controls quiet hours on push notifications and, with **Show spot times in UTC** off, the
times in spot tables. The list offers UTC, America/New_York, America/Chicago, America/Denver,
America/Los_Angeles, Europe/London, Europe/Berlin and Asia/Tokyo. New accounts start on UTC with UTC
spot times on.

**Theme**: the account menu (your callsign in the top bar) has a **Light**, **Automatic** and **Dark**
switch. Automatic follows your device. The choice is kept per browser.

## Set it up

### Create an account

1. Go to [longlines.io](https://longlines.io) and select **Sign in**, then the **Create account** tab.
2. Enter your **Callsign** (such as `KK4PWJ`), **Name** (optional), **Email**, a **Password** of at
   least 8 characters, and **Confirm password**.
3. Select **Create account**.
4. Open the confirmation link in the email on the same device. The link expires in 24 hours.

To use Google instead, select **Sign up with Google**. Google doesn't know your callsign, so Long Lines
asks for it on **Finish creating your account** before you can use anything else.

### Sign in and reset your password

Select **Sign in**, enter **Email** and **Password**, and select **Sign in**, or use **Sign in with
Google**. If you forgot your password, select **Forgot your password?**, enter your email and select
**Send reset link**. The link opens **Set a new password**.

### Change your details

Open the account menu and select **Account**.

- **Profile**: change **Callsign**, **Name**, **Email**, **Time zone** and **Show spot times in UTC**,
  then **Save changes**. A new email takes effect after you open the confirmation link sent to it.
- **Password**: enter **Current password**, **New password** and **Confirm new password**, then
  **Change password**. **Sign out other devices** signs out every other browser; signing out also
  turns off push notifications on that device.

### Install the app

On a phone or a Chrome-family browser, the account menu shows **Install app** when the browser can
install Long Lines. On iPhone and iPad it opens the steps: tap the Share button in Safari, choose
**Add to Home Screen**, then **Add**, and open Long Lines from the Home Screen. You need this on iPhone
for push notifications.

### Delete your account

On the **Account** page, select **Delete account**, type your callsign to confirm, and select **Delete
account** again. Your connections, destinations, groups, goals, API tokens and relay connections are
removed immediately. Spots already delivered are not recalled, and contacts you logged stay in Long
Lines as spots.

## When it doesn't work

**"That email and password don't match."** Check the email, or reset your password. Signing in with a
callsign gives "Sign in with your email address."

**"Check your email to confirm your account first."** Open the confirmation link, or create the account
again if it expired.

**"This link has expired or was already used."** Request a new reset link from the sign-in page.

**"Saved your profile, but your email didn't change."** The new address was refused; the message says
why.

**I signed up with Google and can't change my password.** The **Password** card asks for a current
password that a Google-only account doesn't have. Use **Forgot your password?** on the sign-in page to
set one.

**Install app doesn't appear.** The browser doesn't offer installation (Firefox on desktop, for
example), or Long Lines is already installed and open as an app.

<!--
Verified against:
- web/src/auth/SignInPage.tsx, CheckEmailPage.tsx, CompleteProfilePage.tsx, ResetPasswordPage.tsx, SetPasswordPage.tsx
- web/src/account/AccountPage.tsx, ChangePassword.tsx
- web/src/layout/AppShell.tsx (account menu, Theme, Install app), InstallDialog.tsx; web/src/pwa/install.ts
- supabase/functions/_shared/signin.ts, handlers/sign_in.ts, handlers/delete_account.ts
- supabase/migrations/20261017005000_sign_in_attempts_per_client.sql (10 per 15 minutes)
- supabase/migrations/20261029000600_shared_callsigns.sql (callsigns not unique, callsign_since)
- supabase/migrations/20261006000001_profiles.sql (UTC defaults)
Not verified: that "Forgot your password?" works as a way to add a password to a Google-only account (inferred, untested).
-->
