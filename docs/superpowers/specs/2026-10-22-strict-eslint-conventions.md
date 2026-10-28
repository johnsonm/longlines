# Strict ESLint for the Deno code: conventions

Date: 2026-10-22. Status: **complete** (the wrap-up PR, 2026-10-26, was the last step). Part 1 (style, enforced by ESLint) lands as one tooling
PR (0b) and one PR per area; Part 2 (Zod at every external boundary and a strict error style)
follows the same areas. Brad merges them one at a time: 0a runtime config, 0b tooling, Part 1
ingest, archive, handlers, delivery, inbound, sender, then Part 2 setup, surface, the same six
areas, and a wrap-up. Each PR's chat stays inside its own files.

The aim is plain, explicit, Go-style TypeScript in `supabase/functions`, `inbound/`, `sender/` and
`scripts/`. The rules are in `eslint.config.ts`; CLAUDE.md's "TypeScript (supabase/functions,
inbound, sender, scripts)" section is the short version.

## Rules for every area PR

### Frozen surface

Never change an exported name, signature or type. If a fix needs that, leave it and report it.

### No behavior change

Inputs, outputs, status codes, error messages, log lines and JSON key order (webhook and Discord
bodies) all stay the same. One exception: a non-null `!` becomes an explicit check that throws
`new Error("<what was missing, where>")`. Before, that case failed with a TypeError further on.
List each one in the PR.

### Leave narrowing alone

Existing `as` casts and runtime checks stay exactly as they are, and Part 2 replaces them. Never
delete a runtime check. Never add `any`. New code must not add `as` casts, even where lint allows
them.

### Replacements

- Ternary: `if`/`else`.
- `??`: a check for exactly `null` and `undefined`.
- `||` in a value position: a check that falls through on exactly the falsy values the operand's
  type can hold (`false`, `0`, `-0`, `0n`, `""`, `null`, `undefined`, `NaN`), so the semantics are
  identical for every falsy case. A number operand needs both `=== 0` and `Number.isNaN`.
- `?.`: nested `if`s that keep the short-circuit.
- Spread: an explicit build in the same key order, a loop or `Array.from`.
- Destructuring: field or index access.
- Block-bodied arrow: a named function. Tests use
  `Deno.test("name", async function (): Promise<void> { ... })`.
- `.then`: `await`. `.reduce`: a `for...of` loop.
- Numbers in template strings: `String(n)`.

Every value-position `||`/`??` replacement goes in the PR body as file:line, old, new.

### Handlers

`async function handler(req: Request): Promise<Response>` followed by `Deno.serve(handler);`.
Dependencies are module-level constants.

### Imports

Use bare names, each mapped in the root `deno.json` and in every `deno.json` that ships the
module: the function's own, `inbound/deno.json` or `sender/deno.json`.

### Lint configuration

Never add `eslint-disable`. Never edit `eslint.config.ts`, `tsconfig.json` or the `package.json`
scripts, except to remove your own area from the ratchet list. If a rule seems wrong, report the
rule, file:line and the reason.

### Comments

Add a short comment above anything non-obvious and match the surrounding density. No emojis.

### Gates, per file group

- `npx eslint --max-warnings 0 --no-inline-config <owned paths>` reports 0 errors.
- `npm run typecheck`, `deno task check`, `deno task lint`,
  `deno fmt --check supabase/functions scripts inbound sender deno.json` and `deno task test` pass.
- `deno task coverage` stays at or above 80% at the end.

Commit each group.

### Formatting inbound/ and sender/ on their own

`inbound/deno.json` and `sender/deno.json` hold only an import map (`app_config.test.ts` enforces
it), so `deno fmt inbound` or `deno fmt sender/db.ts` picks up the nearest config and formats at
width 80, not 100. The CI command passes because `supabase/functions` comes first. When
formatting only inbound or sender files, pass the root config:
`deno fmt --config deno.json inbound sender`.

## The config

- `pendingStyle` in `eslint.config.ts` listed every area whose Part 1 PR had not merged, sources
  and tests, and pending files were ignored outright. The sender PR emptied and deleted it.
- The main block is `strictTypeChecked` plus the style rules (no ternary, braces always, `===`,
  one statement per line, function declarations, explicit return and boundary types, strict
  boolean expressions, exhaustive switches, and the `no-restricted-syntax` bans), and since the
  Part 2 setup PR the Part 2 rules (see "Part 2" below).
- Deferred to Part 2, off in `zodPending` areas: `no-unsafe-argument`, `no-unsafe-assignment`,
  `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`, `consistent-type-assertions`
  and `no-unnecessary-condition`. Each area turned them on as its Zod schemas landed; since the
  Part 2 sender PR every source file has them.
- Tests (`**/__tests__/**/*.ts`) keep every syntax and style ban (`no-restricted-syntax`,
  `no-ternary`, `func-style`, `curly`, `eqeqeq`, `prefer-const`, `no-var`,
  `max-statements-per-line`), the promise rules (`no-floating-promises` catches an un-awaited
  `assertRejects`, `no-misused-promises`, `await-thenable`), `switch-exhaustiveness-check` and
  `no-explicit-any`. They turn off the fixture-typing rules: `no-unsafe-*`,
  `consistent-type-assertions`, `no-non-null-assertion`, `explicit-function-return-type`,
  `explicit-module-boundary-types`, `restrict-template-expressions`, `strict-boolean-expressions`,
  `no-unnecessary-condition`, `no-empty-function`, `unbound-method`, `require-await` and
  `no-confusing-void-expression`.

The tests glob matches exactly the three test directories: all 68 files under
`supabase/functions/_shared/__tests__/` (55), `inbound/__tests__/` (8) and `sender/__tests__/` (5),
helpers included (`fake_supabase.ts`, `zip_server.ts`, `construct_client.ts`), and none of the
other 91. `supabase/functions/send-test/index.ts` and `supabase/functions/_shared/handlers/test_delivery.ts`
are source and get the full rules. No other test-looking path exists in the four directories
(no `tests/` or `test/` directory, no `*_test.ts`, no `*.test.ts` outside `__tests__`).

## Areas

Every `.ts` file in the four directories is in exactly one area (159 files, no orphans, checked
by matching each file against the globs).

| Area | Files | A merge auto-deploys | Edge Functions expected to be affected |
| --- | --- | --- | --- |
| ingest | 34 | inbound (it loads most of these modules), sender (`_shared/hmac.ts`) | all 19, since every function loads `_shared/db.ts` |
| archive | 12 | inbound (`_shared/uls.ts`) | all 19 through `cty.ts` and `uls.ts`; archive, convert-archive and import-cty have the most at stake |
| handlers | 67 | nothing | all 19 (every entrypoint and its handler) |
| delivery | 15 | sender | api, send-test |
| inbound | 19 | inbound | none |
| sender | 10 | sender | none |
| scripts | 2 | nothing | none (fixed in the tooling PR, never pending) |

The 19 functions are api, archive, band-map, callsign-profile, convert-archive, delete-account,
group-page, health, import-cty, ingest-aprs, ingest-dxcluster, ingest-pota, ingest-rbn,
ingest-sotawatch, ingest-wwff, load-licenses, inbound-status, send-test and sign-in. Work out the
real list for a PR with `deno info --json --config supabase/functions/<fn>/deno.json
supabase/functions/<fn>/index.ts` and the changed files.

Globs:

- **ingest**: `_shared/{pota,sotawatch,wwff,dxcluster,rbn,rbn_push,aprs,inbound_lines,ingest,normalize,modes,bands,hash,strip_nul,types,db,http,hmac}.ts`
  and their tests in `_shared/__tests__/` (`aprs`, `bands`, `db`, `dxcluster`, `hash`, `http`,
  `ingest`, `modes`, `normalize`, `pota`, `rbn`, `rbn_push`, `inbound_lines`, `sotawatch`,
  `strip_nul`, `wwff`).
- **archive**: `_shared/{archive,archive_convert,archive_store,s3,cty,uls}.ts` and their tests.
- **handlers**: `_shared/handlers/*.ts`, `_shared/api/*.ts`, `supabase/functions/*/index.ts`,
  `_shared/{serve,serve_ingest,cors,auth,timing,signin}.ts`, and the tests `api_routes`,
  `api_token`, `app_config`, `auth`, `cors`, `function_config`, every `handlers_*`, `openapi`,
  `profile_lock_db`, `serve`, `serve_ingest`, `signin`, `timing`, plus the helper
  `fake_supabase.ts`.
- **delivery**: `_shared/delivery/*.ts` and the tests `delivery_*`, `pinned_http`, `webpush`.
- **inbound**: `inbound/*.ts`, `inbound/__tests__/*.ts`.
- **sender**: `sender/*.ts`, `sender/__tests__/*.ts`.

New files later setup PRs add (`errors.ts`, `validate.ts` and their tests) are outside every area
and are written lint-clean under the full rules.

## Measured counts

Measured on the tooling PR with `pendingStyle` emptied (scripts/ before its fix), with and without
the tests block.

By area:

| Area | Source | Tests (block on) | Tests (block off) | Total on | Total off |
| --- | ---: | ---: | ---: | ---: | ---: |
| ingest | 226 | 368 | 432 | 594 | 658 |
| archive | 165 | 186 | 253 | 351 | 418 |
| handlers | 317 | 498 | 615 | 815 | 932 |
| delivery | 312 | 534 | 641 | 846 | 953 |
| inbound | 245 | 289 | 431 | 534 | 676 |
| sender | 147 | 154 | 216 | 301 | 363 |
| scripts | 24 | 0 | 0 | 24 | 24 |
| **Total** | 1,436 | 2,029 | 2,588 | 3,465 | 4,024 |

By rule:

| Rule | Block on | Block off |
| --- | ---: | ---: |
| `no-restricted-syntax` | 2,175 | 2,175 |
| `curly` | 485 | 485 |
| `no-ternary` | 251 | 251 |
| `strict-boolean-expressions` | 180 | 234 |
| `func-style` | 109 | 109 |
| `restrict-template-expressions` | 105 | 188 |
| `explicit-function-return-type` | 62 | 257 |
| `no-unused-vars` | 25 | 25 |
| `no-confusing-void-expression` | 20 | 31 |
| `no-non-null-assertion` | 19 | 216 |
| `no-unnecessary-type-assertion` | 14 | 14 |
| `no-misused-promises` | 4 | 4 |
| `prefer-promise-reject-errors` | 3 | 3 |
| `explicit-module-boundary-types` | 2 | 4 |
| `use-unknown-in-catch-callback-variable` | 2 | 2 |
| `no-unnecessary-type-conversion` | 2 | 2 |
| `unbound-method` | 1 | 18 |
| `no-floating-promises`, `no-base-to-string`, `no-invalid-void-type`, `no-useless-default-assignment`, `only-throw-error`, `restrict-plus-operands` | 1 each | 1 each |

`no-restricted-syntax` by pattern: block-bodied arrow 984, spread 319, object destructuring 285,
`??` 242, `?.` 239, array destructuring 83, `.reduce` 11, `.then` 9, `??=` 3.

The 25 `no-unused-vars` hits are `_`-prefixed names (typescript-eslint, unlike `deno lint`, does
not exempt them): 16 are rest-destructuring omissions in `delivery/format.ts` and `s3.ts` that go
with the destructuring fix, and the rest are unused parameters and destructured names in tests.

## Canary

A planted `supabase/functions/_canary/index.ts` (linted with `--no-ignore`, then deleted) had an
un-awaited async call, a ternary, a destructuring, a `?.`, a `??`, `Deno.env.get(...)`,
`createClient` from `@supabase/supabase-js`, `assertEquals` from `@std/assert` and an `as` cast:

```
supabase/functions/_canary/index.ts
  16:3   error  Promises must be awaited, ...            @typescript-eslint/no-floating-promises
  17:16  error  Ternary operator used                    no-ternary
  18:9   error  No destructuring. Access fields directly no-restricted-syntax
  19:16  error  No optional chaining. Check null with if no-restricted-syntax
  20:17  error  No ??. Check null with if                no-restricted-syntax

5 problems (5 errors, 0 warnings)
```

The `as` cast did not error (deferred). With the five `no-unsafe-*` rules and
`no-unnecessary-condition` turned back on, the output was the same, so `Deno`, supabase-js and
`@std/assert` all resolve to real types; a `JSON.parse("{}").x` control line did report
`no-unsafe-assignment` and `no-unsafe-member-access`.

## Setup deviations

- **`--no-error-on-unmatched-pattern` in `npm run lint`.** While every file under
  `supabase/functions`, `inbound` or `sender` is pending, ESLint stops with "all of the files
  matching the glob pattern are ignored". The Part 2 setup PR dropped it, `pendingStyle` being
  gone.
- **`@types/node` and `"types": ["node"]` in `tsconfig.json`.** Deno takes `setTimeout` and
  `clearTimeout` (returning `Timeout`) from its bundled Node types, which `deno types` leaves out;
  without them `tsc` cannot find either.
- **`"nodeModulesDir": "none"` in the root `deno.json`.** With a root `package.json`, Deno looked
  for npm packages in `node_modules`, so a fresh clone failed `deno task check` and `deno task
  test` until `npm ci` ran. Deno also records package.json's dependencies in `deno.lock`, which
  now carries them; dev dependencies are pinned exactly so that resolution stays fixed.
- **`deno.d.ts` and `node_modules/` are excluded** in the root `deno.json`'s `lint` and `fmt`.
- **jiti** is required: ESLint 10 will not load `eslint.config.ts` without it.
- **`tsc -p .`** reports nothing from `deno.d.ts`. It reports 8 errors, all in
  `_shared/__tests__/profile_lock_db.test.ts`, which imports `npm:postgres@3.4.9` instead of the
  bare `postgres` the root `deno.json` already maps. The handlers PR should change that import.
- **The fmt width for inbound/ and sender/** is not fixed (see "Formatting inbound/ and sender/ on
  their own"): this PR does not touch either app, and their `deno.json` may hold only an import
  map.

Root `package.json` checks, in a fresh clone with no `node_modules`: `deno task check` and
`deno task test` (720 passed) pass, and `supabase functions serve` serves ingest-pota (403 from
its own handler for the anon key), health (200 with the payload) and api (401 from its handler).
Both images build, and their exported filesystems match images built from `origin/main`
file for file.

## Part 2: Zod and errors

### The config

The Part 2 setup PR turned on, in the main block, `no-empty`, `preserve-caught-error` (given our
three error class names, since it checks only the built-in ones otherwise) and six more
`no-restricted-syntax` bans: `z.object`, `z.any()`/`z.unknown()`, `z.infer`, default parameter
values, optional parameters and hand-written type guards (`value is T`). The bans are two named
arrays, `styleSyntax` (Part 1's) and `zodSyntax` (the six new ones), and the main block uses both.

- `zodPending` listed the six areas (the same globs as "Areas" below). Its block turned off the seven
  deferred rules, `no-empty` and `preserve-caught-error`, and set `no-restricted-syntax` to
  `styleSyntax` alone, so pending files kept every Part 1 rule. scripts/ and the new
  `_shared/errors.ts`, `_shared/validate.ts` and their tests are outside it and get the full rules.
- The surface PR moved the default-parameter and optional-parameter selectors from `zodSyntax`
  into `styleSyntax`, the list the pending block keeps, so they apply everywhere. `zodSyntax` now
  holds the four Zod and type-guard bans.
- Each Part 2 area PR removed its globs from `zodPending`. The sender PR, the last area, deleted
  the emptied list and its block.
- The wrap-up PR gave `preserve-caught-error` every error class name in the code: errors.ts's
  four and the module-local ones. A new class's name goes in that list.
- The tests block keeps the narrowing rules off for good.

### Interfaces

Every data shape is an interface; unions and function types stay `type`. Each external shape is an
interface plus a schema annotated `z.ZodType<ThatInterface>`, next to the code that reads it.
Never use `z.infer`.

### Strict or loose

Use `z.strictObject` for request bodies and our own Edge Function replies. Use `z.looseObject`
for third-party feeds and replies, and for DB/RPC jsonb that can gain keys across deploys, with a
one-line comment saying which of those it is. A key the code reads with a fallback is
`.optional()`, which keeps "ship in either order" working.

### Validation

1. Assign raw input to `unknown` first.
2. Validate with `parseWith(schema, raw, "<function>: <input>")` from `_shared/validate.ts`,
   which runs `safeParse` and throws `ValidationError` with the `ZodError` as cause.
3. The `as` casts and hand checks it replaces are deleted.
4. Store raw payloads (`raw_payload`, archives) from the raw `unknown`, never from parsed output.

### Where feed validation goes

`parseFeed` checks only the envelope (an array of `unknown`). Each spot is validated in
`normalize`, so one bad spot becomes one `ingest_failures` row.

### Refinements

Add a refinement only where the existing code already enforces the constraint. Never tighten what
the code tolerates today: SOTAwatch `type` null, POTA `spotTime` without a zone, QRT null
frequency. Every refinement that could reject data accepted today goes in the PR body.

### Errors

Use `_shared/errors.ts` (`ValidationError` with `where`, `FunctionCallError` with `status`,
`ConfigError`, and since the wrap-up `TimeoutError`). Area PRs never edited it; the wrap-up added
`TimeoutError` when three modules had a class of their own for it (see "Wrap-up"). Constructors are `(message, { cause, ...context })`. Add
context by wrapping: `throw new X("...", { cause: caught })`.

### Boundaries

Boundaries are the only places with `catch`:

- request handlers (`_shared/handlers/*`, `serve.ts`, `serve_ingest.ts`, entrypoints);
- per-item isolation that CLAUDE.md requires: `runIngest` per spot into `ingest_failures`,
  `runDeliveryBatch` per destination into mark/throttle, archive per slice;
- process loops: inbound connect and forward loops, sender cycle, watchdog, best-effort heartbeats
  (CLAUDE.md: "logged, never retried");
- shutdown paths.

A boundary catch handles specific classes with `instanceof`, then either does the
CLAUDE.md-mandated record-and-continue or rethrows / answers 500. Elsewhere, use non-throwing APIs
(`URL.canParse`, `safeParse`) or move the catch to the boundary. If neither keeps behavior, keep a
narrow `instanceof` catch with a comment and list it in the PR. `finally` is allowed anywhere.

### Behavior

Requests, responses and status codes stay the same. Error types and messages may change. A
`ValidationError` on request input answers with the status that input used to get.

### Surface

Area chats keep the surface the surface PR left, with two exceptions: they may turn an exported
object type into an interface of the same shape, and they may add exported interfaces and schemas
in their own files.

The surface PR removed every default and optional parameter in the four directories, tests
included, and in function types and interface methods too (`FunctionClient.push`,
`StatusLoop.post`, `SqlClient.end`), which the selector does not reach. Callers pass every
argument: the old default where there was one, `undefined` where the parameter was optional.
Options objects keep their optional fields; a caller with none passes `{}`. One client became a
class: the inbound worker's `FunctionPoster` (`inbound/functions.ts`). Every `create*` factory stayed a
factory.

### Unknown shapes

Derive each schema from its producer: the SQL function, the handler or the fixture. If none can
be found, write `// TODO: confirm shape` and list it in the PR.

### Measured counts

Measured on the setup PR with `zodPending` temporarily emptied (the tests block on): 351 errors,
261 in sources and 90 in tests. scripts/ (1, a default parameter) was fixed in the PR; the new
modules have none.

By area:

| Area | Source | Tests | Total |
| --- | ---: | ---: | ---: |
| ingest | 30 | 7 | 37 |
| archive | 31 | 8 | 39 |
| handlers | 65 | 44 | 109 |
| delivery | 51 | 12 | 63 |
| inbound | 54 | 11 | 65 |
| sender | 30 | 8 | 38 |
| **Total** | 261 | 90 | 351 |

By rule:

| Rule | Errors |
| --- | ---: |
| `no-restricted-syntax` | 154 |
| `no-unnecessary-condition` | 132 |
| `consistent-type-assertions` | 60 |
| `preserve-caught-error` | 3 |
| `no-unsafe-return` | 2 |

`no-restricted-syntax` by pattern: default parameter 120, optional parameter 27, hand-written type
guard 7. No `no-empty` hits, and no `z.` hits (nothing imports zod yet).

Default and optional parameters by file (default, optional), 147 in 69 files:

| File | Default | Optional |
| --- | ---: | ---: |
| `inbound/__tests__/forwarder.test.ts` | 1 | 0 |
| `inbound/__tests__/licenses.test.ts` | 3 | 0 |
| `inbound/__tests__/modules.test.ts` | 1 | 2 |
| `inbound/__tests__/zip.test.ts` | 0 | 1 |
| `inbound/__tests__/zip_server.ts` | 2 | 1 |
| `inbound/functions.ts` | 2 | 2 |
| `inbound/health.ts` | 1 | 0 |
| `inbound/main.ts` | 1 | 0 |
| `inbound/inbound.ts` | 1 | 0 |
| `inbound/telnet.ts` | 1 | 0 |
| `inbound/zip.ts` | 3 | 1 |
| `sender/__tests__/db.test.ts` | 1 | 1 |
| `sender/__tests__/sender.test.ts` | 6 | 0 |
| `sender/config.ts` | 0 | 1 |
| `sender/db.ts` | 1 | 0 |
| `sender/health.ts` | 1 | 0 |
| `sender/sender.ts` | 1 | 0 |
| `_shared/__tests__/aprs.test.ts` | 1 | 0 |
| `_shared/__tests__/archive.test.ts` | 2 | 0 |
| `_shared/__tests__/archive_convert.test.ts` | 3 | 1 |
| `_shared/__tests__/archive_store.test.ts` | 1 | 0 |
| `_shared/__tests__/auth.test.ts` | 0 | 1 |
| `_shared/__tests__/cty.test.ts` | 1 | 0 |
| `_shared/__tests__/delivery_format.test.ts` | 5 | 0 |
| `_shared/__tests__/delivery_run.test.ts` | 5 | 0 |
| `_shared/__tests__/delivery_send.test.ts` | 2 | 0 |
| `_shared/__tests__/dxcluster.test.ts` | 1 | 0 |
| `_shared/__tests__/fake_supabase.ts` | 1 | 1 |
| `_shared/__tests__/handlers_api.test.ts` | 4 | 1 |
| `_shared/__tests__/handlers_archive.test.ts` | 1 | 3 |
| `_shared/__tests__/handlers_band_map.test.ts` | 1 | 0 |
| `_shared/__tests__/handlers_callsign_profile.test.ts` | 3 | 1 |
| `_shared/__tests__/handlers_convert_archive.test.ts` | 0 | 2 |
| `_shared/__tests__/handlers_delete_account.test.ts` | 2 | 0 |
| `_shared/__tests__/handlers_group_page.test.ts` | 3 | 0 |
| `_shared/__tests__/handlers_health.test.ts` | 1 | 0 |
| `_shared/__tests__/handlers_import_cty.test.ts` | 0 | 1 |
| `_shared/__tests__/handlers_load_licenses.test.ts` | 3 | 0 |
| `_shared/__tests__/handlers_inbound_status.test.ts` | 4 | 0 |
| `_shared/__tests__/handlers_sign_in.test.ts` | 4 | 0 |
| `_shared/__tests__/handlers_test_delivery.test.ts` | 3 | 0 |
| `_shared/__tests__/ingest.test.ts` | 2 | 0 |
| `_shared/__tests__/profile_lock_db.test.ts` | 0 | 1 |
| `_shared/__tests__/rbn.test.ts` | 1 | 0 |
| `_shared/__tests__/rbn_push.test.ts` | 2 | 0 |
| `_shared/__tests__/serve.test.ts` | 1 | 1 |
| `_shared/__tests__/serve_ingest.test.ts` | 0 | 1 |
| `_shared/api/routes.ts` | 2 | 1 |
| `_shared/aprs.ts` | 1 | 0 |
| `_shared/archive.ts` | 2 | 0 |
| `_shared/cors.ts` | 4 | 0 |
| `_shared/cty.ts` | 1 | 0 |
| `_shared/db.ts` | 0 | 1 |
| `_shared/delivery/format.ts` | 3 | 0 |
| `_shared/delivery/run.ts` | 1 | 0 |
| `_shared/delivery/send.ts` | 5 | 0 |
| `_shared/delivery/urlsafety.ts` | 1 | 0 |
| `_shared/delivery/webpush.ts` | 1 | 1 |
| `_shared/dxcluster.ts` | 1 | 0 |
| `_shared/handlers/api.ts` | 1 | 0 |
| `_shared/handlers/archive.ts` | 1 | 0 |
| `_shared/handlers/callsign_profile.ts` | 1 | 0 |
| `_shared/handlers/convert_archive.ts` | 1 | 0 |
| `_shared/handlers/test_delivery.ts` | 2 | 0 |
| `_shared/http.ts` | 2 | 0 |
| `_shared/ingest.ts` | 1 | 0 |
| `_shared/rbn_push.ts` | 1 | 0 |
| `_shared/s3.ts` | 4 | 1 |
| `_shared/timing.ts` | 1 | 0 |

### Canary

A planted `supabase/functions/_shared/_canary.ts`, outside `zodPending`, with `z.object(...)`,
`z.any()`, `z.infer<...>`, a default parameter, an optional parameter, a `value is T` guard, an
empty `catch {}`, a catch throwing `new Error` without `{ cause }`, an `as` cast, a member access
on `JSON.parse`'s result, and `z.looseObject(...)` and `z.strictObject(...)` (lines 32 and 33):

```
   3:11  error  Use z.strictObject, not z.object                                       no-restricted-syntax
   4:11  error  No z.any() or z.unknown(). Describe the real shape                     no-restricted-syntax
   5:10  error  Declare the interface explicitly and annotate the schema as z.ZodType  no-restricted-syntax
   6:29  error  No default parameter values. Pass every argument explicitly            no-restricted-syntax
   9:30  error  No optional parameters. Use T | undefined and pass undefined explicitly no-restricted-syntax
  12:39  error  No hand-written type guards. Validate with a Zod schema                no-restricted-syntax
  18:11  error  Empty block statement                                                  no-empty
  24:5   error  There is no `cause` attached to the symptom error being thrown         preserve-caught-error
  27:21  error  Do not use any type assertions                                         @typescript-eslint/consistent-type-assertions
  29:9   error  Unsafe assignment of an `any` value                                    @typescript-eslint/no-unsafe-assignment
  30:22  error  Unsafe member access .field on an `any` value                          @typescript-eslint/no-unsafe-member-access
```

(plus two `no-unused-vars` and a `no-unnecessary-type-assertion` from the canary itself). The
same file under `inbound/`, a pending area, reported only those three.

A second canary threw our classes inside a catch. `throw new ValidationError("...", { cause:
caught, where: "..." })` passed; the same without `cause` reported `missingCause`, and
`FunctionCallError` / `ConfigError` with `cause: undefined` reported `incorrectCause`. Before the
config named the classes (`errorClassNames`), the rule reported none of them. Both canaries were
deleted.

### Setup deviations

- **zod is mapped as `npm:zod@4.6.7`, not `npm:zod@4`.** 4.6.7 is what Deno resolves for
  `npm:zod@4`. `app_config.test.ts` requires the inbound worker's and the sender's mappings to equal the
  root's and to be exact versions (the images have no `deno.lock`), so the root and every
  function's `deno.json` use the exact version too.
- **The inbound worker's and the sender's `deno.json` map zod before either loads it**, so the Part 2
  areas can import it without touching the app configs.
- **`preserve-caught-error` takes `errorClassNames`** (see "Canary").

## Wrap-up

The last PR of the effort (2026-10-26). `zodPending` was already gone (the Part 2 sender PR);
`npm run lint` reported 0 before and after.

- **One shared class.** `TimeoutError` joined `errors.ts`: the sender's `withTimeout` had its own,
  and the inbound worker threw `LicenseImportError` and `ZipError` for the same thing (a download with no
  data, a range request with no headers in time). `LicenseImportError` now means only an abort and
  `ZipError` only a zip that cannot be read. The other module-local classes each mean something no
  other does and stay where they are, all with errors.ts's `(message, { cause })` constructor.
- **One schema per producer.** send-test reads the test RPCs with the claim's schemas
  (`delivery/types.ts`), so a webhook header whose Vault value no longer decrypts is skipped in a
  test as in a delivery; db.ts and the inbound worker read `fcc_license_load_status` with
  `licenseLoadSchema` (`uls.ts`).
- **`preserve-caught-error`** names every error class in the code.
- **Left as they are, on purpose:** hand-thrown `ValidationError` messages do not repeat `where`
  (it is in the context; `parseWith`'s do); schemas that read timestamps and counts as plain
  strings and numbers were not tightened, since that could refuse data accepted today.
