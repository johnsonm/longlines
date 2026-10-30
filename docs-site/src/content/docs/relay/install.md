---
title: Install the relay
description: Download Long Lines Relay for Windows, macOS or Linux and get past the first-run warning.
---

Long Lines Relay runs on Windows 10 and 11 (x64), macOS (Apple silicon and Intel) and Linux (x64).
Install it on the computer that runs your logging software, because it only listens for contacts
sent from that computer.

## How it works

The relay is not signed with an Apple or Microsoft developer certificate, so each operating system
warns you the first time you open it. The steps below get past that warning once. Updates install
without it.

Once installed, the relay checks for a new version 10 seconds after it starts and then once a day.
When one is out, a banner says "Version 0.1.4 of the relay is available." Select **Install and
restart**. The relay restarts on its own and stays signed in. Your settings and any contacts waiting
to be sent are kept.

Closing the window keeps the relay running in the system tray (the menu bar on macOS). The tray menu
has **Open**, **Open log folder** and **Quit**. The relay starts when you log in to your computer
unless you turn off **Start when I log in** in its **Settings** card.

## Set it up

Download the file for your computer from the
[latest release](https://github.com/sonyccd/longlines-relay/releases/latest). Signed in to Long
Lines, the **Get the relay** button on the **API tokens** page goes to the same place.

| Computer | File |
| --- | --- |
| Windows 10 or 11 | `Long.Lines.Relay_<version>_x64-setup.exe` |
| Mac with Apple silicon (M1 or later) | `Long.Lines.Relay_<version>_aarch64.dmg` |
| Mac with an Intel processor | `Long.Lines.Relay_<version>_x64.dmg` |
| Linux, most distributions | `Long.Lines.Relay_<version>_amd64.AppImage` |
| Debian, Ubuntu and derivatives | `Long.Lines.Relay_<version>_amd64.deb` |

### Windows

1. Run the `-setup.exe` file. It installs for your user account only and doesn't need an
   administrator.
2. If Windows shows "Windows protected your PC", select **More info**, then **Run anyway**.

### macOS

1. Open the `.dmg` and drag **Long Lines Relay** to **Applications**.
2. Open it from Applications. macOS says it can't check the app for malicious software. To open it
   anyway:
   - **macOS 14 (Sonoma) and earlier:** Control-click the app in Applications, choose **Open**, then
     **Open** again.
   - **macOS 15 (Sequoia) and later:** select **Done**, open **System Settings > Privacy &
     Security**, scroll down to the message about Long Lines Relay, select **Open Anyway** and
     confirm with your password.
   - **Or, in Terminal:**

     ```sh
     xattr -dr com.apple.quarantine "/Applications/Long Lines Relay.app"
     ```

### Linux: AppImage

```sh
chmod +x Long.Lines.Relay_*_amd64.AppImage
./Long.Lines.Relay_*_amd64.AppImage
```

AppImages need FUSE 2. On Ubuntu 22.04 install `libfuse2`; on Ubuntu 24.04 and later, `libfuse2t64`.

### Linux: .deb

```sh
sudo apt install ./Long.Lines.Relay_*_amd64.deb
```

A `.deb` install updates itself like the others: select **Install and restart** on the banner and
enter your password when the system asks.

### After installing

[Sign in with Long Lines](/relay/#set-it-up), then
[set up your logging software](/relay/loggers/).

## When it doesn't work

**macOS says the app is "damaged" and offers only to move it to the Trash.** The download is
incomplete or an old build. Download the release again.

**Signing in fails on Linux.** The relay keeps its sign-in in the Secret Service (GNOME Keyring or
KWallet). Most desktops run one; without one, signing in fails.

**No tray icon on Linux.** The tray icon needs an AppIndicator-capable panel. On GNOME, that is the
"AppIndicator and KStatusNotifierItem Support" extension (Ubuntu ships it on).

**"Couldn't install version 0.1.4."** The update failed, or on a `.deb` install you cancelled the
password prompt. Select **Try again**.

**"Version 0.1.4 of the relay is available. Download the new package to install it."** Your copy
can't update itself (for example, an `.rpm` or a bare binary). Select **Download** and install the
new package by hand.

**No update banner.** The relay checks once a day. Quit it from the tray and open it again to check
now. If there is still no banner, look in the log folder (tray menu, **Open log folder**) for
"couldn't check for updates".

<!--
Verified against:
- sonyccd/longlines-relay at cd60f2c: README.md (Install, platform files, first-run steps, Linux notes, update testing)
- src/copy.ts (update banner copy, Settings card, Start when I log in)
- src-tauri/src/tray.rs (Open, Open log folder, Quit), src-tauri/src/updates.rs (first check after 10 s, then every 24 h), src-tauri/src/lib.rs
- web/src/tokens/RelayTokensCard.tsx (Get the relay)
Version numbers in the examples are illustrative. "Settings and queued contacts are kept across an update" follows from settings.rs and the SQLite queue living outside the app bundle; not tested by hand.
-->
