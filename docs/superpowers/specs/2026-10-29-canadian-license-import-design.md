# Canadian Callsign Import: Design Specification

## Overview
Add periodic import support for Canadian amateur radio callsigns published by Innovation, Science and Economic Development Canada (ISED) via `https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip` containing `amateur_delim.txt`.

## Decisions & Architecture

### 1. Authority, Country & Staging
- **Authority:** `'ISED'` (agency name, matching `'FCC'` for United States).
- **Country:** `'CA'` (ISO 3166-1 alpha-2).
- **Staging Table:** `ised_amateur_stage` (unlogged table).
- **RPCs:** `ised_license_load_status`, `ised_license_load_begin`, `ised_license_load_rows`, `ised_license_staged_counts`, `ised_license_load_finish`, `ised_license_load_abandon`.
- **Apply Function & Cron:** Instead of adding a separate cron job at :55, extend `apply_license_loads()` to process both `'FCC'` and `'ISED'` authorities (or invoke them in sequence), keeping the existing hourly cron schedule at :50.

### 2. Privacy & Data Handling
- **Dropped Fields:** Address lines, city, postal codes, and club address details are strictly omitted (matching CLAUDE.md mandate).
- **Stored Fields:** Callsign, name (club name if present, else `first_name` + `surname`), first name, last name (surname), province (`prov_cd` mapped to `state`), qualifications (`qual_a` through `qual_e` mapped to `operator_class`), status (`'Active'`), country (`'CA'`).

### 3. Qualification Mapping (`operator_class`)
- Canadian amateur certificates grant qualifications:
  - `qual_a`: Basic Qualification
  - `qual_b`: 5 WPM Morse
  - `qual_c`: 12 WPM Morse
  - `qual_d`: Advanced Qualification
  - `qual_e`: Honours Basic / other qualifications
- Active qualification letters are collected and formatted as a comma-separated list (e.g. `"A, C, D"`), or mapped to friendly labels if appropriate.

### 4. Encoding
- `amateur_delim.txt` contains French names with diacritics and must be decoded using `ISO-8859-1` (Latin-1) or `Windows-1252`.

### 5. Inbound Worker & Floor
- **Source URL:** `https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip` (`INBOUND_CANADIAN_LICENSES` env var).
- **Record Floor:** `MIN_CANADIAN_RECORDS = 70_000` (checked in `inbound/canadian_licenses.ts` before calling `finish`).
- **Download:** Plain GET (cached fixture used in testing).

### 6. Web & Profile Copy
- Authority-aware subheader and message:
  - For Canadian callsigns (`usPrefix: false`), the License card subheader reads: `"From Innovation, Science and Economic Development Canada. Refreshed weekly."`
  - `noLicenseMessage` when no record is found: `"No ISED record. This looks like a callsign issued outside Canada and the United States."` (or similar authority-aware messaging).
- Update `CallsignProfile` type, web fixtures, and pgTAP tests.

### 7. Deliveries
- Spot notifications and webhook messages automatically populate `first_name` and `last_name` for Canadian (VE/VA/VO/VY) stations via `spot_license_name()`.
