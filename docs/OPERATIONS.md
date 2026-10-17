# Operations

All queries below run in the Supabase Studio SQL editor (or psql as `postgres`).

## Health check

```sql
select * from ingest_health;
```

Healthy: every row has a recent `last_success_at`, `consecutive_failures = 0`, and
`spots_last_hour > 0`. SOTAwatch can legitimately insert nothing for a while when the epoch has not
changed; `last_success_at` still advances.

`last_error` is the most recent error ever recorded and is not cleared by a later success. Compare
`last_error_at` with `last_success_at` before worrying about it.

## Cron jobs

Everything pg_cron runs, as `select jobname, schedule from cron.job order by 1;` should show it.
Times are UTC.

| Job | Schedule | Runs |
| --- | --- | --- |
| `ingest-pota` | every minute | the `ingest-pota` function over pg_net |
| `ingest-sotawatch` | every 30 seconds | `ingest-sotawatch` |
| `ingest-wwff` | every minute | `ingest-wwff` |
| `match-pending-spots` | every minute | `match_pending_spots()`, the safety net behind the call every ingest makes |
| `archive-aprs` | every 5 minutes | the `archive` function for APRS-IS only (`{"sources": ["aprs"]}`) |
| `archive-spots` | every 10 minutes | `archive` for POTA, SOTAwatch, DX Cluster, WWFF and RBN |
| `refresh-stats-snapshot` | :05 hourly | `refresh_stats_snapshot()` |
| `prune-callsign-lookups` | :15 hourly | `prune_callsign_lookups()` |
| `rollup-callsign-days` | :25 hourly | `backfill_callsign_rollups(2)` |
| `apply-license-loads` | :50 hourly | `apply_license_loads()` |
| `housekeeping` | 03:00 daily | `run_housekeeping()` |
| `maintain-rbn-spots` | 03:35 daily | `maintain_rbn_spots()` |
| `maintain-aprs-packets` | 03:45 daily | `maintain_aprs_packets()` |
| `import-cty` | 04:20 Mondays | the `import-cty` function |

There is no `deliver` job. Outbound delivery is the sender process polling the queue ("Delivery"
below), not a cron job; `20261015001200_sender_cutover` unscheduled it and
`20261015001400_sender_cleanup` removed the Edge Function it called. A `deliver` row here means
the cutover migration has not been pushed yet.

## Why am I not seeing spots?

Work down the chain.

1. Are the cron jobs scheduled and active?
   ```sql
   select jobid, jobname, schedule, active from cron.job;
   select jobname, status, return_message, start_time
   from cron.job_run_details d join cron.job j using (jobid)
   order by start_time desc limit 20;
   ```
2. Did the HTTP calls reach the functions? pg_net keeps recent responses:
   ```sql
   select id, status_code, content::text, created
   from net._http_response order by created desc limit 20;
   ```
   A null `status_code` with an error message usually means the Vault secrets are missing or
   wrong. Check they exist (values are secrets; do not paste them anywhere):
   ```sql
   select name, created_at from vault.secrets where name like 'longlines_%';
   ```
   A 401 means the service-role key in Vault does not match the project.
3. Did the function run but fail? `ingest_state.last_error` holds the message, and the Edge
   Function logs in the dashboard show the same line. Invoke a function by hand to see the
   summary or error directly:
   ```sh
   curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/ingest-pota \
     -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
   ```
4. `ingest_state.last_error` says `numeric field overflow`? That was
   `raw_spots.frequency_khz` at `numeric(10,3)` rejecting 10 GHz spots; migration
   `20261006000012` widened it. Make sure `supabase db push` has run.
5. Did the function run and simply skip everything? The response body's `skipped.too_old` counter
   is high when the upstream feed only had old spots (quiet band, or the function was down and is
   catching up). That is normal.

## Dead letter queue

Individual spots that could not be normalized, or that would fail their batch in Postgres (a spot
time more than a day ahead or before 2000, a callsign, spotter or reference over 64 characters, a
spot id over 256). The daily housekeeping job deletes rows older than 30 days.

```sql
select id, source, occurred_at, error, raw_payload
from ingest_failures order by occurred_at desc limit 20;

-- Which errors are most common?
select source, error, count(*) from ingest_failures
where occurred_at > now() - interval '1 day'
group by 1, 2 order by 3 desc;
```

## Temporarily disable a source

```sql
select cron.alter_job(job_id := jobid, active := false) from cron.job where jobname = 'ingest-pota';
-- later
select cron.alter_job(job_id := jobid, active := true) from cron.job where jobname = 'ingest-pota';
```

The pulled sources' jobs are `ingest-pota`, `ingest-sotawatch` and `ingest-wwff`.
`cron.unschedule('ingest-pota')` removes the job entirely; re-running the cron migration
recreates it.

## Replay a failed spot

A failure is usually a normalizer bug or an upstream shape change. After fixing and redeploying
the function, the spot will be picked up again on the next run if it is still in the upstream
feed and under five minutes old. Otherwise, replay by hand with the stored payload: build the
normalized row yourself and call the same RPC the functions use.

```sql
select public.ingest_spots(jsonb_build_array(jsonb_build_object(
  'source', 'pota',
  'source_spot_id', '58161241',
  'content_hash', encode(sha256(convert_to('<spotTime>\n<activator>\n<reference>\n<frequency>\n<mode>\n<comments>', 'utf8')), 'hex'),
  'spot_time', '2026-10-05T13:37:03Z',
  'callsign', 'DL/HB9JNH',
  'spotter', 'OK1HRA',
  'frequency_khz', 10123.9,
  'band', '30m',
  'mode', 'cw',
  'mode_family', 'cw',
  'comment', 'RBN 22 dB 19 WPM via OK1HRA-#',
  'pota_reference', 'DE-0858',
  'pota_park_name', 'Via Sancti Martini National Historic Trail',
  'pota_location', 'DE-BW,DE-BY,DE-RP,DE-SL',
  'raw_payload', (select raw_payload from ingest_failures where id = <FAILURE_ID>)
)));

delete from ingest_failures where id = <FAILURE_ID>;
```

The RPC inserts the row and enqueues its `spot_events` message in one transaction, and the unique
constraint still applies, so a replay cannot create a duplicate.

## Queue

```sql
select * from pgmq.metrics('spot_events');
select msg_id, enqueued_at, message from pgmq.q_spot_events order by msg_id desc limit 10;
```

Nothing consumes the queue in Phase 1, so `queue_length` grows with `total_messages`.

# Phase 2

## Supabase Auth settings (dashboard, once)

Authentication → URL configuration:

- Site URL: `https://app.longlines.io`
- Redirect URLs: `https://app.longlines.io`, `https://app.longlines.io/set-password`
  (add `http://localhost:5173` and `http://localhost:5173/set-password` for local
  development against the hosted project)

Authentication → Providers → Email: enable "Confirm email". Leave signups on.

Authentication → SMTP: configure a custom SMTP provider. Supabase's built-in
mailer only delivers to members of your organization and is rate limited, so
sign-up confirmations and password resets for real users will not arrive
without it.

## Edge Function deploys

`sign-in` is public (`verify_jwt = false` in `config.toml`); the others require a
user or service-role JWT. Deploy with:

```sh
supabase functions deploy sign-in
supabase functions deploy delete-account
supabase functions deploy send-test
```

## Sign-in rate limiting

`sign_in_attempts` logs failed attempts per identifier and client (`begin_sign_in_attempt` logs each
attempt before the password check and `forget_sign_in_attempt` removes it unless the password was
wrong). A client gets 10 failures per identifier in 15 minutes, and an identifier 100 from all clients.
`client` is the same HMAC of the caller's address that `callsign-profile` rate limits on, from the
`LONGLINES_CLIENT_IP_HEADER` header (see "Which client IP the rate limit sees"); the first request that
falls back to `x-forwarded-for` logs `sign-in: no client address in <header>`. To see who is being
throttled:

```sql
select identifier, client, count(*) from sign_in_attempts
where attempted_at > now() - interval '15 minutes'
group by 1, 2 having count(*) >= 10;
```

Rows older than a day are deleted by the daily housekeeping job.

## Database tests

`supabase/tests/*.test.sql` are pgTAP suites that run against a fresh local
database (`supabase db start` or `supabase start`, then `supabase test db`). CI
runs them on every PR. `supabase/tests/helpers/users.psql` seeds two users and
an `as_user(uuid)` helper that switches to the `authenticated` role with that
user's JWT claims, which is how the RLS assertions work.

## Delivery

Outbound delivery (Discord, webhooks, web push) is the sender: a Deno process on Fly.io in
`sender/` (app `longlines-sender`), the way the relay holds the inbound streams. It connects to
Postgres as the `delivery_sender` role through the Supavisor pooler, polls `claim_deliveries()`
every few seconds and reports every outcome through its RPC allowlist. Every decision (what to
claim, each destination's budget, throttles, expiry, health) is made in SQL; the sender only sends.
Design notes are in `docs/ARCHITECTURE.md` ("Delivery: the sender"). The "Send test" button
(`send-test`) and the management API (`api`) still send from Edge Functions with the same modules.

### First deploy (sender)

In this order, from the repository root:

1. Database: `supabase db push` (the role, the rate-aware claim, the cutover).
2. The role password. `delivery_sender` is created without one, so edit the placeholder in
   `scripts/setup-sender-role.sql` and run it once against the hosted project. Never commit a copy
   with the real value.

   ```sh
   psql "$DATABASE_URL" -f scripts/setup-sender-role.sql
   ```

3. The Fly app, on a network of its own:

   ```sh
   fly apps create longlines-sender --network sender
   ```

   The sender POSTs to URLs users chose. `--network sender` gives the app its own 6PN with nothing
   else on it, so the relay and any later app cannot be reached from it even if the URL safety
   check were wrong; Fly's DNS at `fdaa::3` is the only private address it can see, and that one is
   refused. The network is fixed at creation; to change it, create a new app.

4. Secrets (the table below):

   ```sh
   fly secrets set -a longlines-sender \
     SENDER_DATABASE_URL='postgresql://delivery_sender.<PROJECT_REF>:<PASSWORD>@<POOLER_HOST>:5432/postgres' \
     LONGLINES_VAPID_PUBLIC_KEY=<public> LONGLINES_VAPID_PRIVATE_KEY=<private> \
     LONGLINES_VAPID_SUBJECT=mailto:you@example.com
   ```

5. First deploy, then pin the machine count:

   ```sh
   fly deploy --config sender/fly.toml --ha=false   # --ha=false: one machine, not two
   fly scale count 1 -a longlines-sender
   fly checks list -a longlines-sender
   ```

   Exactly one machine, always. The claim is a serial consumer: each cycle's marks land before
   its next claim, which is what keeps the 60 s visibility timeout from re-sending anything. A
   second machine would send duplicates, throttle destinations without coordination and split the
   counts. `fly scale show` must report one.

6. Bind Fly's GitHub integration with "Config path" `sender/fly.toml` and the working directory
   left at the repository root ("Automatic deploys" under "Relay" below). From then on every merge
   to `main` deploys it.

| Secret | Required | What it is |
| --- | --- | --- |
| `SENDER_DATABASE_URL` | yes | `postgresql://delivery_sender.<ref>:<password>@<pooler host>:5432/postgres`: the session pooler (port 5432, IPv4), TLS required; URL-encode a password with reserved characters. The sender holds no Supabase API key. |
| `LONGLINES_VAPID_PUBLIC_KEY`, `LONGLINES_VAPID_PRIVATE_KEY`, `LONGLINES_VAPID_SUBJECT` | for push | The same pair the Edge Functions hold ("Push notifications" below). Without all three, push deliveries fail with "Push isn't configured on the server." and Discord and webhooks carry on. |
| `SENDER_DATABASE_CA` | no, recommended | The PEM certificate the pooler's certificate must chain to (Supabase's `prod-ca-2021.crt`; "Verifying the database certificate" below). Without it the link is encrypted but the server is not verified, and the sender logs a warning at start. |
| `SENDER_POLL_MS` | no | Pause between claims that found less than a full batch; 5000, floor 1000, at most 3600000. |
| `SENDER_CONCURRENCY` | no | Destinations sent at once within a cycle; 4. |
| `SENDER_STALE_MS` | no | The watchdog: exit 1 after this long without a successful claim; 120000. At most 3600000, and at least 30000 more than the larger of `SENDER_POLL_MS` and the 60000 claim retry (90000 with the default poll), or the sender refuses to start. |
| `SENDER_STATS_MS` | no | How often `/healthz` refreshes its queue figures; 60000, at most 3600000. |
| `SENDER_HEALTH_PORT` | no | 8080, what `sender/fly.toml`'s check expects. |

`LONGLINES_ALLOW_INSECURE_DESTINATIONS` is refused with a non-local database host; never set it on
Fly.

At start the sender probes the database and, if the probe fails or gets no answer within 30 s,
retries after 5 s, doubling to 60 s, for up to five minutes before it exits 1. `sender/fly.toml`'s
restart policy (`always`) then starts it again, so a long database outage does not leave it down.

#### Verifying the database certificate

`SENDER_DATABASE_CA` makes the TLS link to the pooler verify the server: its certificate must
chain to the given CA and name the pooler host. Set it after the release that reads it is
deployed (an older image ignores it):

1. In the Supabase dashboard, Project Settings, Database, "SSL Configuration": download the
   certificate (`prod-ca-2021.crt`).
2. Set it; Fly restarts the machine with the new secret:

   ```sh
   fly secrets set -a longlines-sender SENDER_DATABASE_CA="$(cat prod-ca-2021.crt)"
   ```

3. Watch the start: `fly logs -a longlines-sender` must show the start-up line and no "TLS to the
   database does not verify" warning. A certificate the CA does not sign shows as
   `database probe failed: ...` retries.
4. If the chain verifies but the certificate does not name the pooler host, add
   `?sslmode=verify-ca` to `SENDER_DATABASE_URL` (chain only). To go back to the unverified link,
   `fly secrets unset -a longlines-sender SENDER_DATABASE_CA`.

`sslmode=verify-full` or `verify-ca` in `SENDER_DATABASE_URL` without `SENDER_DATABASE_CA` is
refused at start, since postgres.js would otherwise ignore it. Multi-line PEM text is expected; a
value with literal `\n` escapes works too.

### Is it running?

```sh
fly logs -a longlines-sender          # one JSON line per cycle that sent or failed something; queue stats every minute
fly checks list -a longlines-sender   # /healthz: healthy, last_claim_at, last_progress_at, last_error, in_flight, totals, queue
```

`/healthz` is 200 while the last progress (a successful claim, a finished send or a successful
bookkeeping call; the start before any) is under `SENDER_STALE_MS` old and 503 after, so a long
cycle that is still sending stays healthy. A 503 restarts nothing: Fly restarts the machine only when the process exits, and
the watchdog exits 1 at the same threshold, which is what a wedged pooler connection looks like.
`queue.depth` should stay near zero. `queue.expired_last_hour` counts deliveries that waited past
their age limit (push: the destination's "drop if offline" setting, 30 minutes by default;
everything else 24 hours) and were dropped undelivered; that is
the figure to watch.

```sql
select status, count(*) from deliveries where created_at > now() - interval '1 hour' group by 1;
select * from delivery_queue_stats();                -- what /healthz shows
select * from pgmq.metrics('deliveries_queue');
select name, type, health, consecutive_failures, throttle_level, throttled_until,
       last_error, last_error_at, last_success_at
from destinations order by health desc, last_error_at desc nulls last;
select jobname, status, return_message, start_time
from cron.job_run_details d join cron.job j using (jobid)
where jobname = 'match-pending-spots' order by start_time desc limit 10;
```

There is no delivery Edge Function any more: the cutover migration unscheduled the old `deliver`
cron job and took the pg_net kick out of `match_pending_spots`, which now does
`pg_notify('deliveries', '')` instead (nothing listens yet; the sender polls), and the cleanup
migration deleted the function with its two RPCs.

### A destination keeps failing

`destinations.last_error` holds the upstream status or the safety-check message. Retries follow
30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m, until the delivery is older than its limit (24 hours;
15 minutes for push), when SQL drops it and stamps `deliveries.dropped_at`. To stop retrying
without deleting the destination:

```sql
update destinations set health = 'paused' where id = '<id>';
-- later
update destinations set health = 'ok', consecutive_failures = 0 where id = '<id>';
```

The claim leaves paused destinations out; their messages wait in the queue and expire at the
same limits as any other.

### A destination is throttled

A 429 from Discord, a webhook or a push service is not a failure. The sender calls
`throttle_destination`, which sets `throttled_until` (the `Retry-After` when there is one, else
60 s doubling to 15 minutes per level) and moves the messages' visibility to match; the claim
skips the destination until then, and each successful cycle after it steps `throttle_level` down
by one. `consecutive_failures` is untouched. The claim also meters each destination per minute
(`destination_budget`: Discord 300 spots, push 3, webhooks 1000, burst equal to the rate), so a
burst is spread over minutes rather than refused.

```sql
select name, type, throttle_level, throttled_until, claim_tokens
from destinations where throttled_until > now();
update destinations set throttled_until = null, throttle_level = 0 where id = '<id>';  -- lift it now
```

### The sender is down

There is no Edge worker to fall back to: the `deliver` function, its cron job and its RPCs were
removed after the cutover (`20261015001400_sender_cleanup`). Deliveries wait in the queue while the
sender is stopped and expire at the usual limits (24 hours; 15 minutes for push), so the fix is
to get the machine back: `fly status -a longlines-sender`, `fly logs -a longlines-sender`, then
`fly machine restart <machine id> -a longlines-sender` (`fly machines list -a longlines-sender`
gives the id) or `fly scale count 1 -a longlines-sender`. The git history before
`20261015001400` has the old worker and its cron bodies if one is ever needed again.

### A change that spans both sides

The sender deploys itself on merge; migrations and Edge Functions are pushed by hand. Order the
hand steps so both sides work at every step:

1. A new column or RPC the sender will read: `supabase db push` first, then merge. The running
   sender ignores what it does not use, and the new one finds it there.
2. A new RPC the sender calls: its migration grants `execute` to `delivery_sender` and
   `sender_role.test.sql` lists it, in the same PR; push the migration before merging.
3. Renaming or dropping an RPC the sender calls: add the new one (push), merge the sender that
   uses it, drop the old one in a later migration. Dropping first leaves the sender logging a
   failed claim every poll until the watchdog exits it, and Fly restarting it, until the deploy.
4. Shared delivery code (`supabase/functions/_shared/delivery/*`) also ships in `send-test` and
   `api`: `supabase functions deploy send-test api` after the merge, so a test send and a real one
   agree.

### Local development

`npm run sender` runs the sender against the local stack with
`LONGLINES_ALLOW_INSECURE_DESTINATIONS=1`, so a plain-http receiver on this machine can stand in
for a destination; insert the destination row directly in SQL, since `create_destination()` will
not accept such a URL. The Edge Functions (`send-test`) read the same variable from
`supabase/functions/.env` under `supabase functions serve`. Never set it on the hosted project or
on Fly; the sender refuses it with a non-local database host.

### Push notifications

Push sends are signed with a VAPID keypair held in two places: the sender's Fly secrets (real
deliveries) and Edge Function env (`send-test` and `api`). It is the same pair in both, and in
nothing else: not the web app, the relay or a migration. Without all three values, push deliveries
fail with "Push isn't configured on the server." and Discord and webhooks carry on as normal.

Once per project, generate a pair. The script prints three lines and writes nothing:

```sh
deno run scripts/generate-vapid-keys.ts mailto:you@example.com
```

Hosted: set the three values on both sides, then redeploy the Edge Functions that send push.
Setting the Fly secrets restarts the sender.

```sh
supabase secrets set LONGLINES_VAPID_PUBLIC_KEY=<public> LONGLINES_VAPID_PRIVATE_KEY=<private> \
  LONGLINES_VAPID_SUBJECT=mailto:you@example.com
supabase functions deploy send-test
supabase functions deploy api
fly secrets set -a longlines-sender LONGLINES_VAPID_PUBLIC_KEY=<public> \
  LONGLINES_VAPID_PRIVATE_KEY=<private> LONGLINES_VAPID_SUBJECT=mailto:you@example.com
```

The web app needs the public key too, so browsers subscribe with it: set `VAPID_PUBLIC_KEY=<public>`
in the Vercel project's environment variables for production and preview ("Web app on Vercel"
below) and redeploy. `web/vite.config.ts` maps it onto `VITE_VAPID_PUBLIC_KEY`; the private key
never goes there. Without it the app reports push as unsupported and the Add a device dialog
shows "This browser can't receive push notifications."

Locally, put the same three lines in `supabase/functions/.env` (`npm run sender` passes them
through) and `LONGLINES_VAPID_PUBLIC_KEY` in `web/.env.local`.

Don't rotate the pair casually. Every browser subscribed with the public key that was current at
the time, so new keys break every registered device until it subscribes again.

Is it working?

```sql
select count(*) as devices, count(last_error) as with_errors, count(blocked_at) as blocked,
       max(last_success_at) as last_success
from push_devices;
select label, agent, last_success_at, last_error, last_error_at, blocked_at from push_devices
where last_error_at > now() - interval '1 day' or blocked_at is not null
order by greatest(last_error_at, blocked_at) desc;
-- Each push destination: on or off, health, members that can receive, and its delivery settings.
select d.name, d.enabled, d.health, d.last_error,
       count(p.id) filter (where p.blocked_at is null) as receiving, count(p.id) as members,
       s.urgency, s.ttl_seconds, s.quiet_enabled, s.quiet_mode
from destinations d
join push_destination_settings s on s.destination_id = d.id
left join push_destination_devices m on m.destination_id = d.id
left join push_devices p on p.id = m.device_id
where d.type = 'push'
group by d.id, s.destination_id
order by d.name;
```

Endpoints and keys in `push_devices` are capability secrets: don't paste them anywhere. A device
the push service reports gone (404/410) is deleted on the next send. A browser that finds
notifications blocked reports it (`blocked_at`); blocked devices are skipped until they register
again. A push destination with no receiving members fails each cycle with "Turn on notifications
on a device first." and goes `failing` after five, like any other destination. Spots skipped by
quiet hours ("Don't send") are marked sent, not failed. A push delivery older than the
destination's "Drop if the device is offline for" (`push_destination_settings.ttl_seconds`, 30
minutes by default, 5 minutes to 4 hours) is dropped undelivered (`dropped_at`); that setting
overrides the 15-minute `destination_max_age('push')` default, which now applies only to a push
destination without a settings row. A stale notification is worse than none.

### Housekeeping

A daily job (`housekeeping`, 03:00 UTC) deletes deliveries (sent or dropped) and archived queue
messages older than 7 days, sign-in attempts older than a day, `ingest_failures` older than 30 days
and `subscription_quiet` rows sent more than an hour ago (the longest quiet window).

### Stats snapshot

An hourly job (`refresh-stats-snapshot`, five past every hour) runs `refresh_stats_snapshot()`,
which inserts one `stats_snapshots` row for the last seven complete UTC days and prunes the table
to 48 rows. The Stats page shows the newest row; on a fresh project it shows "Not enough data yet"
until the first run. To refresh by hand:

```sql
select refresh_stats_snapshot();
select generated_at, payload->'totals' from stats_snapshots order by generated_at desc limit 1;
```

`cron.job_run_details` shows failed runs under that job name.

## Web app on Vercel

Create a Vercel project from the GitHub repo with these settings:

- Root directory: `web`
- Framework preset: Vite (build `npm run build`, output `dist`)
- Environment variables: with the Supabase ↔ Vercel integration enabled, the
  project receives `SUPABASE_URL`, `SUPABASE_ANON_KEY` (plus `NEXT_PUBLIC_`
  copies and the service-role key) automatically. `web/vite.config.ts` maps
  only the URL and the anon key onto the `VITE_` names the app reads; the
  service-role key is never read and never reaches the bundle. Without the
  integration, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or the `VITE_`
  names) by hand.
- `VITE_CONTACT_EMAIL` (set by hand): the address callsign profiles give for
  hiding a page ("To have this page hidden, email …"). Without it the footer
  leaves that sentence out. It is public; it ships in the bundle.
- `VAPID_PUBLIC_KEY` (set by hand, production and preview): the public half of
  the push pair ("Push notifications" above). It is public by design and ships
  in the bundle; without it push is unsupported in the app.
- Domain: `app.longlines.io`

`web/vercel.json` rewrites every path to `index.html` so client-side routes
load directly. Nothing else is host-specific; `npm run build` produces a plain
static site in `web/dist`.

After the first deploy, make sure Supabase Auth → URL configuration lists
`https://app.longlines.io` as the Site URL and includes
`https://app.longlines.io/set-password` in the redirect URLs, or confirmation
and reset links will not land in the app.

## Regenerating database types

Whenever a migration changes a table, view or RPC the app uses:

```sh
supabase start   # or db start
supabase gen types typescript --local > web/src/lib/database.types.ts
```

The generated file is committed; CI type-checks the app against it.

# Relay (RBN, DX Cluster, APRS-IS)

The relay in `relay/` runs on Fly.io as app `longlines-relay`. It holds one session per feed:
RBN (`ingest-rbn`), DX Cluster (`ingest-dxcluster`) and, once `APRS_LOGIN_CALL` is set, APRS-IS
(`ingest-aprs`). Design notes are in `docs/ARCHITECTURE.md`
("Streaming sources: the relay").

## First deploy

```sh
# 1. Database and function (Supabase side)
supabase db push                                   # adds the rbn source, watchlist RPC, matcher guard
openssl rand -hex 32                               # the relay secret; use it in both places below
supabase secrets set LONGLINES_RELAY_SECRET=<secret>
supabase functions deploy ingest-rbn

# 2. Relay (Fly side), from the repository root
fly apps create longlines-relay                    # name must match app in relay/fly.toml
fly secrets set \
  LONGLINES_FUNCTIONS_URL=https://<project-ref>.supabase.co/functions/v1 \
  LONGLINES_RELAY_SECRET=<secret> \
  RELAY_LOGIN_CALL=<callsign>
fly deploy --config relay/fly.toml --ha=false      # --ha=false: one machine, not two
fly scale count 1                                  # exactly one machine: one telnet session
```

## Automatic deploys

Deploys on merge to `main` come from Fly's GitHub integration, set up in the Fly dashboard rather
than in this repo. Each Fly app has its own binding: "Config path" is `relay/fly.toml` for
`longlines-relay` and `sender/fly.toml` for `longlines-sender`, and the working directory is left
blank (the repository root) on both, because each Dockerfile copies
`supabase/functions/_shared` from the context. flyctl resolves `[build] dockerfile` relative to
the config file, so each `fly.toml` names just `Dockerfile`. Both apps deploy on every push to
`main`, whichever folder changed.

When the integration was first connected, Fly's launcher opened a PR (#30) with its own generic
`fly.toml`, `Dockerfile` and `example.ts`. That config ran a nonexistent `main.ts` as root, added a
public HTTP service that auto-stops idle machines, and created two machines. Do not merge such a
PR again; `relay/fly.toml` is the relay's real config.

Two things to know about it:

- It is not gated on CI. A merge to `main` deploys whether or not the PR's checks passed, so keep
  `main` protected by the CI checks.
- Every deploy restarts the machine and opens a new session to RBN. If the integration deploys on
  every push rather than only when `relay/` or `supabase/functions/_shared/*.ts` change, that is
  one reconnect per merge.

It deploys only the two Fly apps. Migrations (`supabase db push`) and the Edge Functions
(`supabase functions deploy ingest-rbn`) are still applied by hand; do those first when a change
needs both sides ("A change that spans both sides" under "Delivery" has the order for the sender).
After the first deploy, check `fly scale show` reports one machine.

A deploy restarts the machine; the relay pushes what it has buffered before exiting.

## Is it running?

```sh
fly logs                                  # "connected to ...", stats every 10 min
fly checks list                           # /healthz: per-feed connected, last_data_at, dropped, pushed
```

```sql
select * from ingest_health where source = 'rbn';
select count(*) from rbn_spots where spot_time > now() - interval '1 hour';  -- tens of thousands when RBN is busy
```

`last_success_at` should never be more than about a minute old: the relay pushes a heartbeat
every 60 seconds even when no watched station was heard. `spots_last_hour` is zero unless a
watched station was on the air.

## Why is a watched station not showing up?

1. `select * from watched_among('rbn', array['W1AW/4']);` must return it, with the call as RBN
   reports it. Only enabled subscriptions whose sources are empty or include RBN contribute.
   Changes apply to the next batch.
2. A subscription callsign matches the reported call exactly or by base call: `W1AW` catches
   `W1AW/4`, but `W1AW/P` catches only `W1AW/P`.
3. RBN hears CW and RTTY on port 7000 only. FT8/FT4 is not connected.
4. Check `ingest_failures where source = 'rbn'` and the relay logs for `push failed`.
5. Check `rbn_spots` for the call: if it is there but not in `raw_spots`, the subscription does not
   watch it; if it is not there, RBN did not hear it.

## rbn_spots size

About 1.5 million rows and 350 MB a day; seven days (2.5-3 GB) stay in the database. A day is
retired once the callsign rollups have recorded it (`callsign_rollup_days`, normally at 02:25 UTC the next day)
or once it is 14 days old. `select pg_size_pretty(pg_total_relation_size('rbn_spots'));` shows the total;
`select tableoid::regclass, count(*) from rbn_spots group by 1 order by 1;` shows rows per day.
A line more than seven days late lands in the default partition. If its day was already retired,
retention deletes it the next night (warning `rbn retention: <day> was retired; deleting its late
rows`) and keeps the day's archive as it is; APRS-IS does the same.

## Rotating the relay secret

Set the new value on both sides; spots buffered in between are retried and kept.

```sh
supabase secrets set LONGLINES_RELAY_SECRET=<new>
fly secrets set LONGLINES_RELAY_SECRET=<new>
```

## Local run

With `supabase start` and `supabase functions serve --env-file <file with LONGLINES_RELAY_SECRET>`:

```sh
LONGLINES_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 \
LONGLINES_RELAY_SECRET=<same value> RELAY_LOGIN_CALL=<callsign> \
deno run --allow-net --allow-env relay/main.ts
```

This opens real connections to RBN and the DX Cluster node (and APRS-IS if `APRS_LOGIN_CALL` is
set); stop it when done. In Docker, use
`http://host.docker.internal:54321/functions/v1`.

## DX Cluster

The second feed. It logs in to a DXSpider node with `RELAY_LOGIN_CALL` and forwards every human
spot line; skimmer lines a node relays are dropped. The default node is G1FEF-2,
`dxc.hamserve.uk:7300`, which gives read access without registration. To use another node:

```sh
fly secrets set DXCLUSTER_HOST=dxc.nc7j.com DXCLUSTER_PORT=7373   # restarts the machine
fly secrets unset DXCLUSTER_HOST DXCLUSTER_PORT                    # back to the default
```

First deploy, in this order: the migration (`supabase db push`, `20261012000020_dxcluster_source`),
then `supabase functions deploy ingest-dxcluster` (the Supabase GitHub integration does not deploy
a new function), then the relay. The relay uses the existing `LONGLINES_RELAY_SECRET`. If the
relay goes first, its pushes fail with 404 until the function exists; the forwarder keeps the
lines and retries, so nothing is lost unless that lasts for hours.

Is it running?

```sql
select * from ingest_health where source = 'dxcluster';
select spot_time, spotter, callsign, frequency_khz, mode, comment
from raw_spots where source = 'dxcluster' order by spot_time desc limit 20;
```

`last_success_at` advances every minute (the heartbeat). `spots_last_hour` is usually in the
hundreds. Human spots can pause overnight, so the relay waits 15 minutes without data before it
reconnects, and `/healthz` marks the feed unhealthy after 20.

A subscription receives DX Cluster spots only when its sources list DX Cluster; "any source" does
not include it. If a DX spot is missing, check the subscription's sources first, then
`ingest_failures where source = 'dxcluster'`, then the relay logs (`[dxcluster]`).

## APRS-IS

The third feed: the APRS-IS full feed, every packet on the network, from `rotate.aprs2.net:10152`.
It is off until `APRS_LOGIN_CALL` is set. Pick a call-SSID that no other APRS client of yours uses
(APRS-IS drops the older of two connections with the same login), at most nine characters:

```sh
fly secrets set APRS_LOGIN_CALL=<CALL-SSID>              # restarts the machine; the feed starts
fly secrets set APRS_HOST=noam.aprs2.net APRS_PORT=10152  # optional: another server
fly secrets unset APRS_LOGIN_CALL                         # turns the feed off again
```

The login is receive-only (passcode -1) with no filter. Never add one: the full feed is the point.

First deploy, in this order: merge (the Supabase GitHub integration applies
`20261014000010_aprs_source` and Fly redeploys the relay with the feed still off), then
`supabase functions deploy ingest-aprs` (the integration does not deploy a new function), then
`fly secrets set APRS_LOGIN_CALL=...`. Setting the secret before the function exists makes every
push fail with 404; the forwarder keeps up to 150,000 lines (about 25 minutes) and retries.

Is it running?

```sql
select * from ingest_health where source = 'aprs';
select received_at, source_call, packet_type, line from aprs_packets
where received_at > now() - interval '5 minutes' order by received_at desc limit 20;
select packet_type, count(*) from aprs_packets
where received_at > now() - interval '1 hour' group by 1 order by 2 desc;
select hour_start, packets from aprs_packet_hours order by hour_start desc limit 24;
```

`spots_last_hour` here counts packets: expect a few hundred thousand. The relay's ten-minute stats
log (`[aprs] ... lines, ... spots, ... pushed, ... buffered, ... dropped`) gives the rate as the relay
sees it; `dropped` above 0 means Supabase was unreachable for longer than the buffer. APRS-IS sends
a keepalive about every 20 s, so the relay reconnects after 2 minutes of silence and `/healthz`
marks the feed unhealthy after 5.

Size: about 300 bytes a packet with indexes, so roughly 2.5 GB a day at 100 packets a second. The
database keeps yesterday and today; the B2 archive grows by roughly 0.3 GB a day (measured as gzipped
NDJSON; not yet re-measured since the archive moved to Parquet).

```sql
select pg_size_pretty(sum(pg_total_relation_size(i.inhrelid)))
from pg_inherits i where i.inhparent = 'public.aprs_packets'::regclass;
```

# WWFF

World Wide Flora & Fauna spots, polled from `https://spots.wwff.co/static/spots.json` by the
`ingest-wwff` function. The `ingest-wwff` cron job calls it every minute (the feed is served with
`max-age=60`), and spots land in `raw_spots` like POTA's, with the reference in `wwff_reference`
and its name in `wwff_reference_name`. There is no relay side.

First deploy, in this order: merge (the Supabase GitHub integration applies
`20261015001000_wwff_source`; the cron job then calls `ingest-wwff`, which answers 404 until the
next step), then deploy the new function and redeploy the two whose shared code changed. The
integration does not deploy a new function:

```sh
supabase functions deploy ingest-wwff
# Discord "WWFF" and "Reserve" fields and push text ship with the sender on merge (the Edge
# `deliver` function this step once redeployed is gone).
supabase functions deploy archive    # wwff in the run order, two new Parquet columns
```

Is it running?

```sql
select * from ingest_health where source = 'wwff';
select spot_time, callsign, wwff_reference, wwff_reference_name, frequency_khz, mode, comment
from raw_spots where source = 'wwff' order by spot_time desc limit 20;
select * from archive_status where source = 'wwff';
```

`last_success_at` advances every minute. The feed holds only the latest spot per activator, so
`spots_last_hour` runs well below POTA's, and an hour with none is normal at night in the busy
regions. To pause it, turn
the cron job off as for the other pulled sources ("Temporarily disable a source", with
`jobname = 'ingest-wwff'`); `npm run invoke:wwff` runs it once against the local stack.

A subscription receives WWFF spots only when its sources list WWFF; "any source" does not include
it, as with DX Cluster, because many US `KFF` references are POTA activations too. If a WWFF spot
is missing, check the subscription's sources first, then
`ingest_failures where source = 'wwff'`. Callsign profiles pick WWFF up for today at once and for
days rolled up after the deploy; earlier days are never rolled up again.

# Spot archive

How it works is in `docs/ARCHITECTURE.md` ("The spot archive"). The files live in a private
Backblaze B2 bucket, written through B2's S3-compatible API.

## Setup (Backblaze B2)

1. Create a private bucket (B2 console or `b2 bucket create <bucket> allPrivate`). Its
   endpoint is on the bucket page, e.g. `s3.us-west-004.backblazeb2.com`; the region is the
   middle part (`us-west-004`).
2. Create an application key restricted to that bucket with only `writeFiles` (the worker only
   PUTs; overwriting a re-archived slice needs nothing more). A master key does not work with
   the S3 API.

   ```sh
   b2 key create --bucket <bucket> longlines-archive-writer writeFiles
   ```

3. Set the five function secrets and redeploy `archive`:

   ```sh
   supabase secrets set \
     LONGLINES_ARCHIVE_S3_ENDPOINT=https://s3.<region>.backblazeb2.com \
     LONGLINES_ARCHIVE_S3_REGION=<region> \
     LONGLINES_ARCHIVE_S3_BUCKET=<bucket> \
     LONGLINES_ARCHIVE_S3_ACCESS_KEY_ID=<keyID> \
     LONGLINES_ARCHIVE_S3_SECRET_ACCESS_KEY=<applicationKey>
   supabase functions deploy archive
   ```

Until all five are set, every run answers 500 naming the missing ones and slices stay pending;
nothing is lost, and RBN and APRS-IS days stay in the database until their slices are archived.
To rotate the key, create a new one, set the two key secrets, then delete the old key.

Locally, `archive` writes to the stack's own Storage through its S3 endpoint (the `archive`
bucket the migrations create). Put these in `supabase/functions/.env`, with the key and secret
`supabase status` prints as the S3 access key:

```sh
LONGLINES_ARCHIVE_S3_ENDPOINT=http://kong:8000/storage/v1/s3   # as seen from the functions container
LONGLINES_ARCHIVE_S3_REGION=local
LONGLINES_ARCHIVE_S3_BUCKET=archive
LONGLINES_ARCHIVE_S3_ACCESS_KEY_ID=<S3 access key>
LONGLINES_ARCHIVE_S3_SECRET_ACCESS_KEY=<S3 secret key>
```

Plain http is accepted only for `127.0.0.1`, `localhost`, `kong` and `host.docker.internal`.

## Moving the Storage archive to B2 (one-off, 2026-10)

Slices archived before the switch are in the Supabase Storage bucket `archive`. Object keys are
the same in both places, so `archive_log.object_path` needs no change. After the deploy above
(new slices then go only to B2), copy the old objects with rclone from an operator's machine:

```sh
# ~/.config/rclone/rclone.conf
[supabase]
type = s3
provider = Other
endpoint = https://<project-ref>.supabase.co/storage/v1/s3
region = <project region>
access_key_id = <Storage S3 access key>
secret_access_key = <Storage S3 secret>
force_path_style = true

[b2]
type = s3
provider = Other
endpoint = https://s3.<region>.backblazeb2.com
region = <region>
access_key_id = <a B2 key with listFiles, readFiles and writeFiles on the bucket>
secret_access_key = <its applicationKey>
force_path_style = true
```

```sh
rclone copy supabase:archive b2:<bucket> --ignore-existing --checksum --progress
rclone check supabase:archive b2:<bucket> --one-way     # every Storage object is in B2
```

`--ignore-existing` keeps any slice the new worker has already rewritten in B2. The migration key
needs more than `writeFiles`, so delete it afterwards. Once `rclone check` is clean, check the
log against B2 and then delete the Storage bucket (Storage settings, or empty it and delete it
in the dashboard; SQL cannot delete Storage objects), and delete the Storage S3 access key:

```sql
select source, count(*), sum(bytes) from archive_log where object_path is not null group by 1;
```

```sh
rclone size b2:<bucket>    # object count matches the log's total (plus any old .ndjson.gz)
```

## Is it keeping up?

```sql
select * from archive_status;   -- pending_slices should stay at 0-2 per source
select status_code, content::text from net._http_response order by created desc limit 5;
```

A growing `pending_slices` means runs are failing; the `archive` function's responses (500 with an
`errors` list) say why. Nothing is lost meanwhile: retention drops no RBN or APRS-IS day until its
slices are archived. APRS-IS has its own job, `archive-aprs`, every five minutes; its
`pending_slices` can sit a little higher than the others' because each run takes two slices.

## Re-archive a slice

```sql
delete from archive_log where source = 'rbn' and slice_start = '2026-10-11 14:10+00';
```

The next run rewrites the object at the same path. A slice first archived as NDJSON (before
2026-10-14) comes back as Parquet at its new path; the old `.ndjson.gz` object stays until it is
deleted by hand or by the NDJSON migration.

## Retention

`maintain_rbn_spots()` runs at 03:35 UTC. It checks every eligible day first and drops the archived
ones last, giving up on a drop after a 5 s lock wait (it retries the next night). To see why a day
is still in the database:

```sql
select * from rbn_day_slices('2026-10-01') where archived_rows is distinct from db_rows;
```

`maintain_aprs_packets()` does the same for APRS-IS at 03:45 UTC, dropping days that are two days
old (`aprs_day_slices` shows why a day stays).

## Reading the archive

DuckDB reads the files straight from B2's S3 endpoint. The day folders are Hive-style, so
`year`, `month` and `day` become columns and a filter on them skips the other folders. Use a
separate read-only key (`b2 key create --bucket <bucket> longlines-archive-reader listFiles,readFiles`),
never the worker's:

```sql
install httpfs; load httpfs;
create secret (type s3, key_id '<keyID>', secret '<applicationKey>',
               endpoint 's3.<region>.backblazeb2.com', region '<region>', url_style 'path');
select spot_type, count(*)
from read_parquet('s3://<bucket>/rbn/*/*/*/*.parquet', hive_partitioning = true)
where year = 2026 and month = 10 and day = 14
group by 1;
```

Slices archived before 2026-10-14 are still gzipped NDJSON in the old layout until the one-off
migration rewrites them; read those with
`read_json_auto('s3://<bucket>/rbn/2026/10/11/*.ndjson.gz')`.

B2 keys belong on an operator's machine or in the `archive` function's secrets, never in the web
app or the relay. Downloads are free up to three times the stored size a month; a full-history
scan from outside B2 counts against that.

# Countries (cty.dat)

How it works is in `docs/ARCHITECTURE.md` ("Countries (cty.dat)").

## First load

`import-cty` is a new function, so it needs one manual deploy after the merge (the Supabase GitHub
integration skips new functions). Then run it once instead of waiting for Monday:

```sh
supabase functions deploy import-cty
curl -X POST "$SUPABASE_URL/functions/v1/import-cty" -H "Authorization: Bearer <service-role JWT>"
```

```sql
select * from cty_load;                         -- version, about 340 entities, 7,000+ prefixes
select * from cty_lookup('SM1HEV-#');           -- Sweden, EU
```

## A load failed

`cty_load.loaded_at` moves forward on every successful run, so a stale one means the weekly import
is failing:

```sql
select version, loaded_at, now() - loaded_at as age from cty_load;   -- age should stay under 7 days
```

pg_net keeps responses for only a few hours, so read the reason by running the import by hand
(the `curl` under "First load"). Its response says what went wrong:

- 401 is the gateway rejecting the Vault JWT.
- 403 means the token is not the service role.
- 500 names the download, parse or `load_cty` error.

The function's logs in the dashboard have the same messages. The previous set stays loaded
throughout, so lookups keep working.

# Callsign rollups

How they work is in `docs/ARCHITECTURE.md` ("Callsign rollups").

## First backfill (hosted)

The rollups ship as a migration only; there is no function to deploy. Retention retires an RBN day
without its rollup once it is 14 days old, so every RBN day must be rolled up before the 03:35 UTC
run on 2026-10-26, when the first RBN day (2026-10-11) turns 14 days old. The hourly
`rollup-callsign-days` job does this on its own at two days an hour once the migration is live;
running it by hand shows the result sooner. cty.dat must be loaded first (`select * from
cty_load;`), or every day is refused.

```sh
supabase db push
```

Then, in the SQL editor, a few days at a time (an RBN day takes about a minute):

```sql
select * from backfill_callsign_rollups(3);   -- repeat until it returns no rows
```

Each row is a day with its spot count; an RBN day is about 1.5 million. A row with an `error` was
undone and is retried on the next call. Then check:

```sql
select min(day), max(day), count(*) from callsign_rollup_days;  -- first spot's day through yesterday, no gaps
select tableoid::regclass, count(*) from rbn_spots group by 1 order by 1;  -- partitions all still present
select * from callsign_seen where base = 'KK4PWJ';
select pg_size_pretty(pg_total_relation_size('callsign_activity'));
```

## Is it keeping up?

```sql
select max(day) from callsign_rollup_days;   -- yesterday, once 03:35 UTC has passed
select d::date as missing
from generate_series((select min(day) from callsign_rollup_days), (now() at time zone 'utc')::date - 1, interval '1 day') d
where d::date not in (select day from callsign_rollup_days);
```

A missing day failed in the hourly job (Postgres logs: `callsign rollup of ... failed`).
`select * from backfill_callsign_rollups(1);` retries it and shows the error. The two refusals:

- `no cty.dat loaded`: run `import-cty` (see "Countries (cty.dat)").
- `the RBN spots of ... were retired`: the day failed for 14 days and retention dropped its RBN
  rows. They are only in the archive now. `select rollup_callsign_day('<day>', true);` rolls up the
  other sources and marks the day, accepting that its RBN spots are missing from every profile.
  Until then the day is retried, and warned about, every hour.

## Size

`callsign_activity` is the big one: about 270 bytes a row with its index, one row per station,
source, band and mode bucket per day, folded into month rows after 35 days. Check it with
`select grain, count(*), pg_size_pretty(pg_total_relation_size('callsign_activity')) from callsign_activity group by 1;`.

## Rolling a day up again

Not supported: references, days on the air and variants are running totals, so a second pass
would count the day twice. A day's rollup can only be redone by rebuilding every table from the
archive.

# Licenses (FCC)

How it works is in `docs/ARCHITECTURE.md` ("Licenses (FCC)").

## First deploy

The relay deploys itself on merge, so the database and function go first. If the relay checks
before they exist, it logs `[licenses] load failed` and tries again six hours later. Nothing
breaks in the meantime.

```sh
supabase db push                          # 20261012000050_callsign_licenses
supabase functions deploy load-licenses   # new function: the GitHub integration skips it
```

The function uses the existing `LONGLINES_RELAY_SECRET`. The relay's first check runs five minutes
after it starts; it downloads about 160 MB from the FCC and stages about 1.7M records per file in ~1,000
requests, which takes several minutes. The unlogged staging tables hold a few hundred MB until
the swap, or an abandoned load, empties them. The load
is applied at the next :50.

```sql
select id, version, status, started_at, ready_at, applied_at, counts, licenses, error
from license_loads order by id desc limit 5;
select * from callsign_licenses where callsign = 'KK4PWJ';
```

## Is it current?

The newest load should be `applied` with a `version` from the last Sunday, and `applied_at` under
about eight days old. Relay logs show each step with `[licenses]` (`fly logs`):

- `loading ... (<Last-Modified>)`, then one line per file with staged and skipped counts, then
  `load finished`.
- `load failed: ...` names the download, parse or function error; the load is `failed` with the
  same text in `error`. It is retried twelve hours after it started. A load still `loading` long
  after it started means the relay stopped mid-load (a deploy, a crash); the next `begin` clears it.

A load stuck at `ready` past :50 means the cron job failed: `select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'apply-license-loads') order by start_time
desc limit 3;`. A `failed` load has the reason in `error`; the previous set stays loaded throughout.

## Turning it off

`fly secrets set RELAY_LICENSES=off` (restarts the machine) stops the relay loading licenses;
`fly secrets unset RELAY_LICENSES` turns it back on. `RELAY_LICENSES` can also name another URL
serving the same zip with Range support.

A local run (functions URL on localhost) does not load licenses by default. To exercise the real
load locally, serve `load-licenses` and set `RELAY_LICENSES=https://data.fcc.gov/download/pub/uls/complete/l_amat.zip`;
it downloads about 160 MB, so not routinely.

# Callsign profiles

How they work is in `docs/ARCHITECTURE.md` ("Callsign profiles").

## First deploy (hosted)

`20261012000060_callsign_profile` (applied 2026-10-12) builds the `rbn_spots` base-callsign index
one partition at a time, oldest first, then creates the parent index `ON ONLY` and attaches them.
Each partition is locked against inserts from its build until the migration commits, so a late row
for an older day (the relay buffers about 50 minutes, so just after 00:00 UTC it still sends
yesterday's) waits until the end. The `ON ONLY` create takes a SHARE lock on the parent, which holds
up every RBN insert from then until commit; the attach loop after it only changes catalogs, so that
window is short. Today's partition, built last, is the long wait. Locally, at hosted volume, each full day took about
16 s, and an insert probe into today's partition every second never waited more than 19 ms while the
older days built. Today's partition takes about 16 s at the end of a UTC day and a few seconds in the
early hours, under the API's 8 s timeout that `ingest-rbn` pushes run into; a push that does time out
is retried by the relay, which buffers about 50 minutes. Prefer the early UTC hours, after retention
at 03:35 removes old days, and avoid :25, when the rollup job reads `rbn_spots`.

The GitHub integration applies the migration on merge, so merge then, or push it first:

```sh
supabase migration list                    # 20261012000060 must be the only one pending
supabase db push
supabase functions deploy callsign-profile # new function: the GitHub integration skips it
```

Then check, in the SQL editor:

```sql
select indisvalid from pg_index where indexrelid = 'rbn_spots_base_callsign_time_idx'::regclass;  -- t
select cached_callsign_profile('KK4PWJ') -> 'heard' -> 'spots';
```

The migration takes no lock on the parent during the per-partition builds, so `maintain_rbn_spots`
creating or dropping a partition meanwhile would have made the attach loop fail (a partition with no
index) or deadlock with it. Avoid 03:35 UTC. A later migration that builds an index this way should
start with `lock table rbn_spots in share update exclusive mode`, which blocks partition creation,
attachment and drops but not inserts.

If a push timed out, the relay logs `push failed` and retries. A gap in RBN rows that outlasts the
relay's buffer shows in `select date_trunc('minute', spot_time), count(*) from rbn_spots
where spot_time > now() - interval '2 hours' group by 1 order by 1;`.

## Is it working?

```sh
curl -si "$SUPABASE_URL/functions/v1/callsign-profile?callsign=KK4PWJ" | head -20
```

200 with `Cache-Control: public, max-age=300` and the profile; 400 for input that is not a
callsign; 429 past 30 lookups a minute from one IP; 500 means an RPC failed (the function logs
`callsign-profile:` with the error). Clients being throttled now:

```sql
select client, lookups from lookup_rate_limits
where window_start = date_trunc('minute', now()) and lookups > 30;
```

`client` is an HMAC of the IP keyed with the service-role key, never the address.

## Which client IP the rate limit sees

The function keys on the header named by the `LONGLINES_CLIENT_IP_HEADER` function secret
(`cf-connecting-ip` when unset), which the edge proxy sets and a client cannot. If that header holds a
list, it takes the last entry. Without a usable address there, it uses the last `x-forwarded-for`
entry, which the nearest proxy appended. A client cannot spoof that, but it may be the proxy's own
address, so every visitor would share one limit of 30 lookups a minute. The first request that falls
back in each isolate logs `callsign-profile: no client address in <header>`. It never uses the first
`x-forwarded-for` entry, which the client writes. IPv6 clients count by their /64.

After a deploy, check both ways it can go wrong. First, a client must not be able to reset its own
limit:

```sh
for i in $(seq 1 31); do
  curl -s -o /dev/null -w "%{http_code} " -H "x-forwarded-for: 192.0.2.$i" \
    "$SUPABASE_URL/functions/v1/callsign-profile?callsign=KK4PWJ"
done   # the 31st must be 429 (earlier if you looked something up in the same minute)
```

Leave `cf-connecting-ip` out: Cloudflare, in front of the hosted project, answers 403 to any
request that sets it, so a client cannot spoof it at all. Checked on 2026-10-13: 429 arrived on
time. If it does not, the header is passed through from the client: find the one the proxy sets (log
`req.headers` once) and `supabase secrets set LONGLINES_CLIENT_IP_HEADER=<name>`. Second, clients
must not share one limit: the function logs must not contain `no client address in`, and after
that loop a lookup from another network (a phone off Wi-Fi) must still get 200. The `prune-callsign-lookups` job (:15 hourly)
deletes finished windows and cache entries older than 15 minutes.

## Hiding a profile

On request (the page footer gives the contact address), by base call:

```sql
insert into hidden_callsigns (callsign, note) values ('KK4PWJ', 'email 2026-10-12');
delete from hidden_callsigns where callsign = 'KK4PWJ';   -- show it again
```

A hidden call gets the not-heard page with no license from the next lookup on; the cache is
skipped for it. Browsers and CDNs may still hold the old page for up to 5 minutes.
The Stats snapshot drops hidden calls from its top lists (a trigger on `stats_snapshots`) from the
next hourly refresh on; to drop a newly hidden call now, run
`update stats_snapshots set payload = payload;`.

## A profile looks stale

Profiles are cached for 15 minutes. To rebuild one now:
`delete from callsign_profile_cache where callsign = 'KK4PWJ';`. Days that are rolled up come from
the rollups ("Callsign rollups" above); today and yesterday until 02:25 UTC are read live.
