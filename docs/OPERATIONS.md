# Operations

All queries below run in the Supabase Studio SQL editor (or psql as `postgres`).

## Health page

`/health` on the web app is the first stop: eight checks against their rules, queue and capacity
charts, and every cron job's last result. It is public and read-only, built by
`health_snapshot(range)` and served by the `health` function from a 30-second cache. The design is
`docs/superpowers/specs/2026-10-21-health-page-design.md`. When a row is not Healthy, the sections
below are where to look. The same payload from SQL:

```sql
select jsonb_pretty(health_snapshot('1h') -> 'checks');
```

- The charts come from `health_samples`, written once a minute by the `health-sample` job. A gap in
  the charts means that job stopped.
- Sender and inbound rows read "No data" until the workers report in: the sender through
  `record_sender_heartbeat`, the inbound worker through the `inbound-status` function, about once a minute
  each (`select * from worker_heartbeats order by received_at desc limit 10;`).
- Disk percent is measured against `health_disk_limit_bytes()` (8 GB). Postgres can't see the
  plan's disk; when the disk grows, change that function in a new migration.
- A function-calling job's result is its HTTP status: `cron_call_function` logs each request in
  `cron_http_requests`, and the sampler copies the status from `net._http_response`.

Hosted, once: `supabase db push`, then `supabase functions deploy health` and
`supabase functions deploy inbound-status`.

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
| `ingest-pota` | every minute | the `ingest-pota` function, through `cron_call_function` (pg_net) |
| `ingest-sotawatch` | every 30 seconds | `ingest-sotawatch` |
| `ingest-wwff` | every minute | `ingest-wwff` |
| `ingest-wwbota` | every minute | `ingest-wwbota` |
| `match-pending-spots` | every minute | `match_pending_spots()`, the safety net behind the call every ingest makes |
| `health-sample` | every minute | `record_health_sample()`, the Health page's history |
| `archive-aprs` | every 5 minutes | the `archive` function for APRS-IS only (`{"sources": ["aprs"]}`) |
| `archive-spots` | every 10 minutes | `archive` for POTA, SOTAwatch, DX Cluster, WWFF, WWBOTA and RBN |
| `rollup-stats-days` | :01 hourly | `refresh_stats_rollups()`: the Stats day rollups (RBN, APRS-IS, countries) and the RBN top stations |
| `refresh-stats-snapshot` | :05 hourly | `refresh_stats_snapshot()`: one snapshot from the rollups as they stand |
| `prune-callsign-lookups` | :15 hourly | `prune_callsign_lookups()` |
| `rollup-callsign-days` | :25 hourly | `backfill_callsign_rollups(2)` |
| `apply-license-loads` | :50 hourly | `apply_license_loads()` |
| `apply-reference-loads` | :55 hourly | `apply_reference_loads()`: swaps a finished POTA, SOTA or WWFF list in; fails while a program's newest load is refused |
| `housekeeping` | 03:00 daily | `run_housekeeping()` |
| `maintain-rbn-spots` | 03:35 daily | `maintain_rbn_spots()` |
| `maintain-aprs-packets` | 03:45 daily | `maintain_aprs_packets()` |
| `import-cty` | 04:20 Mondays | the `import-cty` function |
| `import-iota` | 04:25 on the 1st | the `import-iota` function (the IOTA island list) |

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
2. Did the HTTP calls reach the functions? `cron_http_requests` keeps each job's request
   statuses for 8 days; pg_net keeps the response bodies for a few hours:
   ```sql
   select job, sent_at, status_code, timed_out from cron_http_requests
   order by sent_at desc limit 20;
   select id, status_code, content::text, created
   from net._http_response order by created desc limit 20;
   ```
   A null `status_code` with an error message usually means the Vault secrets are missing or
   wrong. Check they exist (values are secrets; do not paste them anywhere):
   ```sql
   select name, created_at from vault.secrets where name like 'longlines_%';
   ```
   A 401 from the gateway means the key in Vault (`longlines_anon_key`, or
   `longlines_service_role_key` before the cron secret is set) does not match the project; a 403
   from the function means `longlines_cron_secret` does not match the functions'
   `LONGLINES_CRON_SECRET` ("Cron secret" below).
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
spot id over 256). The same item failing again (same source and `raw_payload`) does not add a row:
it bumps that row's `occurrences`, `last_seen_at` and `error`. The daily housekeeping job deletes rows
not seen for 30 days.

```sql
select id, source, occurred_at, last_seen_at, occurrences, error, raw_payload
from ingest_failures order by last_seen_at desc limit 20;

-- Which errors are most common?
select source, error, count(*) as items, sum(occurrences) as occurrences from ingest_failures
where last_seen_at > now() - interval '1 day'
group by 1, 2 order by 4 desc;
```

## Temporarily disable a source

```sql
select cron.alter_job(job_id := jobid, active := false) from cron.job where jobname = 'ingest-pota';
-- later
select cron.alter_job(job_id := jobid, active := true) from cron.job where jobname = 'ingest-pota';
```

The pulled sources' jobs are `ingest-pota`, `ingest-sotawatch`, `ingest-wwff` and `ingest-wwbota`.
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

- Site URL: `https://longlines.io`
- Redirect URLs: `https://longlines.io`, `https://longlines.io/set-password`
  (add `http://localhost:5173` and `http://localhost:5173/set-password` for local
  development against the hosted project)

Authentication → Providers → Email: enable "Confirm email". Leave signups on.

Authentication → Providers → Google: enable it with the Google OAuth client's id
and secret. In Google Cloud, the client's authorized redirect URI is the project's
`https://<project-ref>.supabase.co/auth/v1/callback`. Google's sign-in comes back
to the site root (`redirectTo` is the origin), which the redirect URLs above
already allow. A new Google account has no callsign, so it has no profile until
the web's "Finish creating your account" screen calls `complete_profile`; an
existing account whose email matches is linked to it by Auth and keeps its own.

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

The identifier is the email as typed, trimmed and lowercased; a callsign is refused before it is
counted, since accounts may share one. A wrong password
is answered no sooner than 300 ms after the request arrived (`FAILED_SIGN_IN_FLOOR_MS`), so response
time does not show whether an email has an account.

Supabase Auth has its own per-IP limit on password sign-ins, but every check comes from the
`sign-in` function, so Auth sees the function's address for every visitor and its budget is shared
site-wide. `supabase/config.toml` raises `[auth.rate_limit] sign_in_sign_ups` to 3000 per 5 minutes
for the local stack. **Operator step:** raise the hosted project's limit the same way (Dashboard,
Authentication, Rate Limits, sign-ups and sign-ins), well above expected site-wide traffic; otherwise
about 30 wrong passwords from anywhere make every sign-in answer "too many attempts" until the window
resets. `begin_sign_in_attempt` stays the real per-client policy.

## Database tests

`supabase/tests/*.test.sql` are pgTAP suites that run against a fresh local
database (`supabase db start` or `supabase start`, then `supabase test db`). CI
runs them on every PR. `supabase/tests/helpers/users.psql` seeds two users and
an `as_user(uuid)` helper that switches to the `authenticated` role with that
user's JWT claims, which is how the RLS assertions work.

## Delivery

Outbound delivery (Discord, webhooks, web push, and Local DX cluster spots to Long Lines Relay
through its spots stream) is the sender: a Deno process on Fly.io in
`sender/` (app `longlines-sender`), the way the inbound worker holds the inbound streams. It connects to
Postgres as the `delivery_sender` role through the Supavisor pooler, claims with
`claim_deliveries()` as soon as the matcher's `pg_notify('deliveries', '')` arrives (it LISTENs
on that channel) and otherwise every few seconds, and reports every outcome through its RPC
allowlist. It holds three of the role's four connections: a pool of two and postgres.js's
listener connection. Every decision (what to
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
   else on it, so the inbound worker and any later app cannot be reached from it even if the URL safety
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
   left at the repository root ("Automatic deploys" under "Inbound" below). From then on every merge
   to `main` deploys it.

| Secret | Required | What it is |
| --- | --- | --- |
| `SENDER_DATABASE_URL` | yes | `postgresql://delivery_sender.<ref>:<password>@<pooler host>:5432/postgres`: the session pooler (port 5432, IPv4), TLS required; URL-encode a password with reserved characters. The sender holds no Supabase API key. |
| `LONGLINES_VAPID_PUBLIC_KEY`, `LONGLINES_VAPID_PRIVATE_KEY`, `LONGLINES_VAPID_SUBJECT` | for push | The same pair the Edge Functions hold ("Push notifications" below). Without all three, push deliveries fail with "Push isn't configured on the server." and Discord and webhooks carry on. |
| `SENDER_DATABASE_CA` | no, recommended | The PEM certificate the pooler's certificate must chain to (Supabase's `prod-ca-2021.crt`; "Verifying the database certificate" below). Without it the link is encrypted but the server is not verified, and the sender logs a warning at start. |
| `SENDER_POLL_MS` | no | Pause between claims that found less than a full batch; a notify on the `deliveries` channel ends it early. 5000, floor 1000, at most 3600000. |
| `SENDER_CONCURRENCY` | no | Destinations sent at once within a cycle; 4. |
| `SENDER_STALE_MS` | no | The watchdog: exit 1 after this long without a successful claim; 120000. At most 3600000, and at least 30000 more than the larger of `SENDER_POLL_MS` and the 60000 claim retry (90000 with the default poll), or the sender refuses to start. |
| `SENDER_STATS_MS` | no | How often `/healthz` refreshes its queue figures; 60000, at most 3600000. |
| `SENDER_HEALTH_PORT` | no | 8080, what `sender/fly.toml`'s check expects. |
| `SENDER_STREAM_PORT` | no | 8081, Long Lines Relay's spots stream, what `sender/fly.toml`'s `[http_service]` proxies to ("Spots stream" under "Long Lines Relay"). |

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
fly checks list -a longlines-sender   # /healthz: healthy, last_claim_at, last_progress_at, last_error, in_flight, listening, totals, queue
```

`/healthz` is 200 while the last progress (a successful claim, a finished send or a successful
bookkeeping call; the start before any) is under `SENDER_STALE_MS` old and 503 after, so a long
cycle that is still sending stays healthy. A 503 restarts nothing: Fly restarts the machine only when the process exits, and
the watchdog exits 1 at the same threshold, which is what a wedged pooler connection looks like.
`queue.depth` should stay near zero. `queue.expired_last_hour` counts deliveries that waited past
their age limit (push: the destination's "drop if offline" setting, 30 minutes by default; a Local
DX cluster 2 minutes, which is how it drops spots while its relay is offline; everything else 24
hours) and were dropped undelivered; that is the figure to watch, after taking out Local DX
cluster rows (the "Spots stream" query below counts them).

`listening` is true once the sender's LISTEN on the `deliveries` channel ran; the log says
`listening for deliveries` soon after the start line. While it is false the sender logs
`listen failed: ...; polling only, retrying in N ms` (reported to Sentry once per streak) and
retries with backoff up to a minute; deliveries still go out, only up to `SENDER_POLL_MS` later.
A notify never counts as progress, so it cannot hide a wedged claim from the watchdog.
postgres.js re-subscribes on its own after the listener connection drops and can fail at that
silently, so `listening: true` is not proof the subscription is still up: if matched spots keep
waiting about a poll interval, restart the machine (`fly machine restart -a longlines-sender`).

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
`pg_notify('deliveries', '')` instead (the sender LISTENs on it and polls as the safety net), and the cleanup
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

The claim leaves paused destinations out and drops their queued messages as unwanted, like a
disabled destination's: `dropped_at` stays null, so they are not counted as expired. To hold a
destination and resume its queue later instead, throttle it until a time
(`update destinations set throttled_until = now() + interval '2 hours' where id = '<id>';`); its
messages then wait and expire at the same limits as any other.

### A destination paused itself

A webhook or Discord destination can turn itself off: `enabled = false` with `auto_disabled_at`
set, never `health = 'paused'`. There are two pauses, told apart by `last_error`:

- The count pause (webhooks with `pause_after_failures` set): repeated failures through
  `mark_deliveries_failed`. `last_error` is the last failure's, such as `Webhook HTTP 500`.
- The gone pause (`pause_destination`, migration `20261031000300`): at once, on a reply that says
  the URL is gone for good. `last_error` is `Webhook HTTP 410 (gone)`,
  `Discord HTTP 404 (Unknown Webhook)` or `Discord HTTP 401 (Invalid Webhook Token)`. A webhook
  pauses on a 410 whatever its pause setting says. A gone reply about rows claimed before the URL
  changed pauses nothing.

Either way the claim's unwanted sweep drops the queue with `dropped_at`, and the owner resumes by
turning Enabled on and saving (or `PATCH` with `"enabled": true`), which clears
`auto_disabled_at`. The sender logs a gone pause as `is gone: ...; paused`.

```sql
select name, type, enabled, auto_disabled_at, last_error, last_error_at
from destinations where auto_disabled_at is not null order by auto_disabled_at desc;
```

### A destination is throttled

A 429 from Discord, a webhook or a push service is not a failure. The sender calls
`throttle_destination`, which sets `throttled_until` (the `Retry-After` when there is one, else
60 s doubling to 15 minutes per level) and moves the messages' visibility to match; the claim
skips the destination until then, and each successful cycle after it steps `throttle_level` down
by one. `consecutive_failures` is untouched. The claim also meters each destination per minute
(`destination_budget`: Discord 300 spots, push 3, webhooks 1000, burst equal to the rate except
Discord's 100; a Discord claim takes at most 50, `destination_claim_max`, on average every 10
seconds and never within 5, `destination_claim_interval` scheduling `claim_due_at`),
so a burst is spread over minutes rather than refused.

```sql
select name, type, throttle_level, throttled_until, claim_tokens
from destinations where throttled_until > now();
update destinations set throttled_until = null, throttle_level = 0 where id = '<id>';  -- lift it now
```

### A destination is backed up

Spots wait for a destination when its budget, its claim interval or a throttle holds them back
faster than the matcher queues them, typically a connection that matches far more than the
destination takes. `destination_queue_status` (migration `20261031000400`, service role only)
shows every destination's backlog:

```sql
select name, type, enabled, health, throttled_until, waiting, oldest_waiting_seconds, dropped_24h
from destination_queue_status order by waiting desc limit 20;
```

`waiting` counts pending and failed rows, `oldest_waiting_seconds` is the oldest one's age and
`dropped_24h` counts rows lost (expired or dropped by a pause) in the last 24 hours. The owner
sees a "backed up" banner on the Destinations page once an enabled destination (not paused by an
operator) has at least `destination_backlog_waiting()` (100) rows waiting or one at least
`destination_backlog_age()` (10 minutes) old, and the waiting count on its card. The fixes are the owner's: narrow the
connections that send to it, or press Clear queue (`clear_destination_queue`, also
`POST /v1/destinations/{id}/clear`). Clear drops only the rows whose message is visible now, with
`dropped_at` null (not counted as loss), and leaves rows in flight, in retry backoff or in the
batch a 429 put back; a throttled destination's other rows are cleared. To hold a destination's queue instead of dropping it, set `throttled_until` as in "A
destination keeps failing"; the rows then wait and expire at the usual limits.

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

The local sender also serves the spots stream at `http://127.0.0.1:8081/v2/spots`, where a relay
paired against the local stack connects ("Spots stream" under "Long Lines Relay").

### Push notifications

Push sends are signed with a VAPID keypair held in two places: the sender's Fly secrets (real
deliveries) and Edge Function env (`send-test` and `api`). It is the same pair in both, and in
nothing else: not the web app, the inbound worker or a migration. Without all three values, push deliveries
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
messages older than 7 days, sign-in attempts older than a day, `ingest_failures` not seen for 30 days,
send-test counters, `cron.job_run_details` older than 7 days and `subscription_quiet` rows sent more than an hour ago (the longest quiet window).

### Stats snapshot

Two hourly jobs feed the Stats page. `rollup-stats-days` (one past) runs `refresh_stats_rollups()`:
it rolls up each window day that lacks a rollup (the RBN, APRS-IS and country day tables), rolls up
once more a day it rolled up within an hour of its end (for late rows), and recounts the RBN top
stations when a day changed. That work lands at 00:01 and 01:01 and takes a minute or so; other
runs do nothing. `refresh-stats-snapshot` (five past) runs `refresh_stats_snapshot()`, which counts
today's RBN hours, inserts one `stats_snapshots` row for the last seven complete UTC days from the
rollups as they stand and prunes the table to 48 rows; it never makes a day rollup, so a slow or
failing rollup shows as its own job on /health and the snapshot keeps the last rollups. The Stats page shows the newest row; on a fresh project it shows "Not enough data yet"
until the first run. To refresh by hand:

```sql
select refresh_stats_snapshot_at(now());   -- the rollups, then the snapshot
select generated_at, payload->'totals' from stats_snapshots order by generated_at desc limit 1;
```

`cron.job_run_details` shows failed runs under that job name.

`refresh_stats_rollups()` rolls up at most 3 RBN, 2 APRS-IS and 3 country days a run, oldest
first (`20261029000400`), so after an outage of several days the job catches up a few days an hour
inside its 2-minute statement timeout instead of timing out and rolling back every hour; a whole
missing window clears in four runs. A country day waits for its RBN day. To catch up at once by
hand, outside cron's timeout: `select refresh_stats_rollups_at(now());` (no cap).

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
- Domain: `longlines.io`

`web/vercel.json` rewrites every path to `index.html` so client-side routes
load directly. Nothing else is host-specific; `npm run build` produces a plain
static site in `web/dist`.

After the first deploy, make sure Supabase Auth → URL configuration lists
`https://longlines.io` as the Site URL and includes
`https://longlines.io/set-password` in the redirect URLs, or confirmation
and reset links will not land in the app.

## Documentation site on GitHub Pages

The user documentation site is `docs-site/`, built with Starlight. `.github/workflows/deploy-docs.yml`
(Astro's stock GitHub Pages workflow, plus a `paths` filter) deploys it on every push to main that
changes `docs-site/`: `withastro/action` builds and uploads it, and `actions/deploy-pages`
publishes it. It can also be run by hand from the Actions tab, which is how to redeploy without a
change. `ci.yml`'s `docs` job builds it on PRs that change it and publishes nothing.

Set it up once, in this order, so the first deploy lands on the domain:

1. DNS: `docs.longlines.io CNAME sonyccd.github.io` in `longlines.io`'s zone. If the zone is
   behind Cloudflare, keep the record DNS only until GitHub has issued the certificate.
2. Turn on Pages with source "GitHub Actions" (Settings → Pages), or:

   ```sh
   gh api -X POST repos/sonyccd/longlines/pages -f build_type=workflow
   ```

3. Merge. The first `deploy-docs.yml` run creates the `github-pages` environment and deploys.
4. Set the custom domain and enforce HTTPS (Settings → Pages), or:

   ```sh
   gh api -X PUT repos/sonyccd/longlines/pages -f cname=docs.longlines.io -F https_enforced=true
   ```

   HTTPS can be enforced only once GitHub has issued the certificate.
5. Verify `longlines.io` as a Pages domain for the account (account Settings → Pages), so no one
   else can claim a subdomain of it.

`docs-site/public/CNAME` holds `docs.longlines.io`, but for an Actions deploy the Pages setting in
step 4 is what binds the domain. Check it with `curl -I https://docs.longlines.io` (200).

## Sentry

Four projects in the `long-lines` org (https://long-lines.sentry.io), one per runtime, each with
its own DSN (Settings → Projects → the project → Client Keys). Every one is off until its DSN is
set, so local development, tests and CI send nothing.

| Project | Runtime | DSN set as |
| --- | --- | --- |
| `longlines-web` | web app (Vercel) | `SENTRY_DSN`, from Sentry's Vercel integration, which also sets `SENTRY_AUTH_TOKEN` for the source map upload |
| `longlines-functions` | Edge Functions | `supabase secrets set SENTRY_DSN=<dsn>` |
| `longlines-inbound` | inbound worker | `fly secrets set -a longlines-inbound SENTRY_DSN=<dsn>` |
| `longlines-sender` | sender | `fly secrets set -a longlines-sender SENTRY_DSN=<dsn>` |

`SENTRY_ENVIRONMENT` is optional everywhere (production when unset). The workers' release is
Fly's `FLY_IMAGE_REF`, so an issue names the image it came from; the Edge Functions have no
release. Setting a Supabase secret takes effect without a redeploy; `fly secrets set` restarts
the machine. The Deno side reports errors only (`_shared/sentry.ts`), with no traces.

Sentry's "Prevent Storing of IP Addresses" (Organization Settings → Security & Privacy) should
be on: without it Sentry stores the sending server's address, or, for the web app, a visitor's.

## Regenerating database types

Whenever a migration changes a table, view or RPC the app uses:

```sh
supabase start   # or db start
supabase gen types typescript --local > web/src/lib/database.types.ts
```

The generated file is committed; CI type-checks the app against it.

# Inbound (RBN, DX Cluster, APRS-IS)

The inbound worker in `inbound/` runs on Fly.io as app `longlines-inbound`. It holds one session per feed:
RBN (`ingest-rbn`), DX Cluster (`ingest-dxcluster`) and, once `APRS_LOGIN_CALL` is set, APRS-IS
(`ingest-aprs`). Design notes are in `docs/ARCHITECTURE.md`
("Streaming sources: the inbound worker").

## First deploy

```sh
# 1. Database and function (Supabase side)
supabase db push                                   # adds the rbn source, watchlist RPC, matcher guard
openssl rand -hex 32                               # the inbound secret; use it in both places below
supabase secrets set LONGLINES_INBOUND_SECRET=<secret>
supabase functions deploy ingest-rbn

# 2. Inbound (Fly side), from the repository root
fly apps create longlines-inbound                    # name must match app in inbound/fly.toml
fly secrets set \
  LONGLINES_FUNCTIONS_URL=https://<project-ref>.supabase.co/functions/v1 \
  LONGLINES_INBOUND_SECRET=<secret> \
  INBOUND_LOGIN_CALL=<callsign>
fly deploy --config inbound/fly.toml --ha=false      # --ha=false: one machine, not two
fly scale count 1                                  # exactly one machine: one telnet session
```

## Cutover from `longlines-relay` (2026-10-28)

The worker was called the relay until 2026-10-28 (`relay/`, app `longlines-relay`, secret
`LONGLINES_RELAY_SECRET`, header `x-relay-secret`, function `relay-status`, RPC
`record_relay_heartbeat`). The rename ships in one PR; the hosted side is by hand, in this order,
because the renamed functions refuse the old header the moment they deploy:

```sh
# 1. Database: worker_heartbeats rows become 'inbound', record_inbound_heartbeat replaces
#    record_relay_heartbeat, health_snapshot's check is `inbound`. The old relay's heartbeat
#    fails from here until step 4; nothing else notices.
supabase db push
supabase functions deploy health            # reads the new payload keys (web deploy follows)

# 2. A fresh secret under the new name, on both sides. Fly and Supabase secrets are
#    write-only and neither can be renamed, so the old value is not copied; both sides
#    are redeployed below, so it need not be. Fly stages secrets for an app with no
#    machines yet.
openssl rand -hex 32
supabase secrets set LONGLINES_INBOUND_SECRET=<new secret>
fly apps create longlines-inbound
fly secrets set -a longlines-inbound \
  LONGLINES_FUNCTIONS_URL=https://<project-ref>.supabase.co/functions/v1 \
  LONGLINES_INBOUND_SECRET=<new secret> \
  INBOUND_LOGIN_CALL=<callsign> \
  APRS_LOGIN_CALL=<call-SSID>               # plus DXCLUSTER_HOST/PORT, INBOUND_LICENSES, INBOUND_CATALOGS if the relay set them

# 3. Stop the old worker, then deploy the functions that check the header and the new worker.
#    Between these two the streams are down (about a minute); RBN and DX Cluster lines in
#    that gap are not stored, which is the same as any redeploy.
fly scale count 0 -a longlines-relay
for f in ingest-rbn ingest-dxcluster ingest-aprs load-licenses load-references inbound-status; do
  supabase functions deploy $f
done
fly deploy --config inbound/fly.toml --ha=false
fly scale count 1 -a longlines-inbound

# 4. Retire the old names once `fly logs -a longlines-inbound` shows "connected to" and
#    /health's Inbound feeds check is Healthy.
supabase functions delete relay-status
supabase secrets unset LONGLINES_RELAY_SECRET
fly apps destroy longlines-relay
```

Then, in the Fly dashboard, move the GitHub integration binding from `longlines-relay` to
`longlines-inbound` with "Config path" `inbound/fly.toml` (see "Automatic deploys"); until that is
done a merge to `main` deploys only the sender. `web/` carries the Health page's new keys, so
deploy the web app (Vercel, on merge) with or after step 1; the old page shows "No data" for the
inbound check until then.

## Automatic deploys

Deploys on merge to `main` come from Fly's GitHub integration, set up in the Fly dashboard rather
than in this repo. Each Fly app has its own binding: "Config path" is `inbound/fly.toml` for
`longlines-inbound` and `sender/fly.toml` for `longlines-sender`, and the working directory is left
blank (the repository root) on both, because each Dockerfile copies
`supabase/functions/_shared` from the context. flyctl resolves `[build] dockerfile` relative to
the config file, so each `fly.toml` names just `Dockerfile`. Both apps deploy on every push to
`main`, whichever folder changed.

When the integration was first connected, Fly's launcher opened a PR (#30) with its own generic
`fly.toml`, `Dockerfile` and `example.ts`. That config ran a nonexistent `main.ts` as root, added a
public HTTP service that auto-stops idle machines, and created two machines. Do not merge such a
PR again; `inbound/fly.toml` is the inbound worker's real config.

Two things to know about it:

- It is not gated on CI. A merge to `main` deploys whether or not the PR's checks passed, so keep
  `main` protected by the CI checks.
- Every deploy restarts the machine and opens a new session to RBN. If the integration deploys on
  every push rather than only when `inbound/` or `supabase/functions/_shared/*.ts` change, that is
  one reconnect per merge.

It deploys only the two Fly apps. Migrations (`supabase db push`) and the Edge Functions
(`supabase functions deploy ingest-rbn`) are still applied by hand; do those first when a change
needs both sides ("A change that spans both sides" under "Delivery" has the order for the sender).
After the first deploy, check `fly scale show` reports one machine.

A deploy restarts the machine; the inbound worker pushes what it has buffered before exiting.

## Is it running?

```sh
fly logs                                  # "connected to ...", stats every 10 min
fly checks list                           # /healthz: per-feed connected, last_data_at, dropped, pushed
```

```sql
select * from ingest_health where source = 'rbn';
select count(*) from rbn_spots where spot_time > now() - interval '1 hour';  -- tens of thousands when RBN is busy
```

`last_success_at` should never be more than about a minute old: the inbound worker pushes a heartbeat
every 60 seconds even when no watched station was heard. `spots_last_hour` is zero unless a
watched station was on the air.

## Why is a watched station not showing up?

1. `select * from watched_among('rbn', array['W1AW/4']);` must return it, with the call as RBN
   reports it. Only enabled subscriptions whose sources are empty or include RBN contribute.
   Changes apply to the next batch.
2. A subscription callsign matches the reported call exactly or by base call: `W1AW` catches
   `W1AW/4`, but `W1AW/P` catches only `W1AW/P`.
3. RBN hears CW and RTTY on port 7000 only. FT8/FT4 is not connected.
4. Check `ingest_failures where source = 'rbn'` and the inbound worker logs for `push failed`.
5. Check `rbn_spots` for the call: if it is there but not in `raw_spots`, the subscription does not
   watch it; if it is not there, RBN did not hear it.

## rbn_spots size

About 1.5 million rows and 350 MB a day; seven days (2.5-3 GB) stay in the database. A day is
retired once the callsign rollups have recorded it (`callsign_rollup_days`, normally at 02:25 UTC the next day)
or once it is 14 days old; a day retired at 14 days without its rollup gets a `callsign_rollup_failures`
row and shows as `rbn_retired` in `callsign_rollup_status` ("Callsign rollups" below).
`select pg_size_pretty(pg_total_relation_size('rbn_spots'));` shows the total;
`select tableoid::regclass, count(*) from rbn_spots group by 1 order by 1;` shows rows per day.
A line more than seven days late lands in the default partition. If its day was already retired,
retention deletes it the next night (warning `rbn retention: <day> was retired; deleting its late
rows`), keeps the day's archive as it is and records nothing; APRS-IS does the same. The rollups
still see the day as retired meanwhile (`rbn_day_retired`: some slice of the day is logged with
more rows than the database holds), so a late line never lets a retired day be rolled up as whole.

## Cron secret

pg_cron reaches the cron-called functions (`ingest-pota`, `ingest-sotawatch`, `ingest-wwff`,
`ingest-wwbota`, `archive`, `import-cty`, `import-iota`) through `cron_call_function`, which
queues the request in pg_net's `net.http_request_queue`. Every database role can read that table
(a PUBLIC grant on `supabase_admin`'s table that `postgres` cannot revoke), the sender's
`delivery_sender` included, so since `20261029000500` the request carries the public anon key as
its bearer (for the gateway's `verify_jwt`) and the cron secret in `x-cron-secret`, never the
service-role key. Until Vault holds both `longlines_anon_key` and `longlines_cron_secret`,
`cron_call_function` keeps sending the service-role key as before, so the migration can be pushed
first. Rollout, in this order:

1. Pick a secret (`openssl rand -hex 32`), set it on the functions and deploy the seven of them
   (they accept the header from this deploy on, and the service-role key as before):
   ```sh
   supabase secrets set LONGLINES_CRON_SECRET=<secret>
   for f in ingest-pota ingest-sotawatch ingest-wwff ingest-wwbota archive import-cty import-iota; do
     supabase functions deploy "$f"
   done
   ```
2. Create the two Vault secrets (`scripts/setup-db-settings.sql` has them; run only those two
   statements on a project that already has the others). `longlines_anon_key` is the legacy anon
   JWT (Project Settings, API keys, legacy keys), not the `sb_publishable_` key, which is not a JWT
   and would not pass `verify_jwt`.
3. `supabase db push`, if `20261029000500` is not hosted yet. Check that the next runs succeed
   (`cron_http_requests`, /health) and that a queued request has no service-role key:
   `select headers->>'Authorization' like 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_anon_key') from net.http_request_queue limit 1;`
4. Optionally delete `longlines_service_role_key` from Vault: once both new secrets exist only
   the fallback in `cron_call_function` reads it, and nothing else in the database does. Keep it
   if you may need the fallback (deleting either new secret would then break cron).

To rotate, set the new value on both sides; runs in between get 403 and the next ones recover:
`supabase secrets set LONGLINES_CRON_SECRET=<new>`, then
`select vault.update_secret(id, '<new>') from vault.secrets where name = 'longlines_cron_secret';`.

## Rotating the inbound secret

Set the new value on both sides; spots buffered in between are retried and kept.

```sh
supabase secrets set LONGLINES_INBOUND_SECRET=<new>
fly secrets set LONGLINES_INBOUND_SECRET=<new>
```

## Local run

With `supabase start` and `supabase functions serve --env-file <file with LONGLINES_INBOUND_SECRET>`:

```sh
LONGLINES_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 \
LONGLINES_INBOUND_SECRET=<same value> INBOUND_LOGIN_CALL=<callsign> \
deno run --allow-net --allow-env inbound/main.ts
```

This opens real connections to RBN and the DX Cluster node (and APRS-IS if `APRS_LOGIN_CALL` is
set); stop it when done. In Docker, use
`http://host.docker.internal:54321/functions/v1`.

## DX Cluster

The second feed. It logs in to a DXSpider node with `INBOUND_LOGIN_CALL` and forwards every human
spot line; skimmer lines a node relays are dropped. The default node is G1FEF-2,
`dxc.hamserve.uk:7300`, which gives read access without registration. To use another node:

```sh
fly secrets set DXCLUSTER_HOST=dxc.nc7j.com DXCLUSTER_PORT=7373   # restarts the machine
fly secrets unset DXCLUSTER_HOST DXCLUSTER_PORT                    # back to the default
```

First deploy, in this order: the migration (`supabase db push`, `20261012000020_dxcluster_source`),
then `supabase functions deploy ingest-dxcluster` (the Supabase GitHub integration does not deploy
a new function), then the inbound worker. The inbound worker uses the existing `LONGLINES_INBOUND_SECRET`. If the
inbound goes first, its pushes fail with 404 until the function exists; the forwarder keeps the
lines and retries, so nothing is lost unless that lasts for hours.

Is it running?

```sql
select * from ingest_health where source = 'dxcluster';
select spot_time, spotter, callsign, frequency_khz, mode, comment
from raw_spots where source = 'dxcluster' order by spot_time desc limit 20;
```

`last_success_at` advances every minute (the heartbeat). `spots_last_hour` is usually in the
hundreds. Human spots can pause overnight, so the inbound worker waits 15 minutes without data before it
reconnects, and `/healthz` marks the feed unhealthy after 20.

A subscription receives DX Cluster spots only when its sources list DX Cluster; "any source" does
not include it. If a DX spot is missing, check the subscription's sources first, then
`ingest_failures where source = 'dxcluster'`, then the inbound worker logs (`[dxcluster]`).

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
`20261014000010_aprs_source` and Fly redeploys the inbound worker with the feed still off), then
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

`spots_last_hour` here counts packets: expect a few hundred thousand. The inbound worker's ten-minute stats
log (`[aprs] ... lines, ... spots, ... pushed, ... buffered, ... dropped`) gives the rate as the inbound worker
sees it; `dropped` above 0 means Supabase was unreachable for longer than the buffer. APRS-IS sends
a keepalive about every 20 s, so the inbound worker reconnects after 2 minutes of silence and `/healthz`
marks the feed unhealthy after 5.

Size: about 300 bytes a packet with indexes, so roughly 2.5 GB a day at 100 packets a second. The
database keeps yesterday and today; the B2 archive grows by roughly 0.3 GB a day (measured as gzipped
NDJSON; not yet re-measured since the archive moved to Parquet).

```sql
select pg_size_pretty(sum(pg_total_relation_size(i.inhrelid)))
from pg_inherits i where i.inhparent = 'public.aprs_packets'::regclass;
```

### APRS-IS connections

Since `20261031000100`, a connection can list APRS-IS (`aprs`). As with RBN, only the stations a
live connection names (`watched_among('aprs', ...)`) go on from `ingest-aprs` into `raw_spots` and
the matcher, and only their position, Mic-E, object and item packets, at most one spot per station
per 15 minutes. "Any source" never includes APRS-IS, and a connection on APRS-IS alone needs a
callsign or callsign group rule. The spot has no frequency, band, mode or reference, so those
rules' `is`, `contains`, `gt` and `lt` forms never pass it and their `is_not` and `not_contains`
forms always do (only callsign and group rules tell APRS-IS spots apart), and it never goes to a
Local DX cluster.

Shipping it: merge (the integration applies the migration; Fly redeploys the sender, which reads a
null frequency), then `supabase functions deploy ingest-aprs api send-test`. Afterwards watch
`ingest-aprs`'s run time on `/health` for a day: each batch now adds a `watched_among`,
`ingest_spots` and `match_pending_spots` call.

If an APRS-IS alert is missing:

```sql
-- is the station watched? (an enabled connection with a destination, sources listing aprs)
select * from watched_among('aprs', array['<CALL>']);
-- did a spot land? one row per 15-minute window
select spot_time, callsign, spotter, comment from raw_spots
where source = 'aprs' and base_callsign = base_callsign('<CALL>')
order by spot_time desc limit 10;
-- what did the station send? only position, mic_e, object and item become spots
select received_at, packet_type, line from aprs_packets
where source_call = '<CALL>' and received_at > now() - interval '1 hour' order by received_at desc;
```

# WWFF

World Wide Flora & Fauna spots, polled from `https://spots.wwff.co/static/spots.json` by the
`ingest-wwff` function. The `ingest-wwff` cron job calls it every minute (the feed is served with
`max-age=60`), and spots land in `raw_spots` like POTA's, with the reference in `wwff_reference`
and its name in `wwff_reference_name`. There is no inbound side.

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

# WWBOTA

Worldwide Bunkers on the Air spots, polled from `https://api.wwbota.net/spots/` (the last hour)
by the `ingest-wwbota` function every minute. Spots land in `raw_spots` like WWFF's, with every
bunker the spot names in `wwbota_references` and the first bunker's name in
`wwbota_reference_name`. There is no inbound side.

First deploy, in this order: merge (the Supabase GitHub integration applies
`20261026001000_wwbota_source`; the cron job then calls `ingest-wwbota`, which answers 404 until
the next step), then deploy the new function and redeploy every function, since `_shared` changed
(`Source`, `NormalizedSpot`, the archive columns, the delivery spot shape):

```sh
supabase functions deploy ingest-wwbota
supabase functions deploy archive    # wwbota in the run order, two new Parquet columns
supabase functions deploy api send-test convert-archive   # the delivery spot shape
```

Between the merge and the first deploy every `ingest-wwbota` run answers 404, so `/health` shows
"A scheduled job keeps failing" for that job and "No success yet from WWBOTA" under pulled sources.
Both clear within a few minutes of the deploy; deploy right after the merge.

Is it running?

```sql
select * from ingest_health where source = 'wwbota';
select spot_time, callsign, wwbota_references, wwbota_reference_name, frequency_khz, mode, comment
from raw_spots where source = 'wwbota' order by spot_time desc limit 20;
select * from archive_status where source = 'wwbota';
```

`last_success_at` advances every minute. The feed is small (about 30 spots a day across Europe,
most of them edited to `QRT` afterwards), so hours with no spot are normal. WWBOTA flips an
activator's spots to QRT after the fact; `type` is not in the content hash, so that edit does not
store the spot again, while an edited comment or frequency does. A QRT spot with no frequency is
skipped (`not_normal`), as is a `Test` spot. To pause it, turn the cron job off as for the other
pulled sources (`jobname = 'ingest-wwbota'`); `npm run invoke:wwbota` runs it once against the
local stack.

A connection receives WWBOTA spots only when its sources list WWBOTA; "any source" does not
include it, as with DX Cluster and WWFF, because bunker activations are often POTA or WWFF
activations too. A "Park, summit, or location contains" rule matches any bunker of an n-fer. If a
spot is missing, check the connection's sources first, then
`ingest_failures where source = 'wwbota'` (a spot that names no bunker is recorded there).
Profiles credit an n-fer to its first bunker only.

# Logged contacts

Contacts operators log, posted by Long Lines Relay through the `relay-api` function ("Long
Lines Relay" below) into `raw_spots` with source `logged`, through `apply_logged_contacts`. There is no cron job
and no inbound side, and they are not on `/health`: a quiet day is normal.

First deploy: merge (the Supabase GitHub integration applies `20261028000300_logged_contacts_source`),
then redeploy every function that bundles the changed `_shared` code (`Source`, the archive
columns and run order, the delivery labels):

```sh
supabase functions deploy archive    # logged in the run order, its Parquet files gain retracted_at
supabase functions deploy api send-test convert-archive
```

Is it working?

```sql
select * from ingest_health where source = 'logged';
select spot_time, spotter, callsign, frequency_khz, mode, retracted_at
from raw_spots where source = 'logged' order by spot_time desc limit 20;
select state, count(*) from logged_contacts group by state;
select * from archive_status where source = 'logged';
```

`last_success_at` is the last request applied, not a poll. A row with `retracted_at` set was
edited or deleted in the logger: it stays in `raw_spots` and the archive, and every reader leaves
it out. A spot sent before its retraction is not recalled. The archive writes a slice two hours
after it ends, so a contact deleted later is in the file with `retracted_at` null; `raw_spots`
has the truth. To take one contact down by hand, set `retracted_at` on its spot, and `state = 'retracted'`
with `retracted_at` on its `logged_contacts` row (a check keeps the two columns in step).

A connection receives logged contacts only when its sources list Logged contacts. If one is
missing, check the connection's sources, then the account's callsign: an upsert whose mycall is
another station's is rejected (`mycall_mismatch`) and stored nowhere. So is one from an account
sharing its base call with an account that has held it longer: compare `callsign_since` on the
profiles whose `base_callsign(callsign)` matches.

# Long Lines Relay

The desktop app (`sonyccd/longlines-relay`) signs in by pairing and posts logged contacts through
the `relay-api` function, at `https://api.longlines.io/relay/<version>/<path>` (Vercel rewrites in
`web/vercel.json`, one each for `v1` and `v2`, host `api.longlines.io`, ahead of the management
API's `/v1` rule). The wire contract is that repository's `docs/contract.md`; it wins on wire
details. Both versions are served side by side and v1 answers exactly as it did in phase 1: a
v1 pairing grants `contacts:write` alone, and v1 `me` answers callsign and email only. v2
`device/start` also takes `scopes` (one or both of `contacts:write` and `spots:read`; both when
absent) and `platform` (`windows`, `macos` or `linux`, required), and v2 `me` adds `relay_id`,
`device_name`, `scopes` and `spots_url` ("Spots stream" below). `device/token` and `contacts`
are the same on both. `GET /v1/spots` and `/v2/spots` are 404 here: the stream is the sender's. Pairing: the relay calls `device/start`, opens
`https://longlines.io/relay/approve?code=XXXX-XXXX` (`verification_uri_complete`), and shows
`longlines.io/relay` (`verification_uri`, which redirects there) for a code typed by hand; the signed-in user selects Allow, and the relay's `device/token` poll gets its token once.
Tokens are listed and revoked on the API tokens page ("Long Lines Relay" card).

First deploy: merge (the Supabase GitHub integration applies `20261028000400_relay_pairing`), then
deploy the new function by hand (the integration does not deploy a new function), then the web
(the Vercel rewrite and `/relay/approve` ship with it):

```sh
supabase functions deploy relay-api
curl -s -X POST https://api.longlines.io/relay/v1/device/start \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"Long Lines Relay","client_version":"0.0.0","device_name":"deploy check"}'
# 200 with a device_code and a user_code; the pairing expires unused in 10 minutes
```

v2 (`20261028000500` pushed, `relay-api` redeployed and the web deployed with the `/relay/v2`
rewrite) is checked the same way:

```sh
curl -s -X POST https://api.longlines.io/relay/v2/device/start \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"Long Lines Relay","client_version":"0.0.0","device_name":"deploy check","platform":"linux"}'
# 200 as on v1; a 404 not_found means the web deploy without the v2 rewrite is still live
```

`relay-api` keeps `verify_jwt = false` (the relay sends a relay token, never a JWT) and reads
`SUPABASE_SERVICE_ROLE_KEY` (the per-client limit's HMAC key) and `LONGLINES_CLIENT_IP_HEADER`
like `callsign-profile`, plus `LONGLINES_SPOTS_URL`, v2 `me`'s `spots_url`. Unset, it is
`http://127.0.0.1:8081/v2/spots` (the local sender); set, it must be `https`, or `http` on a
loopback host, or v2 `me` answers 500 (logged as `LONGLINES_SPOTS_URL is not an https or
loopback http URL`) while v1 keeps working. Limits, shared by both versions: `device/start` 5 a minute per client address, `device/token` 60
per client address, `me` and `contacts` 120 requests a minute per token (all in
`lookup_rate_limits`, apart from profile lookups), and 120 contacts a minute per token
(`relay_contacts_per_minute()`). The authenticated routes are never limited per address: through
the Vercel rewrite every relay can arrive from the same proxy address. The pairing routes still
are, so through the rewrite pairings can share one address's budget. Check it once after the
first deploy: send the `device/start` above six times from one network, then once from another (a
phone off Wi-Fi). A 429 on the other network means the function sees the rewrite's address, not the
relay's, so five sign-ins a minute is everyone's budget and anyone can use it up. Fixing that
(reaching the function without the rewrite, or a proxy that passes the address in a way a direct
caller cannot forge) is still an open decision.

Is it working?

```sql
select status, count(*) from relay_pairings group by status;
select device_name, platform, scopes, client_version, created_at, last_used_at
from relay_tokens order by created_at desc;
```

Pairings are pruned a day after they start, by the hourly `prune-callsign-lookups` job. A relay
that keeps getting `bad_token` was revoked (or its account deleted); it signs out on its own. To
revoke a relay by hand, delete its `relay_tokens` row. An account holds at most 10 relays
(`relay_tokens_max()`), counting approvals not yet claimed.

## Spots stream

A Local DX cluster destination sends its spots to one paired relay, which serves them to the
user's logging software as a DX cluster. The sender holds the relays' streams: `GET /v2/spots`
(contract section 9) on port 8081 (`SENDER_STREAM_PORT`), a Server-Sent Events response per relay
token with `spots:read`, which only a v2 pairing grants. It is not behind the `api.longlines.io`
rewrite (Vercel cannot carry a stream); `GET /v2/me` hands the relay its address as `spots_url`
(`LONGLINES_SPOTS_URL` on the Edge Functions).

While a relay's stream is open the sender has set `relay_tokens.cluster_connected_at`
(`set_cluster_stream`), and `claim_deliveries` takes that relay's Local DX cluster rows; it
clears it when the stream closes and marks every relay offline (`reset_cluster_streams`) at start
and on shutdown. A relay that is offline gets nothing claimed: its rows age out after 2 minutes
(`destination_max_age('local_cluster')`) through the expiry sweep, as `dropped_at`, and are never
failures. A stream that closes between a claim and its write leaves the rows unattempted; they
wait out the 60 s visibility timeout. A relay takes at most 120 spots a minute across every
destination that targets it (`local_cluster_relay_cap()`). At most four streams connect at once
(`MAX_HANDSHAKES` in `sender/cluster_stream.ts`): the stream is public and shares the sender's
two-connection pool with the claim, so a flood of connection attempts gets 503 before any token
lookup, and a relay retries with its backoff.

First deploy, once the sender with the stream is deployed (merge) and `20261028000500` and
`20261028000600` are pushed:

```sh
fly ips list -a longlines-sender                  # an app created without services has none
fly ips allocate-v4 --shared -a longlines-sender  # shared IPv4 is free and enough behind TLS (SNI)
fly ips allocate-v6 -a longlines-sender
# DNS: spots.longlines.io CNAME longlines-sender.fly.dev
fly certs add spots.longlines.io -a longlines-sender
fly certs show spots.longlines.io -a longlines-sender   # wait for "Issued"
supabase secrets set LONGLINES_SPOTS_URL=https://spots.longlines.io/v2/spots
supabase functions deploy relay-api
```

The `[http_service]` in `sender/fly.toml` has `auto_stop_machines = false` and
`min_machines_running = 1`: the machine's real work (claiming and sending) arrives through no
request, so Fly must never stop it for lack of traffic, and `fly scale count 1` still holds.

Check it (a token without `spots:read` gets 403 `insufficient_scope`, none 401 `bad_token`):

```sh
curl -sN https://spots.longlines.io/v2/spots -H "Authorization: Bearer $RELAY_TOKEN"
# event: hello / data: {"relay_id":"...","device_name":"..."}, then ": keepalive" every 20 s
```

```sql
select device_name, platform, scopes, cluster_connected_at from relay_tokens
where cluster_connected_at is not null;                      -- relays online now
select d.name, d.type, count(*) filter (where dl.status = 'sent') as sent,
       count(*) filter (where dl.dropped_at is not null) as dropped
from deliveries dl join destinations d on d.id = dl.destination_id
where d.type = 'local_cluster' and dl.created_at > now() - interval '1 hour'
group by 1, 2;
```

`fly logs -a longlines-sender` has a line per relay that connects, reconnects (a second stream
for one token replaces the first) and disconnects, by relay id; tokens are never logged. Local:
`npm run sender` (in `web/`) serves it at `http://127.0.0.1:8081/v2/spots`.

# IOTA

IOTA references are read out of DX Cluster comments (`raw_spots.iota_reference`), and the island
names come from iota-world.org's `groups.json`, which `import-iota` loads into `iota_groups` on the
1st of each month. There is no feed to watch; DX Cluster's health is IOTA's.

First deploy, after the merge applies `20261027001000_iota`: deploy the new function, redeploy the
ones whose shared code changed, and load the list once (spots stored before then keep no name):

```sh
supabase functions deploy import-iota
supabase functions deploy ingest-dxcluster archive api send-test convert-archive
curl -X POST "$SUPABASE_URL/functions/v1/import-iota" -H "Authorization: Bearer <service-role JWT>"
```

Is it working?

```sql
select * from iota_load;                       -- loaded_at, groups (about 1,200)
select spot_time, callsign, iota_reference, iota_reference_name, comment
from raw_spots where source = 'dxcluster' and iota_reference is not null order by spot_time desc limit 20;
```

A failed import answers 500 with its reason (`/health` shows the job failing) and leaves the list
as it was. A connection gets island spots only when it lists DX Cluster; the IOTA island rule
(`island`) narrows it to references or continents.

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

## Converting the NDJSON slices to Parquet (one-off)

Slices archived before 2026-10-14 are gzipped NDJSON at `<source>/YYYY/MM/DD/HHMM.ndjson.gz`.
The `convert-archive` function (issue #174) rewrites each as Parquet at its live path, so the
bucket holds one dataset. Start only once Parquet is deployed and "Is it keeping up?" (below) is
clean. For each slice, oldest first, it reads the object, checks the decoded row count against
`archive_log.row_count`, uploads the Parquet the live archive would write, checks its size with a
HEAD, repoints the log row (`archive_repoint_slice`: path and bytes, only while the row still names
that NDJSON object with that count), and only then deletes the NDJSON object. A failure at any step
before the repoint leaves the slice as it was. For RBN and APRS-IS days retention has retired, the
NDJSON object is the only copy, so never delete one by hand before its row points at Parquet.

Before the first run:

1. **The key.** The `archive` function's key has `writeFiles` only. Reading and deleting also need
   `readFiles` and `deleteFiles` (a HEAD counts as a read). Either create a temporary key and point
   the five `LONGLINES_ARCHIVE_S3_*` secrets at it for the duration, or check what the current key
   allows; B2 shows a key's capabilities with `b2 key list --long`:
   ```sh
   b2 key create --bucket <bucket> longlines-archive-convert listFiles,readFiles,writeFiles,deleteFiles
   supabase secrets set LONGLINES_ARCHIVE_S3_ACCESS_KEY_ID=<keyID> \
     LONGLINES_ARCHIVE_S3_SECRET_ACCESS_KEY=<applicationKey>
   ```
   The secrets are shared with `archive`, which keeps working with the wider key. Put the
   `writeFiles`-only key back afterwards and delete the temporary one.
2. **Versions.** A B2 bucket keeps all versions by default, so an S3 delete only hides the NDJSON
   object and its bytes stay billed. That is a safety net while converting; once done, a lifecycle
   rule (or `b2 rm --versions`) removes hidden versions if the space matters.
3. **Deploy.** `supabase db push` (migration `20261021000700`), then
   `supabase functions deploy convert-archive` (a new function, so the GitHub integration skips it).

Run it by hand with the service-role JWT (no cron job calls it). A batch is 10 slices by default
(`{"limit": n}`, at most 100) and stops early once it has read 60,000 rows, which keeps a run
inside the function's CPU budget:

```sh
curl -sX POST "$SUPABASE_URL/functions/v1/convert-archive" \
  -H "Authorization: Bearer <service-role JWT>" -H "Content-Type: application/json" \
  -d '{"limit": 1}'      # try one slice first, then larger batches
```

The answer says how many slices it `converted` and lists any `failed` slices with the reason
(`row count mismatch`, `NDJSON object missing`, an S3 error); it answers 500 when any failed.
Converted slices are not listed again, so the same call simply continues. A failed slice heads
every batch until it is dealt with; to step past it, send the answer's `next` as the cursor
(`-d '{"after": {"slice_start": "...", "source": "rbn"}}'`) and keep passing each answer's `next`
until it is null. A run without `after` retries the failures. `undeleted` lists NDJSON objects
whose slice was converted and logged but whose delete failed; those are leftovers, safe to delete
by hand. Progress:

```sql
select source, count(*), sum(row_count) from archive_log
where object_path like '%.ndjson.gz' group by 1;   -- what is left
```

A mismatched slice keeps its NDJSON object and log row. If its rows are still in the database,
"Re-archive a slice" (below) rewrites it as Parquet from the database; delete the old object by hand
afterwards. If they are not, the NDJSON object is the only copy: leave it, and note it.

When the query above returns nothing (mismatches aside), remove the tool: delete the function
(`supabase functions delete convert-archive`), its directory, `_shared/archive_convert.ts`, its
handler and tests and its `config.toml` entry, and add a migration dropping
`archive_ndjson_slices` and `archive_repoint_slice`. Then drop the NDJSON notes from "Reading the
archive", "Re-archive a slice" and "Rebuilding a day from the archive" here and from
`docs/ARCHITECTURE.md`, and restore the `writeFiles`-only key.

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
deleted by hand (`convert-archive` no longer sees it, since the log row now names the Parquet object).

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

Slices archived before 2026-10-14 are still gzipped NDJSON in the old layout until
`convert-archive` ("Converting the NDJSON slices to Parquet") rewrites them; read those with
`read_json_auto('s3://<bucket>/rbn/2026/10/11/*.ndjson.gz')`.

B2 keys belong on an operator's machine or in the `archive` function's secrets, never in the web
app or the inbound worker. Downloads are free up to three times the stored size a month; a full-history
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
select * from callsign_rollup_status where status <> 'done' order by day;
```

One row per UTC day since the first spot (`first_rollup_day()`: the earlier of the first marker and
the first non-RBN `raw_spots` row), through the latest day a rollup may take (two hours after it ends). No
rows means every day is done. Otherwise:

- `pending`: no marker and no recorded failure. Yesterday enters the view at 02:00 UTC and is
  pending until the 02:25 run; an older
  pending day means the hourly job has not reached it yet (a backlog clears at two days an hour)
  or its runs are being cancelled (below). `select * from backfill_callsign_rollups(1);` rolls it
  up now and shows any error.
- `failed`: the hourly job tried it `attempts` times; `last_error` and `last_failed_at` say why
  and when. The row goes away when the day succeeds. The usual causes:
  - `no cty.dat loaded`: run `import-cty` (see "Countries (cty.dat)").
  - anything else: `select * from backfill_callsign_rollups(1);` retries the oldest unrolled day
    and returns the error. A statement-timeout cancel is the one failure the handler cannot
    catch: it rolls back the whole run, leaves no failures row, and the day stays `pending`.
- `rbn_retired`: the day has no marker and retention dropped its RBN rows (`rbn_day_retired`: some
  slice of the day is logged in the archive with more rows than the database holds, the per-slice
  test retention's `rbn_day_archived` uses; late lines in the default partition do not hide it). Retention gives up waiting at 14 days; the day's failures row
  says `RBN rows retired before the roll-up ran`, then the hourly refusal `the RBN spots of ...
  were retired` every hour. The RBN spots are in the archive only.
  `select rollup_callsign_day('<day>', true);` rolls up the other sources, marks the day
  `done_without_rbn` and clears its failures row, accepting that its RBN spots are missing from
  every profile; its RBN rows can still reach `callsign_days` through "Rebuilding a day from the
  archive".
- `done_without_rbn`: the roll-up counted fewer RBN spots than the archive logged for the day: the
  whole day after `(day, true)`, or a late line or two of a retired day. Days rolled up with
  `(day, true)` before the column existed were marked by the migration when their
  `callsign_activity` day rows were still there, and by the fill otherwise.
  Permanent for `callsign_activity` and the running totals.
- `fill_failed`: rolled up, but its `callsign_days` fill keeps failing (`last_error` starts with
  `callsign_days fill:`). The one expected cause is a retired day, not `without_rbn`, whose
  `callsign_activity` day rows were compacted into month rows before the fill reached it (`only
  the archive has it`): build it with "Rebuilding a day from the archive". Or its
  `reference_days` fill keeps failing (`last_error` starts with `reference_days fill:`, and
  `references_filled_at` is null); that fill reads only `raw_spots`, so the error is the lead.
  The day has one failures row, holding whichever fill failed last; either fill's success deletes
  it only when it holds that fill's own error, so the other's stays.
- `done`: rolled up whole. A `done` day whose `days_filled_at` is null has no `callsign_days` rows
  yet (see "Filling callsign_days for older days"), and one whose `references_filled_at` is null
  has no `reference_days` rows yet (see "Filling reference_days for older days").

Every day's attempts, including the retention record, also raise a Postgres warning
(`callsign rollup of ... failed`, `callsign_days fill of ... failed`, `reference_days fill of ...
failed`, `rbn retention: ... retired
without its callsign rollup`), but the view is the record; `cron.job_run_details` shows the run as succeeded either way.

## Pushing the callsign_days migration

`20261019000200` alters `callsign_rollup_days`, and the hourly job holds row locks on it while it
runs, so the migration starts with `select set_config('lock_timeout', '10s', true)` and fails
rather than queue with the whole transaction open. The setting is transaction-scoped, which is how
`supabase db push` applies a migration; applied by hand with psql, wrap the file in `begin;` /
`commit;`, or the setting ends with its own statement. A timeout fails the push: run `supabase db
push` again away from :25 (an RBN day takes about a minute).

## Filling callsign_days for older days

Days rolled up before `callsign_days` existed (2026-10-11 to the day before the migration was
pushed) have `days_filled_at` null in `callsign_rollup_days`. The hourly job fills them two days a
run, oldest first, in every run that rolled no day up (23 of 24; the 02:25 run rolls up yesterday
instead), so a week of history is done within a day of the push. It never does both in one run: a
statement-timeout cancel is not caught and would undo everything the run did. To see it, or to go faster, run it by hand (an RBN day takes about a minute):

```sql
select * from backfill_callsign_days(3);   -- repeat until it returns no rows
select day, spots, days_filled_at from callsign_rollup_status where status like 'done%' and days_filled_at is null;
```

Each row is a day with its spot count and `exact`. The POTA, SOTAwatch, DX Cluster and WWFF rows
are always exact: `raw_spots` is never pruned. `exact` is about the RBN row: true when the day's
RBN rows were still in the database and it was built from them; false when they were already
retired (or held fewer than the roll-up counted) and it came from `callsign_activity` instead,
with `spots` and `bands` exact but `modes` holding at most `cw`. Only the CW bucket maps back to a
mode: RBN reports no FM, and the SSB, FT8/FT4 and Other buckets hold several modes, so RTTY is
missing. That is the case for 2026-10-11 and every later day retention had already dropped (eight
days old at 03:35 UTC) when the fill reached it; the `exact` column of `backfill_callsign_days`
shows which. The hourly job discards `exact`, so run the backfill by hand right after the push if
you want the list; an approximate RBN row can be made exact only
from the archive (below). A row with an `error` was undone, recorded in `callsign_rollup_failures`
(status `fill_failed`) and retried on the next call or hour; a retired day whose
`callsign_activity` day rows were compacted is refused every time (`only the archive has it`) and
needs the archive.

## Filling reference_days for older days

`20261027001100` adds `reference_days` (the reference profiles' activations) and
`callsign_rollup_days.references_filled_at`. It takes the same 10 s lock timeout as the
callsign_days migration (see "Pushing the callsign_days migration"; run the push again away from
:25 if it times out), and builds `raw_spots_reference_time_idx` inside the push: hosted
`raw_spots` was about 562,000 rows / 342 MB on 2026-10-26, which builds in seconds.

New days get their rows from the roll-up. Every day rolled up before the push has
`references_filled_at` null and no `reference_days` rows, so reference pages undercount until the
fill reaches it. The hourly job fills two days a run, days that never failed first and then oldest
first, only in a run that rolled no day up and filled no `callsign_days`; each day is one read of
that day's POTA, SOTAwatch and WWFF rows in `raw_spots`, exact for every day because `raw_spots` is
never pruned. Three weeks of history take about half a day. To see it, or to go faster:

```sql
select * from backfill_reference_days(10);   -- repeat until it returns no rows
select day, references_filled_at from callsign_rollup_status where status like 'done%' and references_filled_at is null;
```

Each row is a day with the reference spots it counted. A row with an `error` was undone, recorded
in `callsign_rollup_failures` as `reference_days fill: ...` (status `fill_failed`) and retried on
the next call or hour. `reference_days` is never compacted and has no running totals, so a day can
be rebuilt: `delete from reference_days where day = '<day>'; update callsign_rollup_days set
references_filled_at = null where day = '<day>'; select fill_reference_days('<day>');` in one
transaction.

## Size

`callsign_activity` is the big one: about 270 bytes a row with its index, one row per station,
source, band and mode bucket per day, folded into month rows after 35 days. Check it with
`select grain, count(*), pg_size_pretty(pg_total_relation_size('callsign_activity')) from callsign_activity group by 1;`.

`callsign_days` is never compacted: one row per station and source per day, about 150 bytes with
its primary key, so a few MB a day. Check it with
`select count(*), min(day), max(day), pg_size_pretty(pg_total_relation_size('callsign_days')) from callsign_days;`
and, per day, `select day, source, count(*) from callsign_days group by 1, 2 order by 1, 2;`.

`reference_days` is never compacted either: one row per program, reference, day, activator and
source, a few thousand rows (about 1 MB) a day. Check it with
`select count(*), min(day), max(day), pg_size_pretty(pg_total_relation_size('reference_days')) from reference_days;`
and, per day, `select day, program, count(*) from reference_days group by 1, 2 order by 1, 2;`.

## Rolling a day up again

Not supported: references, days on the air and variants are running totals, so a second pass
would count the day twice. A day's `callsign_activity`, `callsign_reach`, `callsign_references`,
`callsign_seen` and `callsign_variants` cannot be redone. The tables that can be filled late are
`callsign_days`, from the archive (below), and `reference_days`, from `raw_spots` (see "Filling
reference_days for older days").

## Rebuilding a day from the archive

For a day whose RBN rows are in the archive only (`rbn_retired`, `done_without_rbn`, filled
approximately, or `fill_failed` because its day rows were compacted), `callsign_days` can be built
offline from the day's Parquet slices and inserted.
This is a recipe, not code in the repository. It needs DuckDB on an operator's machine, the
read-only B2 key from "Reading the archive" (never the worker's `writeFiles` key), and a
service-role database connection. Nothing else changes: `callsign_activity` and the running
totals stay as they are.

1. In DuckDB, aggregate the day per source, callsign as spotted, mode and band. Slices are cut
   on `spot_time`, so a folder's day is the spot's UTC day, and the archive holds what reached the
   database within two hours of the slice, so this counts the same spots the roll-up would have.
   RBN rows have no `source` field; the other sources' rows do.

   Slices archived before 2026-10-14 are still gzipped NDJSON in the old layout,
   `<source>/YYYY/MM/DD/HHMM.ndjson.gz`, until the one-off migration rewrites them. The Parquet
   glob below does not match them, so for such a day it silently returns nothing; read them with
   `read_json_auto`. The example day, 2026-10-11, is one (DX Cluster starts on 2026-10-12 and WWFF
   has no NDJSON slices; DuckDB refuses a path that matches no file, so list only the sources with
   files that day):

   ```sql
   install httpfs; load httpfs;
   create secret (type s3, key_id '<keyID>', secret '<applicationKey>',
                  endpoint 's3.<region>.backblazeb2.com', region '<region>', url_style 'path');
   copy (
     select 'rbn' as source, callsign, mode, band, count(*) as n
     from read_json_auto('s3://<bucket>/rbn/2026/10/11/*.ndjson.gz')
     group by all
     union all
     select source, callsign, mode, band, count(*)
     from read_json_auto(['s3://<bucket>/pota/2026/10/11/*.ndjson.gz',
                          's3://<bucket>/sotawatch/2026/10/11/*.ndjson.gz'], union_by_name = true)
     group by all
   ) to '2026-10-11.csv' (header);
   ```

   From 2026-10-14 the slices are Parquet in Hive-style day folders, so `year`, `month` and `day`
   filter the files; files written before WWFF or WWBOTA shipped lack their columns, hence `union_by_name`.
   For example, 2026-10-15:

   ```sql
   copy (
     select 'rbn' as source, callsign, mode, band, count(*) as n
     from read_parquet('s3://<bucket>/rbn/*/*/*/*.parquet', hive_partitioning = true)
     where year = 2026 and month = 10 and day = 15
     group by all
     union all
     select source, callsign, mode, band, count(*)
     from read_parquet(['s3://<bucket>/pota/*/*/*/*.parquet', 's3://<bucket>/sotawatch/*/*/*/*.parquet',
                        's3://<bucket>/dxcluster/*/*/*/*.parquet', 's3://<bucket>/wwff/*/*/*/*.parquet',
                        's3://<bucket>/wwbota/*/*/*/*.parquet'],
                       hive_partitioning = true, union_by_name = true)
     where year = 2026 and month = 10 and day = 15
     group by all
   ) to '2026-10-15.csv' (header);
   ```

2. In Postgres, load the file and insert (here 2026-10-11). Base calls come from `base_callsign()`
   here, never from DuckDB, and the arrays are sorted, distinct and without nulls, as the roll-up
   writes them:

   ```sql
   create temp table day_rows (source text, callsign text, mode text, band text, n int);
   \copy day_rows from '2026-10-11.csv' csv header
   insert into callsign_days (base, day, source, spots, modes, bands)
   select base_callsign(callsign), date '2026-10-11', source, sum(n)::int,
          coalesce(array_agg(distinct mode order by mode) filter (where mode is not null), '{}'),
          coalesce(array_agg(distinct band order by band) filter (where band is not null), '{}')
   from day_rows
   group by 1, 3
   on conflict (base, day, source) do nothing;
   ```

   `on conflict do nothing` keeps whatever rows the day already has, so for a `done_without_rbn`
   day this adds only the missing RBN rows. The roll-up's own insert does the same, so a rebuilt
   row survives a later roll-up; still, for an `rbn_retired` day run `select
   rollup_callsign_day('<day>', true);` first, so its other tables are filled and its POTA,
   SOTAwatch, DX Cluster and WWFF rows come from the roll-up rather than the archive. To replace an
   approximate RBN row, delete it in the same transaction first (`delete from callsign_days where
   day = '2026-10-11' and source = 'rbn';` nothing references it); the other sources' rows are
   exact already. A `fill_failed` day has no rows at all: insert the whole day and, in the same
   transaction, `update callsign_rollup_days set days_filled_at = now() where day = '2026-10-11';`
   so the hourly fill stops retrying it and compaction may fold its day rows (`days_filled_at`
   says only that the rows are there, not that they were exact), and `delete from
   callsign_rollup_failures where day = '2026-10-11';`, since nothing else clears that row once
   the fill stops running. The marker's `spots` stays null: only the fill sets it for such a day.
   Otherwise leave `callsign_rollup_days` alone.

# Licenses (FCC)

How it works is in `docs/ARCHITECTURE.md` ("Licenses (FCC)").

## First deploy

The inbound worker deploys itself on merge, so the database and function go first. If the inbound worker checks
before they exist, it logs `[licenses] load failed` and tries again six hours later. Nothing
breaks in the meantime.

```sh
supabase db push                          # 20261012000050_callsign_licenses
supabase functions deploy load-licenses   # new function: the GitHub integration skips it
```

The function uses the existing `LONGLINES_INBOUND_SECRET`. The inbound worker's first check runs five minutes
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
about eight days old. Inbound logs show each step with `[licenses]` (`fly logs`):

- `loading ... (<Last-Modified>)`, then one line per file with staged and skipped counts, then
  `load finished`.
- `load failed: ...` names the download, parse or function error; the load is `failed` with the
  same text in `error`. It is retried twelve hours after it started. A load still `loading` long
  after it started means the inbound worker stopped mid-load (a deploy, a crash); the next `begin` clears it.

A load stuck at `ready` past :50 means the cron job failed: `select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'apply-license-loads') order by start_time
desc limit 3;`. A `failed` load has the reason in `error`; the previous set stays loaded throughout.

## Turning it off

`fly secrets set INBOUND_LICENSES=off` (restarts the machine) stops the inbound worker loading licenses;
`fly secrets unset INBOUND_LICENSES` turns it back on. `INBOUND_LICENSES` can also name another URL
serving the same zip with Range support.

A local run (functions URL on localhost) does not load licenses by default. To exercise the real
load locally, serve `load-licenses` and set `INBOUND_LICENSES=https://data.fcc.gov/download/pub/uls/complete/l_amat.zip`;
it downloads about 160 MB, so not routinely.

# Reference catalog (POTA, SOTA, WWFF lists)

How it works is in `docs/ARCHITECTURE.md` ("Reference catalog").

## First deploy

The inbound worker deploys itself on merge, so the database and function go first. If the inbound worker checks
before they exist, it logs `[catalogs] check failed: ...` and tries again a day later. Nothing
breaks in the meantime.

```sh
supabase db push                             # 20261026001100_reference_catalog
supabase functions deploy load-references    # new function: the GitHub integration skips it
```

The function uses the existing `LONGLINES_INBOUND_SECRET`. The inbound worker's first check runs fifteen
minutes after it starts; it downloads about 60 MB (POTA 10 MB, SOTA and WWFF 25 MB each), one
program at a time, and stages about 350,000 rows in ~180 requests of 2,000. Each load is applied
at the next :55.

```sql
select id, program, version, state, staged_rows, started_at, finished_at, applied_at, error
from reference_catalog_loads order by id desc limit 6;
select program, count(*), count(*) filter (where active) as active
from reference_catalog group by program;
select reference_load_status();
```

## Is it current?

Each program's last `applied` load should have `started_at` under about eight days old (the inbound worker
reloads a list a week after its last applied load started, once its `Last-Modified` is newer; it
checks once a day). Inbound logs show each step with `[catalogs]` (`fly logs`):

- `<program>: loading <url> (<Last-Modified>)`, then `<program>: N staged, M skipped, finished`.
  A few skips are normal (WWFF repeats its header row partway down the file).
- `<program>: load failed: ...` names the download, parse or function error; the load is
  `abandoned` with the same text in `error` and is retried twelve hours after it started. A load
  still `staging` long after it started means the inbound worker stopped mid-load (a deploy, a crash); the
  next `begin` for that program abandons it.
- `<program>: ... refused`: SQL refused the list as incomplete or below the floor (fewer than 90%
  of the program's current rows, or 10,000 on a first load). `error` says which. The old list
  stays, and the inbound worker never downloads that `Last-Modified` again; a newer file is loaded as
  usual.

While a program's newest load is refused, every `apply-reference-loads` run that swaps nothing
(and refuses nothing itself) fails with `apply_reference_loads: the newest <program> list load was
refused`, so `/health`'s Scheduled jobs card shows it until a good load lands. A real shrink of a program's list (more than
10% of it removed at once) is refused the same way: a refusal deletes its staged rows, so nothing
can be marked through by hand. The floor lives only in `reference_load_floor(program)`; changing
it is a migration.

A load stuck at `finished` past :55 means the cron job failed: `select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'apply-reference-loads') order by
start_time desc limit 3;`.

## Turning it off

`fly secrets set INBOUND_CATALOGS=off` (restarts the machine) stops the inbound worker loading the lists;
`fly secrets unset INBOUND_CATALOGS` turns it back on. Unlike `INBOUND_LICENSES`, it cannot name
another URL: the three URLs are `CATALOG_URLS` in `inbound/config.ts`.

A local run (functions URL on localhost) does not load the lists by default. To exercise the real
load locally, serve `load-references` and set `INBOUND_CATALOGS=on`; it downloads about 60 MB, so not
routinely. `supabase/seed.sql` writes a small catalog for the seeded references directly, since
it is far below the floor.

# Callsign profiles

How they work is in `docs/ARCHITECTURE.md` ("Callsign profiles").

## First deploy (hosted)

`20261012000060_callsign_profile` (applied 2026-10-12) builds the `rbn_spots` base-callsign index
one partition at a time, oldest first, then creates the parent index `ON ONLY` and attaches them.
Each partition is locked against inserts from its build until the migration commits, so a late row
for an older day (the inbound worker buffers about 50 minutes, so just after 00:00 UTC it still sends
yesterday's) waits until the end. The `ON ONLY` create takes a SHARE lock on the parent, which holds
up every RBN insert from then until commit; the attach loop after it only changes catalogs, so that
window is short. Today's partition, built last, is the long wait. Locally, at hosted volume, each full day took about
16 s, and an insert probe into today's partition every second never waited more than 19 ms while the
older days built. Today's partition takes about 16 s at the end of a UTC day and a few seconds in the
early hours, under the API's 8 s timeout that `ingest-rbn` pushes run into; a push that does time out
is retried by the inbound worker, which buffers about 50 minutes. Prefer the early UTC hours, after retention
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

If a push timed out, the inbound worker logs `push failed` and retries. A gap in RBN rows that outlasts the
inbound's buffer shows in `select date_trunc('minute', spot_time), count(*) from rbn_spots
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

## Taking a group's public page down

The owner turns it off on the group's Settings tab. To do it for them, by the code in the link:

```sql
update callsign_groups set public = false where public_slug = '7f3kq6xm2a';
```

The next load of `/g/<code>` shows "This page is private": `group-page` sends `no-store`, so no
browser or CDN keeps the old page. The code stays with the group, so turning the page back on
brings the same link back. Hiding a member's call (`hidden_callsigns`, above) drops it from every
group's figures on the next load.

## Group statistics look stale

Group statistics are cached for an hour per period, and rebuilt early when the members change. To
rebuild one group's now: `delete from group_stats_cache where group_id = '<id>';`.

## A profile looks stale

Profiles are cached for 15 minutes. To rebuild one now:
`delete from callsign_profile_cache where callsign = 'KK4PWJ';`. Days that are rolled up come from
the rollups ("Callsign rollups" above); today and yesterday until 02:25 UTC are read live.

# Reference profiles

How they work is in `docs/ARCHITECTURE.md` ("Reference profiles"). They need the reference
catalog and `reference_days` above.

## First deploy (hosted)

`20261027001200_reference_profile` adds `reference_profile`, its cache, a `comment` column at the
end of `spot_stream`, and the reference rule's exact ops (`is`, `is_not`). It builds no index
(the live read uses `raw_spots_reference_time_idx` from `20261027001100`), so the push takes
seconds. Push it before Vercel ships the web: the builder's new default op `is` is refused by the
old `normalize_subscription_rules` ("A reference rule can't use is.").

```sh
supabase migration list                        # 20261027001200 pending
supabase db push
supabase functions deploy reference-profile    # new function: the GitHub integration skips it
```

Until the function is deployed, `/ref/...` shows its error state (a gateway 404 is not "Not
found"). Then check, in the SQL editor:

```sql
select cached_reference_profile('pota', 'US-2763') -> 'totals';
select cached_reference_profile('pota', 'ZZ-0000');    -- null: in neither the list nor a spot
```

## Is it working?

```sh
curl -si "$SUPABASE_URL/functions/v1/reference-profile?program=pota&reference=US-2763" | head -20
```

200 with `Cache-Control: public, max-age=300` and the profile; 404 `Reference not found.` for a
program without pages, a malformed reference, or one in neither the list nor any spot; 429 past
30 lookups a minute from one client, counted with callsign profiles and group pages; 500
`Reference pages are unavailable right now.` when the RPC failed or its reply did not fit the
schema (the function logs `reference-profile:` with the error, never the reference).

## A reference page looks stale or wrong

Reference pages are cached for 15 minutes. To rebuild one now:
`delete from reference_profile_cache where program = 'pota' and reference = 'US-2763';`.
Rolled-up days come from `reference_days`; a day rolled up before that table existed counts only
once the fill reaches it ("Filling reference_days for older days" above). Hiding a call
(`hidden_callsigns`, "Hiding a profile" above) drops it from every reference page on the next
load: a cache row built before the newest `hidden_at` is rebuilt.

## Reference lookup (`/ref`) and the reference picker

`20261027001500_reference_search` adds `search_references`, its body `search_references_at` and
the helper `reference_catalog_header`. It builds no index and changes no table, so the push takes
seconds. Push it and deploy the function before Vercel ships the web: until then `/ref` and the
reference rule's picker say the search is unavailable (the picker still accepts typed references).

```sh
supabase migration list                        # 20261027001500 pending
supabase db push
supabase functions deploy reference-search     # new function: the GitHub integration skips it
```

Then check, in the SQL editor:

```sql
select search_references('mitchell', null) -> 'more';
select search_references('x', null);                   -- null: under 2 characters
```

And from a shell:

```sh
curl -si "$SUPABASE_URL/functions/v1/reference-search?q=mitchell" | head -20
curl -si "$SUPABASE_URL/functions/v1/reference-search?q=us&program=pota" | head -20
```

200 with `Cache-Control: public, max-age=300` and `{results, more}`; 400 `A search is 2 to 64
characters, at most 6 words.` or `The program must be pota, sota or wwff.` before any database
call; 429 past 30 lookups a minute from one client, counted with callsign profiles, group pages
and reference pages; 500 `Reference search is unavailable right now.` when the RPC failed or its
reply did not fit the schema (the function logs `reference-search:` with the error, never the
query). Searches are not cached in the database; each one scans the catalog once (about 0.4 s for
`us`). Until the inbound worker's first reference list loads land, the search finds nothing.
