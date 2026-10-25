# Strict ESLint for the Deno code: conventions

Date: 2026-10-22. Status: **in progress**. Part 1 (style, enforced by ESLint) lands as one tooling
PR (0b) and one PR per area; Part 2 (Zod at every external boundary and a strict error style)
follows the same areas. Brad merges them one at a time: 0a runtime config, 0b tooling, Part 1
ingest, archive, handlers, delivery, relay, sender, then Part 2 setup, surface, the same six
areas, and a wrap-up. Each PR's chat stays inside its own files.

The aim is plain, explicit, Go-style TypeScript in `supabase/functions`, `relay/`, `sender/` and
`scripts/`. The rules are in `eslint.config.ts`; CLAUDE.md's "TypeScript (supabase/functions,
relay, sender, scripts)" section is the short version.

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
module: the function's own, `relay/deno.json` or `sender/deno.json`.

### Lint configuration

Never add `eslint-disable`. Never edit `eslint.config.ts`, `tsconfig.json` or the `package.json`
scripts, except to remove your own area from the ratchet list. If a rule seems wrong, report the
rule, file:line and the reason.

### Comments

Add a short comment above anything non-obvious and match the surrounding density. No emojis.

### Gates, per file group

- `npx eslint --max-warnings 0 --no-inline-config <owned paths>` reports 0 errors.
- `npm run typecheck`, `deno task check`, `deno task lint`,
  `deno fmt --check supabase/functions scripts relay sender deno.json` and `deno task test` pass.
- `deno task coverage` stays at or above 80% at the end.

Commit each group.

### Formatting relay/ and sender/ on their own

`relay/deno.json` and `sender/deno.json` hold only an import map (`app_config.test.ts` enforces
it), so `deno fmt relay` or `deno fmt sender/db.ts` picks up the nearest config and formats at
width 80, not 100. The CI command passes because `supabase/functions` comes first. When
formatting only relay or sender files, pass the root config:
`deno fmt --config deno.json relay sender`.

## The config

- `pendingStyle` in `eslint.config.ts` lists every area whose Part 1 PR has not merged, sources
  and tests. Pending files are ignored outright. The PR that fixes an area removes its globs, and
  nothing else edits the list; it goes once it is empty.
- The main block is `strictTypeChecked` plus the style rules (no ternary, braces always, `===`,
  one statement per line, function declarations, explicit return and boundary types, strict
  boolean expressions, exhaustive switches, and the `no-restricted-syntax` bans).
- Deferred to Part 2, off everywhere for now: `no-unsafe-argument`, `no-unsafe-assignment`,
  `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`, `consistent-type-assertions`
  and `no-unnecessary-condition`. Each area turns them on as its Zod schemas land.
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
`supabase/functions/_shared/__tests__/` (55), `relay/__tests__/` (8) and `sender/__tests__/` (5),
helpers included (`fake_supabase.ts`, `zip_server.ts`, `construct_client.ts`), and none of the
other 91. `supabase/functions/send-test/index.ts` and `supabase/functions/_shared/handlers/test_delivery.ts`
are source and get the full rules. No other test-looking path exists in the four directories
(no `tests/` or `test/` directory, no `*_test.ts`, no `*.test.ts` outside `__tests__`).

## Areas

Every `.ts` file in the four directories is in exactly one area (159 files, no orphans, checked
by matching each file against the globs).

| Area | Files | A merge auto-deploys | Edge Functions expected to be affected |
| --- | --- | --- | --- |
| ingest | 34 | relay (it loads most of these modules), sender (`_shared/hmac.ts`) | all 19, since every function loads `_shared/db.ts` |
| archive | 12 | relay (`_shared/uls.ts`) | all 19 through `cty.ts` and `uls.ts`; archive, convert-archive and import-cty have the most at stake |
| handlers | 67 | nothing | all 19 (every entrypoint and its handler) |
| delivery | 15 | sender | api, send-test |
| relay | 19 | relay | none |
| sender | 10 | sender | none |
| scripts | 2 | nothing | none (fixed in the tooling PR, never pending) |

The 19 functions are api, archive, band-map, callsign-profile, convert-archive, delete-account,
group-page, health, import-cty, ingest-aprs, ingest-dxcluster, ingest-pota, ingest-rbn,
ingest-sotawatch, ingest-wwff, load-licenses, relay-status, send-test and sign-in. Work out the
real list for a PR with `deno info --json --config supabase/functions/<fn>/deno.json
supabase/functions/<fn>/index.ts` and the changed files.

Globs:

- **ingest**: `_shared/{pota,sotawatch,wwff,dxcluster,rbn,rbn_push,aprs,relay_lines,ingest,normalize,modes,bands,hash,strip_nul,types,db,http,hmac}.ts`
  and their tests in `_shared/__tests__/` (`aprs`, `bands`, `db`, `dxcluster`, `hash`, `http`,
  `ingest`, `modes`, `normalize`, `pota`, `rbn`, `rbn_push`, `relay_lines`, `sotawatch`,
  `strip_nul`, `wwff`).
- **archive**: `_shared/{archive,archive_convert,archive_store,s3,cty,uls}.ts` and their tests.
- **handlers**: `_shared/handlers/*.ts`, `_shared/api/*.ts`, `supabase/functions/*/index.ts`,
  `_shared/{serve,serve_ingest,cors,auth,timing,signin}.ts`, and the tests `api_routes`,
  `api_token`, `app_config`, `auth`, `cors`, `function_config`, every `handlers_*`, `openapi`,
  `profile_lock_db`, `serve`, `serve_ingest`, `signin`, `timing`, plus the helper
  `fake_supabase.ts`.
- **delivery**: `_shared/delivery/*.ts` and the tests `delivery_*`, `pinned_http`, `webpush`.
- **relay**: `relay/*.ts`, `relay/__tests__/*.ts`.
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
| relay | 245 | 289 | 431 | 534 | 676 |
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
  `supabase/functions`, `relay` or `sender` is pending, ESLint stops with "all of the files
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
- **The fmt width for relay/ and sender/** is not fixed (see "Formatting relay/ and sender/ on
  their own"): this PR does not touch either app, and their `deno.json` may hold only an import
  map.

Root `package.json` checks, in a fresh clone with no `node_modules`: `deno task check` and
`deno task test` (720 passed) pass, and `supabase functions serve` serves ingest-pota (403 from
its own handler for the anon key), health (200 with the payload) and api (401 from its handler).
Both images build, and their exported filesystems match images built from `origin/main`
file for file.
