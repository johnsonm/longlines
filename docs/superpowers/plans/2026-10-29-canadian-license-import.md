# Canadian License Import: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Revision 2, 2026-10-29. Based on design spec `docs/superpowers/specs/2026-10-29-canadian-license-import-design.md`.

**Goal:** Add periodic import support for Canadian amateur radio callsigns from Innovation, Science and Economic Development Canada (ISED) via `https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip` containing `amateur_delim.txt`, integrating with `callsign_licenses` (using authority `'ISED'`, country `'CA'`) and the inbound worker loop.

**Architecture:**
- **Inbound Worker:** Periodic check every 6 hours via HTTP HEAD and GET against `amateur_delim.zip`, streaming `amateur_delim.txt` decoded as Latin-1 (`ISO-8859-1`).
- **Parser (`_shared/canadian_licenses.ts`):** Parses semicolon-delimited CSV with header row:
  `callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code`
- **Edge Function (`load-canadian-licenses`):** Stages rows into `ised_amateur_stage` via RPCs (`ised_license_load_*`), enforcing minimum record floor (`MIN_CANADIAN_RECORDS = 70_000`).
- **Database (`callsign_licenses`, `license_loads`):** Extended `apply_license_loads()` handles both `'FCC'` and `'ISED'` authorities atomically during the hourly cron run at :50.

**Tech Stack:** Deno, TypeScript, Postgres (plpgsql, pgTAP), React 19, MUI 9.

---

## Tasks

- [ ] **Task 1: Shared Canadian License Parser & Types**
  - [ ] Implement `supabase/functions/_shared/canadian_licenses.ts` with Latin-1 line decoding, semicolon CSV parsing, qualification mapping, and Zod schemas.
  - [ ] Add unit tests in `supabase/functions/_shared/__tests__/canadian_licenses.test.ts`.

- [ ] **Task 2: Database Migration for ISED Licenses**
  - [ ] Create migration `supabase/migrations/20261029000900_canadian_licenses.sql`:
    - `ised_amateur_stage` unlogged table.
    - Staging and load lifecycle RPCs (`ised_license_load_status`, `ised_license_load_begin`, `ised_license_load_rows`, `ised_license_staged_counts`, `ised_license_load_finish`, `ised_license_load_abandon`).
    - Extend `apply_license_loads()` to swap finished `'ISED'` loads into `callsign_licenses`.
  - [ ] Add pgTAP tests in `supabase/tests/canadian_licenses.test.sql`.

- [ ] **Task 3: Edge Function (`load-canadian-licenses`)**
  - [ ] Implement `supabase/functions/load-canadian-licenses/index.ts` and `supabase/functions/_shared/handlers/load_canadian_licenses.ts`.
  - [ ] Update `supabase/config.toml` with `[functions.load-canadian-licenses]`.
  - [ ] Add handler tests in `supabase/functions/_shared/__tests__/handlers_load_canadian_licenses.test.ts`.

- [ ] **Task 4: Inbound Worker & Config**
  - [ ] Update `inbound/config.ts` with `CANADIAN_AMATEUR_ZIP` and `INBOUND_CANADIAN_LICENSES`.
  - [ ] Implement `inbound/canadian_licenses.ts` (streaming zip, Latin-1 decoder, batching to `load-canadian-licenses`).
  - [ ] Wire into `inbound/inbound.ts`, update `inbound/Dockerfile` (`--allow-env`), and add inbound tests.

- [ ] **Task 5: Web UI & Profile Copy Updates**
  - [ ] Update `web/src/profile/types.ts` and `web/src/profile/CallsignPage.tsx` / `format.ts` to support authority-aware subheaders ("From Innovation, Science and Economic Development Canada. Refreshed weekly.") and non-US/non-Canadian fallback messages.
  - [ ] Update web fixtures and unit tests.

- [ ] **Task 6: Documentation & Validation**
  - [ ] Update `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, and `CLAUDE.md`.
  - [ ] Run `deno task test`, `supabase test db`, `deno task check`, `deno task lint`, `npm run lint`, `npm run typecheck`.
