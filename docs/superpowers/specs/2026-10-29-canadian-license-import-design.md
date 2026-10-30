# Canadian licenses (ISED)

Date: 2026-10-29 (revision 2: facts checked against the published file the same day)

## Goal

Callsign profiles and the First name / Last name delivery fields cover Canadian calls as they
cover US ones, from the amateur certificate list Innovation, Science and Economic Development
Canada (ISED) publishes. `callsign_licenses` was built for this: one row per callsign with its
issuing authority, "so other countries' registries can load into it later"
(`20261012000050_callsign_licenses.sql`).

## Decisions

Proposed in this revision; the ones marked (Brad) are product calls to confirm before Task 5.

| Question | Decision |
| --- | --- |
| Authority, country | `authority = 'ISED'` (the agency, as `'FCC'` is), `country = 'CA'`. |
| Names | Everything ISED-specific is `ised`: `_shared/ised.ts`, `inbound/ised_licenses.ts`, the `load-ised-licenses` function, `ised_amateur_stage`, `ised_license_load_*`, `INBOUND_ISED_LICENSES`. Never "ULS" (the FCC's system) and never "canadian" in one place and "ised" in another. |
| Cadence | Weekly, like the reference lists: the file changes nightly, so the inbound worker HEADs it once a day and loads only when the last applied ISED load began at least a week ago and `Last-Modified` is newer. "Refreshed weekly" stays true. |
| Floor | SQL's, as `reference_load_floor` is: `ised_license_load_finish` refuses a load with fewer rows than 90% of the current ISED rows, or 80,000 on a first load. The file holds 92,175 today. |
| Swap | `apply_license_loads()` (cron `apply-license-loads`, :50, unchanged) applies the newest ready load of each authority, FCC then ISED, each in its own exception block so a failed ISED swap never blocks the FCC one. No new cron job. |
| Clubs | A row with a club name is a club: `name` is the club name (`club_name` and `club_name_2` joined with a space), `first_name`, `last_name` and `operator_class` are null. The file names the club's trustee in the person fields; that name is not stored. This keeps `spot_license_name`'s "none for a club". |
| Qualifications (Brad) | `operator_class` reads, in this order: `Advanced` if D; then `Basic with Honours` if E, else `Basic` if A; then `12 WPM` if C, else `5 WPM` if B; joined with ", ". Examples: "Advanced, Basic with Honours", "Basic, 5 WPM". The longest is "Advanced, Basic with Honours, 12 WPM" (36 characters), which still fits the header chip. The mapping is SQL's (`ised_operator_class`); TypeScript passes the letters. |
| Status, dates | Null. The file has no status and no dates (Canadian certificates do not expire); a status we did not read is not stored. |
| Province | `state` holds `prov_cd` (null when blank: 1,992 rows). The card labels it Province for ISED. |
| Profile copy (Brad) | See "Profile". |

## Upstream

`GET https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip`, no key. HEAD on 2026-10-29 23:56Z:
`Last-Modified: Thu, 29 Oct 2026 06:00:01 GMT`, an `ETag`, `Accept-Ranges: bytes`,
`Content-Length: 2315993` (2.3 MB). The zip holds three entries dated that night:

| Entry | Size | Content |
| --- | --- | --- |
| `amateur_delim.txt` | 6.6 MB | the list |
| `readme_amat_delim.txt` | 347 B | field names (English) |
| `lisezmoi_amat_delim.txt` | 383 B | field names (French) |

`amateur_delim.txt`:

- **UTF-8**, no BOM, CRLF line ends (`file` and `iconv -f UTF-8` agree). 5,459 lines carry
  accented letters (é, É, ç, È, è, ô, ...). Decoding it as Latin-1 would garble every one of them;
  the stock `TextDecoderStream()` (UTF-8) is right.
- One header line, then one record per line, 18 fields separated by `;`, every line 18 fields:
  `callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code`.
  The parser finds columns by header name, never position, as `_shared/reference_catalog.ts` does.
- No quoting: the 34 lines with `"` hold literal quotes (nicknames in `first_name`, quotes in
  addresses and club names). Split on `;`, nothing else. 593 rows have leading or trailing
  spaces in a name field; trim every field.
- 92,175 records, every callsign unique, all `^[A-Z0-9]+$`, at most 6 characters, prefixes VE
  55,822, VA 34,022, VO 1,584, VY 747. Longest given name + surname 62 characters, club name
  fields joined 120.
- Qualification fields hold their own letter or are empty (`qual_a` is `A` or empty, and so on),
  as the readme names them: BASIC (A), 5WPM (B), 12WPM (C), ADVANCED (D), Basic with Honours (E).
  Every record has exactly one of A and E (44,468 and 47,707).
- 3,230 club rows (`club_name` set; 684 also use `club_name_2`). Every one also has a person's
  name, the trustee.
- 21,135 rows have no street address and city; the person fields are still filled.

## Privacy

As with the FCC: only callsign, names, qualifications and province are staged. The staging table
has no column for `address_line`, `city`, `postal_code`, `club_address`, `club_city`,
`club_prov_cd` or `club_postal_code`, the parser never puts them in a row, and
`jsonb_to_recordset` drops any such key a caller sends. A test asserts each of these.

Test fixtures are synthetic: made-up calls, names and addresses in the real layout (accents,
literal quotes, padded names, a club row with `club_name_2`, a blank province, CRLF). Never commit
lines cut from the real file: it holds people's home addresses.

## Shape

The flow is the FCC one with one staging table:

1. The inbound worker (`inbound/ised_licenses.ts`), once a day: `status` through
   `load-ised-licenses`; if the last applied load began less than a week ago, or the HEAD's
   `Last-Modified` is not newer than its version, stop.
2. GET the zip into memory (2.3 MB), read it through an in-memory `RangeSource` with
   `readZipDirectory` / `openZipEntry` (`inbound/zip.ts`, no new zip code), stream
   `amateur_delim.txt` through `TextDecoderStream()` and `IsedRecords`, and post `begin`, `rows`
   (batches of at most `MAX_ROWS_PER_REQUEST`) and `finish` with the row count, or `abandon` on
   failure. An unfinished load retries after twelve hours.
3. `ised_license_load_finish` checks the staged count against the worker's and the floor, and
   marks the load ready; `apply_license_loads()` swaps it in within the hour: delete the ISED rows
   of `callsign_licenses`, insert the staged set, mark the load applied, truncate staging.

`load-ised-licenses` is its own function (`verify_jwt = false`, `x-inbound-secret`), so the FCC
function's request schema and deployed callers are untouched.

## Profile

`callsign_profile` gains `caPrefix`, true when the base call is in Canada's ITU blocks
(`^(V[A-GOXY]|C[F-KYZ]|X[J-O])`), beside `usPrefix`. Cached profiles built before the migration
lack the key for up to 15 minutes; the web reads a missing one as false.

Copy (Brad):

- License card subheader: by `license.authority` when there is a license, else by prefix.
  ISED: "From Innovation, Science and Economic Development Canada. Refreshed weekly." FCC and
  other calls keep "From the FCC Universal Licensing System. Refreshed weekly."
- No record: a US call keeps "No FCC record found for this callsign."; a Canadian call reads "No
  ISED record found for this callsign."; any other "No FCC or ISED record. This looks like a
  callsign issued outside the United States and Canada."
- ISED rows on the card: Name, Qualifications (the Class row's label for ISED), Province. Status,
  Granted and Expires are left out for ISED rather than shown as dashes.
- Footer: "License data comes from the public FCC and ISED databases. Long Lines never shows
  street addresses." Lookup page intro: "license details from the FCC and ISED".
- Attribution: if the file is published under the Open Government Licence - Canada, it needs its
  attribution line. Not yet confirmed (the download, readme and ISED pages checked say nothing
  about a licence); confirm before Task 5.

## Deliveries

Once ISED rows land, `spot_license_name` fills First name and Last name for Canadian persons in
push, Discord and webhook bodies, with no delivery code change. Clubs get none.

## Out of scope

Other countries' registries, ISED's accredited examiner and special event call sign lists, any
address, and the Stats page.
