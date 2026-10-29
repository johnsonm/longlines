# Auth email templates

The emails Supabase Auth sends, one self-contained HTML file each (Auth templates have no
partials, so a change to the shared header, button or footer goes in every file). Subjects live
in `supabase/config.toml` beside each `content_path`.

| File | Dashboard entry | Subject | Variables used |
| --- | --- | --- | --- |
| `confirmation.html` | Confirm sign up | Confirm your Long Lines account | `.ConfirmationURL`, `.Email`, `.Data.callsign`, `.SiteURL` |
| `invite.html` | Invite user | You're invited to Long Lines | `.ConfirmationURL`, `.Email`, `.SiteURL` |
| `magic_link.html` | Magic link or OTP | Your Long Lines sign-in link | `.ConfirmationURL`, `.Email`, `.SiteURL` |
| `email_change.html` | Change email address | Confirm your new Long Lines email | `.ConfirmationURL`, `.Email` (current), `.NewEmail`, `.SiteURL` |
| `recovery.html` | Reset password | Reset your Long Lines password | `.ConfirmationURL`, `.Email`, `.SiteURL` |
| `reauthentication.html` | Reauthentication | Your Long Lines verification code | `.Token`, `.SiteURL` |
| `password_changed_notification.html` | Password changed (security) | Your Long Lines password was changed | `.Email`, `.SiteURL` |
| `email_changed_notification.html` | Email address changed (security) | Your Long Lines email was changed | `.OldEmail`, `.Email` (new), `.SiteURL` |

The last two are security notifications: Auth sends them after the change, not to confirm it, and
only while each is switched on (`enabled` in `config.toml` locally, the notification's toggle under
Authentication → Emails in the dashboard). Neither carries a link of its own: the password one
points at `/reset-password`, and the email one at the Account page on a signed-in device.

Auth also offers `.Token` (the six-digit code), `.TokenHash` and `.RedirectTo` in every link
template. The web app has no code entry, so the link templates send only the link.
`.Data` is the user's metadata: sign-up stores `callsign` and `name` there; a Google or invited
user has neither, so `confirmation.html` reads `callsign` under an `if`.

The logo is `{{ .SiteURL }}/icon-192.png`, served from `web/public`. "Expires in an hour" is
`otp_expiry` (3600, the hosted default too); change the copy if either changes.

## Applying them

- **Local:** `config.toml` points the stack at these files. Restart it (`supabase stop && supabase
  start`) and the emails show up in Mailpit at http://127.0.0.1:54324.
- **Hosted:** the dashboard is the source of truth until someone automates it. After a change
  merges, paste the file and its subject into Authentication → Emails → Templates. Do not use
  `supabase config push` for this: it pushes the whole local `[auth]` section too, including
  `site_url = "http://localhost:5173"`.
