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

## Linting the Deno code

The Deno code (`supabase/functions`, `relay/`, `sender/`, `scripts/`) is also checked by strict
typescript-eslint, from the root `package.json`. The rules and the areas still pending are in
`eslint.config.ts`; the conventions are
[docs/superpowers/specs/2026-10-22-strict-eslint-conventions.md](docs/superpowers/specs/2026-10-22-strict-eslint-conventions.md).

```sh
npm ci               # at the repository root
npm run lint         # ESLint, zero warnings allowed
npm run typecheck    # deno check every entrypoint and scripts/*.ts
```

`deno.d.ts` is the Deno runtime's type declarations for ESLint's type checker. After a Deno
upgrade, regenerate it with `deno types > deno.d.ts` and commit it. After `npm i -D`, run any
`deno` command and commit `deno.lock` too: Deno records the root `package.json`'s dependencies
there.

Why each dev dependency is there (JSON cannot hold comments):

| Package | Why |
| --- | --- |
| `eslint` | The linter. |
| `typescript-eslint` | The TypeScript parser and the `strictTypeChecked` rules. |
| `typescript` | The type checker typescript-eslint runs on. |
| `jiti` | Lets ESLint load `eslint.config.ts`, a TypeScript config. |
| `@types/node` | Deno's timers (`setTimeout`, `clearTimeout`) come from its bundled Node types, which `deno types` leaves out of `deno.d.ts`. |
| `@supabase/supabase-js`, `hyparquet`, `hyparquet-writer`, `postgres` | Types for the npm packages the code imports, at the versions in `deno.lock`. |
| `zod` | Validates external data (feeds, request bodies, RPC replies) through `_shared/validate.ts`, in place of hand-written checks and `as` casts. It is also a runtime dependency: every function's, the relay's and the sender's `deno.json` map it. |
| `@std/assert`, `@std/yaml` | Types for the JSR packages the tests import, from npm.jsr.io (`.npmrc`), at `deno.lock`'s versions. |

Deno itself never reads `node_modules` (`"nodeModulesDir": "none"` in `deno.json`), and the
function bundles and the relay and sender images do not include any of this (zod aside, which
they load through their own `deno.json`).

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and reasoning
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deploying, health checks and troubleshooting
- [docs/WEBHOOKS.md](docs/WEBHOOKS.md): the webhook contract and how to verify signatures
- [docs/API.md](docs/API.md): the management API, with its OpenAPI reference
  [docs/openapi.yaml](docs/openapi.yaml)
