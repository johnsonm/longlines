# Logged contacts as a source

Date: 2026-10-28

## Goal

Long Lines Relay (`sonyccd/longlines-relay`) is a desktop app that catches the contact broadcasts
logging software already sends (N1MM Logger+ format) and posts each logged contact to Long Lines
as a spot, so an operator's own side of a contact sits next to what POTA, RBN and the cluster
heard. This change is the server's first half: a new source, `logged`, a reversible retraction
marker on `raw_spots`, and the RPC that applies a batch of contacts. Pairing, relay tokens and
the `relay-api` function that calls the RPC come in the next change.

The wire contract (routes, bodies, statuses, freshness constants, the callsign check) is
`docs/contract.md` in the relay repo. It wins on wire details; this document wins on schema.

## Decisions (Brad, 2026-10-28)

| Question | Decision |
| --- | --- |
| Replace / delete on an immutable `raw_spots` | Never delete a `raw_spots` row. A retraction is a reversible marker; a replace retracts the old row and inserts a new one. Cleanup, if any, is a later concern. |
| User's own profile "worked X" | Counts only in phase 1: logged contacts flow into `hunting.sources` as source `logged` (the rollup is generic). A Worked list is a follow-up spec. |
| Server names | The Fly telnet worker is now `inbound/` (#283), so the brief's `relay` names are free server-side: `relay-api`, `/relay/v1/...`, `relay_pairings`, `relay_tokens`. The sender keeps its name. |
| Relay repo | `sonyccd/longlines-relay`. |

## Decisions made here, for Brad to confirm

| Question | Decision |
| --- | --- |
| "Any source" | Opt-in, like DX Cluster, WWFF and WWBOTA: a connection gets logged contacts only if its `sources` lists `logged`. |
| Spot roles | `spotter` is `mycall` as logged, `callsign` is `call` as logged, so the operator counts under spotter (hunting) and the worked station under heard. |
| Source id and label | `logged`, "Logged contacts" (push, Discord, webhooks, Health names, the catalog). |
| Where `mycall_mismatch` is decided | In SQL, in `apply_logged_contacts`, with `base_callsign()`: the one definition of a base call the rollups already depend on. `_shared/logged.ts` decides `invalid`, `clock_skew` and `too_old`. An account without a profile (a Google sign-up that never finished) can post no upsert. |
| Same content again after a retraction | `raw_spots` dedups on `(source, source_spot_id, content_hash)`, so an edit undone, or a contact deleted and logged again, would collide with its own retracted row. That row is revived (`retracted_at` cleared, queued for matching again) instead of a copy being inserted. The matcher never sends one spot to a destination twice. |
| Content hash | `mycall, call, frequency_hz, band, mode, timestamp_utc` after normalization (trimmed, upper-cased), with the band derived from the frequency: the request's band only feeds the client's `external_id`. The mode is hashed as logged (`LSB` and `USB` differ), stored through `resolveMode` (`ssb`). |
| `source_spot_id` | `<user id>|<external id>`, up to 293 characters; `assertStorableSpot` allows that for `logged` only (256 for every other source). |
| Readers that skip a retracted spot | `spot_stream` (profiles, rollups, group statistics, reference pages), `recent_spots`, `preview_subscription` (it must agree with the matcher), callsign groups' on-air check, `match_pending_spots`, and the Stats CTEs. A delivery created before the retraction is left alone; a day already rolled up keeps its counts. |
| `ingest_state` | One `logged` row; each applied request is a run, the count is the spots stored (created and updated). The catalog shows "Last contact" from it; the source is never "Delayed" and is not on `/health`. |
| Archive | Hourly, its own `archive_columns` branch: the `raw_spots` layout plus `retracted_at`. A retraction after a slice is archived is not in the file; `raw_spots` keeps it. |
| Stats | Not a peer: only `daily[].logged` and `hourly[].logged` (live contacts), for the catalog's rates. |
| Account deletion | `logged_contacts` rows go with the account; the spots stay in `raw_spots`, like any spot the account was in. |
| Colors | Discord card magenta (discord.py's, 15277667); the catalog mark and profile chips `secondary` (shared with SOTA: every palette color is taken). No logo asset yet: the tile shows the two-letter mark `LC`. |

## Schema

- `raw_spots.retracted_at timestamptz`, null for every existing row and every other source.
- The source checks (`raw_spots`, `ingest_state`, `archive_log`) gain `logged`, and `ingest_state`
  gets its row.
- `logged_contacts (user_id, external_id)`: `spot_id` (the contact's current spot, live or last
  retracted), `content_hash`, `state` (`live`, `retracted`, in step with `retracted_at` by a
  check), `logger_app`, `relay_version`, times. RLS on, no policies, service role only.

## `apply_logged_contacts(p_user_id, p_items)`

Security definer, service role only. Items are applied in order in the caller's transaction; the
reply is one `{external_id, status[, reason]}` per item, in order. An item is
`{op, external_id, logger_app, relay_version, spot}`; `spot` is the `NormalizedSpot` for an upsert
and null for a delete, and must carry `source = 'logged'` and the caller's own `source_spot_id`.

| Op | Contact | Effect | Status |
| --- | --- | --- | --- |
| upsert | none | store the spot | `created` |
| upsert | live, same hash | nothing | `unchanged` |
| upsert | live, other hash | retract the old spot, store the new one | `updated` |
| upsert | retracted | store the spot (or revive its row) | `created` |
| delete | live | retract its spot | `retracted` |
| delete | none or retracted | nothing | `unknown` |
| upsert | mycall's base call is not the account's | nothing | `rejected`, `mycall_mismatch` |

It ends with `record_ingest_success('logged', <spots stored>)`.

## `_shared/logged.ts`

Pure, for the `relay-api` handler:

- `loggedRequestSchema`: the request-level check (`relay_version`, 1 to 100 contacts, each with a
  valid `external_id`); a failure is a 400 for the whole request.
- `loggedContactSchema`: one item (6.1 of the contract), loose so a newer relay's extra fields are
  ignored.
- `normalizeLoggedContact(raw, account, relayVersion, now)`: `invalid`, `clock_skew` (any item
  more than `MAX_CLOCK_SKEW_MS`, 5 minutes, ahead), `too_old` (an upsert more than
  `MAX_CONTACT_AGE_MS`, 30 minutes, old), else an `apply_logged_contacts` item.
- `loggedApplyItems`, `loggedResultsSchema` (the RPC's reply) and `mergeLoggedResults`, which puts
  the module's own answers and the RPC's back in input order.

## Not in this change

Pairing, relay tokens, the `relay-api` function and its rate limit, the approval page and the
tokens card (the next change); a Worked list on profiles; recalling a delivery already sent;
re-rolling a day after a retraction.
