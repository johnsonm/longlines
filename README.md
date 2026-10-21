# Long Lines

Long Lines collects amateur radio spots from public feeds, stores them in one shape, and sends the
ones you ask for to Discord, a webhook or your phone, usually within a minute.

## What it does

- **Sources:** POTA, SOTAwatch, WWFF, DX Cluster and the Reverse Beacon Network. APRS-IS packets
  are stored and archived but never matched.
- **Connections:** filters on source, band, mode, callsign, reference and callsign groups, with
  a live preview of what would match.
- **Destinations:** Discord, signed webhooks and web push.
- **Public pages:** stats, a live band map and callsign profiles.
- **Management API:** token-based access to the same operations as the web app
  ([docs/API.md](docs/API.md)).
- **Archive:** every spot is written to Backblaze B2 as Parquet.

## How it fits together

```
POTA / SOTAwatch / WWFF ──► Edge Functions (pg_cron) ──┐
RBN / DX Cluster / APRS-IS ──► relay (Fly.io) ─────────┴─► Postgres: store, match
                                                              │
                                     sender (Fly.io) ◄────────┘──► Discord / webhooks / push
```

Almost everything is Supabase: Postgres does the scheduling, queuing and matching, and Deno Edge
Functions pull the feeds. Two small Deno processes run on Fly.io: `relay/` holds the streaming
feeds and `sender/` delivers.

| Path | What it is |
| --- | --- |
| `supabase/migrations/` | Schema, RPCs, queues and cron jobs |
| `supabase/functions/` | Edge Functions; the logic is in `_shared/` |
| `relay/`, `sender/` | The two Fly.io processes |
| `web/` | Vite, React and MUI web app |
| `docs/` | Architecture, operations, webhooks and API |

## Running it locally

Needs Docker, the Supabase CLI, Deno 2 and Node 22.18+.

```sh
cd web
npm install
npm run dev:full     # local Supabase stack, Edge Functions and the app on http://localhost:5173
npm run test:all     # every CI check, with a summary
```

`web/package.json` lists the other scripts (`invoke:pota`, `db:match`, `sender`, `supabase:reset`
and so on).

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and reasoning
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deploying, health checks and troubleshooting
- [docs/WEBHOOKS.md](docs/WEBHOOKS.md): the webhook contract and how to verify signatures
- [docs/API.md](docs/API.md): the management API, with its OpenAPI reference
  [docs/openapi.yaml](docs/openapi.yaml)
