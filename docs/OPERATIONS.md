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

Individual spots that could not be normalized:

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
```

## Sign-in rate limiting

`sign_in_attempts` logs every attempt. To see who is being throttled:

```sql
select identifier, count(*) from sign_in_attempts
where attempted_at > now() - interval '15 minutes'
group by 1 having count(*) >= 10;
```

Rows older than a day are deleted by the daily housekeeping job.

## Database tests

`supabase/tests/*.test.sql` are pgTAP suites that run against a fresh local
database (`supabase db start` or `supabase start`, then `supabase test db`). CI
runs them on every PR. `supabase/tests/helpers/users.psql` seeds two users and
an `as_user(uuid)` helper that switches to the `authenticated` role with that
user's JWT claims, which is how the RLS assertions work.

## Delivery

Deploy the two delivery functions after `supabase db push`:

```sh
supabase functions deploy deliver
supabase functions deploy send-test
```

`deliver` is called by cron every minute and by the matcher; both use the Vault
secrets from Phase 1, so nothing new to configure.

### Is anything flowing?

```sql
select status, count(*) from deliveries where created_at > now() - interval '1 hour' group by 1;
select * from pgmq.metrics('deliveries_queue');
select name, type, health, consecutive_failures, last_error, last_error_at, last_success_at
from destinations order by health desc, last_error_at desc nulls last;
select jobname, status, return_message, start_time
from cron.job_run_details d join cron.job j using (jobid)
where jobname in ('match-pending-spots', 'deliver') order by start_time desc limit 10;
```

### A destination keeps failing

`destinations.last_error` holds the upstream status or the safety-check
message. Retries follow 30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m, for 24
hours; after that the delivery is `dropped`. To stop retrying without deleting
the destination:

```sql
update destinations set health = 'paused' where id = '<id>';
-- later
update destinations set health = 'ok', consecutive_failures = 0 where id = '<id>';
```

Paused destinations are skipped by the worker; their messages wait in the
queue and are dropped at 24 hours like any other.

### Local development

The worker refuses plain-http and private addresses. To exercise delivery
against a receiver on your own machine, set
`LONGLINES_ALLOW_INSECURE_DESTINATIONS=1` in `supabase/functions/.env` (read by
`supabase functions serve`) and insert the destination row directly in SQL;
`create_destination()` will not accept such a URL. Never set this on the hosted
project.

### Housekeeping

A daily job (`housekeeping`, 03:00 UTC) deletes deliveries and archived queue
messages older than 7 days and sign-in attempts older than a day.

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

# Relay (RBN, DX Cluster)

The relay in `relay/` runs on Fly.io as app `longlines-relay`. It holds one telnet session per feed:
RBN (`ingest-rbn`) and DX Cluster (`ingest-dxcluster`). Design notes are in `docs/ARCHITECTURE.md`
("Streaming sources: the relay").

## First deploy

```sh
# 1. Database and function (Supabase side)
supabase db push                                   # adds the rbn source, watchlist RPC, matcher guard
openssl rand -hex 32                               # the relay secret; use it in both places below
supabase secrets set LONGLINES_RELAY_SECRET=<secret>
supabase functions deploy ingest-rbn

# 2. Relay (Fly side), from the repository root
fly apps create longlines-relay                    # name must match app in fly.toml
fly secrets set \
  LONGLINES_FUNCTIONS_URL=https://<project-ref>.supabase.co/functions/v1 \
  LONGLINES_RELAY_SECRET=<secret> \
  RELAY_LOGIN_CALL=<callsign>
fly deploy --ha=false                              # --ha=false: one machine, not two
fly scale count 1                                  # exactly one machine: one telnet session
```

## Automatic deploys

Deploys on merge to `main` come from Fly's GitHub integration, set up in the Fly dashboard rather
than in this repo. It deploys from the root `fly.toml`, which builds `relay/Dockerfile` with the
repository root as context (the image needs `supabase/functions/_shared`), the same as the
`fly deploy` line above.

When the integration was first connected, Fly's launcher opened a PR (#30) with its own generic
`fly.toml`, `Dockerfile` and `example.ts`. That config ran a nonexistent `main.ts` as root, added a
public HTTP service that auto-stops idle machines, and created two machines. Do not merge such a
PR again; the root `fly.toml` here is the relay's real config.

Two things to know about it:

- It is not gated on CI. A merge to `main` deploys whether or not the PR's checks passed, so keep
  `main` protected by the CI checks.
- Every deploy restarts the machine and opens a new session to RBN. If the integration deploys on
  every push rather than only when `relay/` or `supabase/functions/_shared/*.ts` change, that is
  one reconnect per merge.

It deploys only the relay. Migrations (`supabase db push`) and the `ingest-rbn` function
(`supabase functions deploy ingest-rbn`) are still applied by hand; do those first when a change
needs both sides. After the first deploy, check `fly scale show` reports
one machine.

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

This opens real connections to RBN and the DX Cluster node; stop it when done. In Docker, use
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

# Spot archive

How it works is in `docs/ARCHITECTURE.md` ("The spot archive").

## Is it keeping up?

```sql
select * from archive_status;   -- pending_slices should stay at 0-2 per source
select status_code, content::text from net._http_response order by created desc limit 5;
```

A growing `pending_slices` means runs are failing; the `archive` function's responses (500 with an
`errors` list) say why. Nothing is lost meanwhile: retention drops no RBN day until its slices are
archived.

## Re-archive a slice

```sql
delete from archive_log where source = 'rbn' and slice_start = '2026-10-11 14:10+00';
```

The next run rewrites the object at the same path.

## Retention

`maintain_rbn_spots()` runs at 03:35 UTC. It checks every eligible day first and drops the archived
ones last, giving up on a drop after a 5 s lock wait (it retries the next night). To see why a day
is still in the database:

```sql
select * from rbn_day_slices('2026-10-01') where archived_rows is distinct from db_rows;
```

## Reading the archive

DuckDB reads the files straight from Storage's S3 endpoint:

```sql
install httpfs; load httpfs;
create secret (type s3, key_id '<S3 access key>', secret '<S3 secret>',
               endpoint '<project-ref>.supabase.co/storage/v1/s3', region '<region>', url_style 'path');
select spot_type, count(*) from read_json_auto('s3://archive/rbn/2026/10/11/*.ndjson.gz') group by 1;
```

S3 access keys are created under Storage settings and can read every bucket, so they belong on an
operator's machine, never in the web app or the relay.

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

`20261012000060_callsign_profile` builds the `rbn_spots` base-callsign index one partition at a
time, oldest first, then creates the parent index and attaches them. A partition is locked against
inserts from its build until the migration commits, so only the partitions built last, today's and
the empty future ones, ever hold up RBN inserts. Locally, at hosted volume, each full day took about
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
(`cf-connecting-ip` when unset), which the edge proxy sets and a client cannot. Without it, it uses the
last `x-forwarded-for` entry, which the nearest proxy appended; that is safe but may be a proxy's
address shared by many clients. It never uses the first entry, which the client writes. After the
first deploy, check that a client cannot reset its own limit:

```sh
for i in $(seq 1 31); do
  curl -s -o /dev/null -w "%{http_code} " -H "cf-connecting-ip: 192.0.2.$i" -H "x-forwarded-for: 192.0.2.$i" \
    "$SUPABASE_URL/functions/v1/callsign-profile?callsign=KK4PWJ"
done   # the 31st must be 429
```

If it is not 429, the header is passed through from the client: find the one the proxy sets (log
`req.headers` once) and `supabase secrets set LONGLINES_CLIENT_IP_HEADER=<name>`. The `prune-callsign-lookups` job (:15 hourly)
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
