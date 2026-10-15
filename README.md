# Long Lines

Long Lines is a routing fabric for amateur radio spots. It watches the public spot feeds for
[Parks on the Air](https://pota.app), [Summits on the Air](https://sotawatch.sota.org.uk) and
[World Wide Flora & Fauna](https://wwff.co), plus the
[Reverse Beacon Network](https://reversebeacon.net) for the callsigns you follow, normalizes
every spot into one shape, and delivers the ones you care about to a Discord channel or a signed
webhook within about a minute of them being posted.

The name is an homage to AT&T's Long Lines microwave backbone. The project moves other people's
signals from where they are published to where they are wanted; it does not generate spots
itself.

## Why it exists

Spots are how portable operators tell the world "I am on the air, here, now." They are
time-critical: an activation lasts an hour or two, and a park or summit you want to work may
only be spotted once. Each program publishes its own feed, in its own format, with its own
quirks, and the only way to follow them is to keep a browser tab open and refresh.

Long Lines exists so that you can describe what you want once ("CW on 20m and 40m from any
SOTA summit", "this list of callsigns on any band") and have matching spots pushed to you, from
every supported source, in a single format. It also exists as a small, honest example of
running a real-time pipeline almost entirely on Supabase: Postgres does the scheduling, queuing
and matching, and two kinds of Edge Function do the parts that need to talk to the outside world.
The one exception is a small relay on Fly.io for the feed that only exists as a persistent
connection.

## How it works

Everything runs inside one Supabase project plus a static web app, except for one small relay
on Fly.io that holds the telnet stream from the Reverse Beacon Network.

```
POTA / SOTAwatch / WWFF ──► ingest functions ──► raw_spots + spot_events queue
RBN telnet ──► relay (Fly.io) ──► ingest-rbn ──┘
APRS-IS ──► relay ──► ingest-aprs ──► aprs_packets (stored and archived, not matched)
                                                   │
                                   match_pending_spots (SQL, every minute)
                                                   │
                                        deliveries + deliveries_queue
                                                   │
                                          deliver function ──► Discord / webhooks
```

**Ingest.** `pg_cron` calls the `ingest-pota` and `ingest-wwff` functions every minute and
`ingest-sotawatch` every 30 seconds over `pg_net`. Each function fetches its upstream feed,
normalizes the spots (uppercase callsigns, kHz frequencies, lowercase modes, derived `band` and
`mode_family`), and hands the whole batch to one `ingest_spots` RPC. That RPC inserts into `raw_spots` and enqueues
a `spot_events` message per new row in a single transaction. Dedup is a unique constraint over
a content hash, so re-fetching an unchanged feed inserts nothing and an edited spot lands as a
new row. Spots that cannot be normalized go to `ingest_failures` instead of aborting the run.

**Streaming sources.** RBN only offers a persistent telnet stream, which an Edge Function cannot
hold, so `relay/` (a small Deno process on one Fly.io machine) keeps a single connection open.
It forwards every spot in batches every 10 seconds, and pushes an empty batch at least once a
minute so source health shows the relay is alive. `ingest-rbn` stores every spot in `rbn_spots`
(partitioned by day; seven days stay in the database) and sends only spots of callsigns named in a
subscription on to matching, through the same orchestrator as the pulled sources. The relay
authenticates with a shared secret and never holds
a Supabase key. An RBN spot only matches subscriptions that name callsigns, so a broad "any
source, 20m CW" subscription is not flooded with other people's watchlist hits. The relay also holds the
APRS-IS full feed: every packet on the network goes into `aprs_packets` (about two days in the
database, everything in the B2 archive) for later analysis. APRS packets are not spots and
never reach matching. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ("Streaming sources: the relay").

**Match.** `match_pending_spots()` is a Postgres function on a one-minute cron, also poked after
every successful ingest. It joins a batch of `spot_events` against every enabled subscription
that has a destination, using the `spot_matches` predicate, applies each subscription's per-callsign quiet window, and
writes one `deliveries` row per destination and spot. The web app's live preview calls the same
predicate, so what you see while editing a subscription is exactly what will be delivered.

**Deliver.** The `deliver` function claims queued deliveries, groups them by destination, and
sends them: Discord as embeds, webhooks as signed JSON with an HMAC-SHA256 header. Every outcome
goes back through an RPC so delivery rows, queue messages and destination health change
atomically. Failures back off for 24 hours and then drop; five in a row mark the destination
failing. Rate limits delay rather than fail. Outbound URLs are checked in SQL at creation and
again in the worker, with DNS resolved, so private addresses are never reached.

**Archive.** Every spot from every source is also written to a private Backblaze B2 bucket as Parquet,
one file per slice (five minutes for APRS-IS, ten for RBN, an hour for the others) in
`<source>/year=/month=/day=` folders, by the `archive` function every 10 minutes. DuckDB, pandas or Spark read the files directly. RBN days leave the database
only after their archive matches.

**Web app.** `web/` is a Vite, React and MUI single-page app that talks to Supabase with the anon
key and the user's session. Users sign in with a callsign or email, see source health, create
destinations (the signing secret is shown once), and build subscriptions with filters on source,
band, mode, callsign and reference. All client writes go through RPCs, and sensitive columns are
excluded from the grants, so nothing in the browser can read a destination URL or secret.

The design rationale is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), day-two checks and
dashboard settings in [docs/OPERATIONS.md](docs/OPERATIONS.md), and the webhook contract with a
verification example in [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `supabase/migrations/` | Schema, RPCs, queues, cron jobs. Applied migrations are never edited; add a new one. |
| `supabase/functions/_shared/` | All Edge Function logic: ingest orchestrator, source adapters, mode canonicalization, delivery formatting and sending. |
| `supabase/functions/ingest-*`, `deliver`, `send-test`, `sign-in`, `delete-account` | Thin entrypoints around `_shared`. `ingest-rbn` is the push endpoint the relay calls. |
| `supabase/functions/_shared/__tests__/` | Deno unit tests and the fixtures captured from the real feeds (POTA, SOTAwatch and WWFF JSON, an RBN telnet capture). Nothing in the suite calls an upstream. |
| `relay/` | The stream relay that runs on Fly.io: telnet session, batching forwarder, `/healthz`, and its Dockerfile. It imports the RBN parser from `_shared`. Tests use a local TCP server, never RBN. |
| `fly.toml` | The relay's Fly.io config. It sits at the root because Fly's GitHub integration deploys from there and the image needs `supabase/functions/_shared`. |
| `supabase/tests/` | pgTAP suites that assert grants, RLS and RPC behavior against a fresh database. |
| `scripts/` | `smoke-test.sql` (also run by CI) and the one-time `setup-db-settings.sql` for Vault. |
| `web/` | The user-facing app. `src/lib/api.ts` is the only module that touches supabase-js. |
| `web/scripts/` | Local-development helpers behind the npm scripts: env setup, `dev:full`, function invokes, the local CI runner. |
| `docs/` | Architecture, operations, webhook contract, and the UI mock the copy is taken from. |

## Running it locally

Prerequisites: [Docker](https://docs.docker.com/get-docker/), the
[Supabase CLI](https://supabase.com/docs/guides/cli), [Deno](https://deno.com) 2.x, and Node
22.18 or later for the web app. On macOS: `brew install supabase/tap/supabase deno node`.

Day-to-day commands are npm scripts in `web/package.json`; run them from `web/`.

### Quick start

```sh
cd web
npm install
npm run dev:full
```

`dev:full` starts the local Supabase stack (Postgres, Auth, the API gateway, Studio and a mail
catcher), applies every migration, writes the local URL and anon key into `web/.env.local`, then
runs Vite and the Edge Functions side by side. Ctrl+C stops both; the stack keeps running until
`npm run supabase:stop`. The first start downloads the Docker images and takes a few minutes.

| Service | URL |
| --- | --- |
| Web app | http://localhost:5173 |
| API | http://127.0.0.1:54321 |
| Studio (`npm run supabase:studio`) | http://127.0.0.1:54323 |
| Mail catcher (`npm run supabase:mail`) | http://127.0.0.1:54324 |

Local Auth requires email confirmation, so after signing up open the mail catcher and click the
link. Local `config.toml` already lists `http://localhost:5173` in the redirect URLs.

### Ingest and delivery by hand

The cron jobs exist locally but have no Vault secrets to call the functions with, so trigger runs
yourself while `dev:full` (or `npm run supabase:functions`) is serving the functions:

```sh
npm run invoke:pota          # or invoke:sotawatch, invoke:wwff
```

The response is the run summary (`fetched`, `inserted`, `skipped`, `failed`). These calls hit
the real POTA, SOTAwatch and WWFF feeds, so be polite and do not script them in a loop. Then check
what landed with `npm run db:psql`:

```sql
select * from ingest_health;
select source, count(*) from raw_spots group by source;
select * from pgmq.metrics('spot_events');
```

To push spots through matching and delivery, run the matcher and then the worker:

```sh
npm run db:match
npm run invoke:deliver
```

RBN spots arrive through the relay rather than an invoke. To run it against the local stack,
serve the functions with a relay secret and start the relay with the same value:

```sh
echo 'LONGLINES_RELAY_SECRET=local-secret' > /tmp/relay.env
supabase functions serve --env-file /tmp/relay.env

LONGLINES_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 \
LONGLINES_RELAY_SECRET=local-secret RELAY_LOGIN_CALL=<your callsign> \
deno run --allow-net --allow-env relay/main.ts
```

This opens a real connection to `telnet.reversebeacon.net`, so stop it when you are done. Every
spot lands in `rbn_spots` (tens of thousands an hour); only callsigns named in a subscription that
includes RBN go on to `raw_spots` and matching.

The worker refuses plain-http and private addresses, so a receiver on your own machine is
rejected by default. For local testing only, create `supabase/functions/.env` containing
`LONGLINES_ALLOW_INSECURE_DESTINATIONS=1` and insert the destination row directly in SQL, as
described in [docs/OPERATIONS.md](docs/OPERATIONS.md). Never set that variable on a hosted
project.

### Tests and checks

```sh
npm run test:all             # every CI check, then a pass/fail summary
npm run test:all:fresh       # the same after `supabase db reset`
npm run test:deno            # one group: fmt, lint, check and unit tests for the Edge Functions and relay
npm run test:db              # one group: db lint, pgTAP and scripts/smoke-test.sql (stack must be running)
```

`test:all` runs what CI runs on every pull request and push to `main`: Deno fmt/lint/check/test,
`supabase db lint`, the pgTAP suites, the smoke test, and the web app's lint, tests and build. It
keeps going after a failure so the summary shows everything at once.

The local stack is shared by every checkout and worktree of this repo. If another branch's
migrations are applied, or local ingest runs left rows in `raw_spots`, pgTAP can fail locally
while CI is green. `test:all` warns when the database's migrations don't match the checkout;
`test:all:fresh` resets the database to this checkout first, which wipes local data.

For a single Deno test, use the task directly from the repo root:

```sh
deno test -P supabase/functions/_shared/__tests__/pota.test.ts --filter "hashes"
```

### Resetting

`npm run supabase:reset` drops the local database and re-applies every migration. After any
schema change, regenerate the types the web app compiles against:

```sh
npm run supabase:types
```

If the stack is stuck or corrupted and a reset doesn't help, `npm run supabase:nuke` removes this
project's containers, volumes and network (other projects' stacks are left alone). Start again with
`npm run supabase:start`.

### npm script reference

| Command | What it does |
| --- | --- |
| `dev:full` | `supabase:start`, then Vite and `supabase functions serve` together. |
| `supabase:start` / `stop` / `restart` / `status` | The matching `supabase` command for this repo. `start` also runs `supabase:setup-env`. |
| `supabase:setup-env` | Writes `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` into `web/.env.local` from `supabase status`. Other lines in the file are kept. |
| `supabase:functions` | `supabase functions serve` on its own. |
| `supabase:reset` | `supabase db reset`. Wipes local data, then loads `supabase/seed.sql`: a synthetic week of POTA, SOTA, WWFF and RBN spots so the Stats page has something to show. |
| `supabase:types` | Regenerates `web/src/lib/database.types.ts`. |
| `supabase:studio` / `supabase:mail` | Opens Studio or the mail catcher (macOS `open`). |
| `supabase:nuke` | Removes this project's Docker containers, volumes and network. Wipes local data. |
| `invoke:pota` / `invoke:sotawatch` / `invoke:wwff` / `invoke:deliver` | Calls the function with the local service-role key, as cron does when hosted. |
| `db:match` | Runs `match_pending_spots()` once. |
| `db:psql` | Opens psql in the database container (`psql` is not installed with the CLI). |
| `test:all` / `test:all:fresh` / `test:deno` / `test:db` | The checks described above. |
| `dev` / `test` / `lint` / `build` | Vite, Vitest, oxlint, and `tsc -b` + `vite build` for the web app alone. |

The scripts behind them are in `web/scripts/` and only ever talk to the local stack.

### Without npm

The scripts are thin wrappers, so the plain commands still work from the repo root:

```sh
supabase start                                    # prints the local URLs and keys
supabase functions serve
curl -X POST http://127.0.0.1:54321/functions/v1/ingest-pota \
  -H "Authorization: Bearer <local service_role key>"
docker exec -i supabase_db_longlines psql -U postgres
supabase gen types typescript --local > web/src/lib/database.types.ts
```

For the web app on its own, copy `web/.env.example` to `web/.env.local`, paste the local anon key,
and run `npm run dev` in `web/`.

## Deploying to a hosted project

The short version. [docs/OPERATIONS.md](docs/OPERATIONS.md) has the Auth, SMTP and Vercel
settings that go with it.

```sh
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push

supabase secrets set LONGLINES_USER_AGENT_URL=https://github.com/<you>/longlines
supabase secrets set LONGLINES_RELAY_SECRET=<openssl rand -hex 32>   # shared with the relay
for fn in ingest-pota ingest-sotawatch ingest-wwff ingest-rbn deliver send-test sign-in delete-account archive; do
  supabase functions deploy "$fn"
done

# One time: give cron the project URL and service-role key via Vault.
# Edit the placeholders in scripts/setup-db-settings.sql first; never commit real values.
psql "$DATABASE_URL" -f scripts/setup-db-settings.sql
```

After a minute or two, `select * from ingest_health;` should show POTA, SOTAwatch and WWFF
with a recent `last_success_at`. The web app deploys to Vercel from `web/` as a plain static site.

### The relay on Fly.io

The relay is one `shared-cpu-1x` machine with 256 MB (it uses about 20 MB). Set it up once, from
the repository root:

```sh
fly apps create longlines-relay
fly secrets set \
  LONGLINES_FUNCTIONS_URL=https://<PROJECT_REF>.supabase.co/functions/v1 \
  LONGLINES_RELAY_SECRET=<same value as above> \
  RELAY_LOGIN_CALL=<your callsign>
fly deploy --ha=false        # --ha=false: one machine, so one session to RBN
```

After that, Fly's GitHub integration (connected in the Fly dashboard) deploys every merge to
`main` from the root `fly.toml`. When the integration is first connected, Fly's launcher opens a
PR with its own generic `fly.toml`, `Dockerfile` and `example.ts`. Close it rather than merging:
that config runs the wrong entrypoint, exposes a public HTTP service that stops the idle machine,
and asks for two machines.

Once deployed, `fly logs` should show `connected to telnet.reversebeacon.net:7000` and
`ingest_health` should show `rbn` with a `last_success_at` under a minute old. The deploy order,
secret rotation and troubleshooting are in [docs/OPERATIONS.md](docs/OPERATIONS.md) ("Relay
(RBN)").
