# Goals: design

Date: 2026-10-29. Status: **accepted; building** (PR 1, spec + schema + marking). Brad decided the
points under Decisions on 2026-10-29 while the plan was made; the canvas's Decisions note is
quoted with them. If the design changes during a PR, update this file in that PR.

Source: Brad's canvas "Connection with needs list", Page 1 (the feature was renamed goals on
2026-10-30; the canvas keeps its old name)
(`https://claude.ai/artifact/W2yMnDtdE1Rb8yAY6egF2D`), 15 frames read on 2026-10-29, and Brad's
behaviour brief of the same day. The canvas is the source of truth for layout and wording; its
copy is this file's Copy section. The behaviour comes from the brief; the technical design is
ours. Nothing about how existing connections, groups or sources work changes without asking Brad.

## Purpose

A goal is the set of things a ham is still chasing: US states, POTA parks, bands. Added to a
connection as a filter rule (`Goal is in <list>`), it makes that connection alert only for
spots that match an entry still needed, in a requirement that isn't complete. When the operator
logs a contact that works an entry, through Long Lines Relay, the entry is marked worked and every
connection using the list stops alerting for it, with nothing else to do.

A goal is its own object, like a callsign group: one list can be used by any number of
connections. It gets a nav item, **Goals**, directly below Groups, an index page, a read-only
progress page and an edit page.

Not in this build (the brief): an archive; importing older contacts or POTA hunter logs; kinds
beyond US states, parks and bands; lists shared across a club; per-band or per-mode multipliers.

## Decisions

Brad, 2026-10-29, during planning:

1. **State source is layered.** The relay sends optional `state` and `gridsquare` on a v2 contact
   (the contract allows new optional request fields within a version). Long Lines takes the
   item's state when it is one of the 50 states, else the matched POTA park's `pota_location`,
   else the FCC license state of the worked base call (`callsign_licenses.state`, `country =
   'US'`). The grid is stored, not resolved. Spots match the same way: a POTA spot's
   `pota_location` states, else the spotted base call's license state. Decision 4 below refines how the layers
   apply.
2. **Needs a look only for POTA-active stations.** A contact needs a look only when the worked
   station had a POTA spot that UTC day but none within 30 minutes of the logged time, or spots
   at two different parks within it. A station with no POTA spot that day is silently not a park
   contact.
3. **Full CRUD routes on the management API.**

The canvas's Decisions note, word for word:

1. A finished or ended list turns its rule off, so its connections alert for everything their
   other rules allow.
2. You can't delete a goal while connections use it. The dialog lists them so you can
   remove the rule first.
3. Park matching window: 30 minutes either side of the logged time.
4. Long Lines only knows contacts since the relay was connected. No import for now.
5. No archive. Finished and ended lists stay on the Goals page under Finished. Delete when
   you're done with one.

From the brief: only a contact the user logged marks an entry worked, never a spot; only
contacts logged under the account's callsign count (`apply_logged_contacts` already refuses the
rest), and only inside the list's time window; entries can be marked worked and set back to needed
by hand; a list is complete when every requirement is; "At least N" stops the rest of that
requirement alerting once N are worked.

Ours, made while building PR 1 (Brad may revisit any of them):

4. The state layers, refined after review: each layer is final once it applies, so a contact
   never takes a state from a station it was not with.
   1. The contact's own `us_state` when the relay sent one: one of the 50 states, else (DC, a
      province) no state, never a later layer.
   2. Else, when the 30-minute window has any POTA candidate for the worked station, the park,
      by `goal_park_state` of each candidate's nearest spot's `pota_location` and the license
      state: one US state gives that state; several (`US-NC,US-VA`, a trail) give the license
      state only when it is one of them, else none; none (a park outside the US) gives none. Two
      or more candidate parks (a two-fer, a rove) give the state they all give when every one
      gives the same one, with no pick needed for the state (a park review still opens while the
      list has a park requirement that isn't complete). When they give different states, or one
      gives none, the state waits for the review's pick; the picked park's location (its spot's
      `pota_location` in the window, else `reference_catalog.location`) then decides by the same
      rule, the contact as evidence, and a recheck does the same. A review opens only while the
      list has a park requirement that isn't complete, so on any other list such a contact (a
      rove across states) marks no state. That is the one exception to the canvas's "States and
      bands never need a look": the state of a rove across states can be told only by the park,
      and on a list without an open park requirement it is not asked for.
   3. Else (no POTA candidate in the window) the license state of the worked base call. A pick
      for a contact with no candidate (spotted that day, not within 30 minutes) leaves its state
      to this layer.
   One contact never marks two states. On the matching side (PR 2) a POTA spot gives its state
   by the same rule as one candidate, `goal_park_state(pota_location, license state)`: zero or
   one state, so a connection alerts only for a state working the station can mark. The license
   state alone is used only for a spot without a POTA reference.
5. A contact counts toward a list when its UTC day is inside the window, whatever the list's
   status when it arrives, so a contact logged at 23:59 on the last day and posted after midnight
   counts, as a recheck would count it. A complete list takes no new contact marks.
6. "By hand only" counts only hand marks: switching a list to it clears its contact marks, and
   switching back restores them (a recheck either way).
7. A requirement needs at least one entry; at most 10 requirements a list and 500 entries a
   requirement. The same kind may appear in more than one requirement.
8. A hand mark on an entry already worked keeps the existing mark.

## Data model

Migration `20261029001100_goals.sql`.

- `goals(id, user_id -> auth.users cascade, name, starts_on, ends_on, marking, completed_at,
  created_at, updated_at)`. Names are trimmed, non-empty and unique per account ignoring case
  (`goals_user_name_key`). `starts_on` and `ends_on` are both null (no end date) or both set
  with `ends_on >= starts_on`; they are UTC days and `ends_on` is inclusive. `marking` is `relay`
  (the default: logged contacts mark entries, and hand marks still count) or `hand`.
- Status is derived by `goal_status(list)`: `complete` when `completed_at` is set, `ended`
  when today (UTC) is after `ends_on`, else `active`. Before `starts_on` a list is active: its rule
  filters, and contacts before the start don't count. Every day comparison is `(x at time zone
  'utc')::date`, never `::date` or `current_date`.
- `goal_requirements(id, list_id cascade, position, kind, complete_when, at_least)`: `kind` is
  `state`, `park` or `band`; `complete_when` is `all` or `at_least`, with `at_least` set exactly
  then (1 or more, below the entry count).
- `goal_entries(requirement_id cascade, value, position, worked_at, worked_how, contact_spot_id,
  matched_spot_id, hand_needed_at)`, keyed by `(requirement_id, value)`. A state is a code from
  `us_states()` (the 50 states by name, no DC: "All 50 states"); a park an upper-cased POTA
  reference shaped `^[A-Z]{1,4}-[0-9]{3,6}$`, in `reference_catalog` or not; a band a name from
  `goal_bands()`, which mirrors `_shared/bands.ts` `BANDS` (`bands.test.ts` compares them).
  `worked_how` is `contact` (with `contact_spot_id`, the logged contact's spot, and
  `matched_spot_id`, the POTA spot a park or a state from its location came from) or `hand`.
  `hand_needed_at` records "Mark as needed": only a contact logged after it marks the entry again.
- `goal_reviews(id, list_id cascade, contact_spot_id, candidates, status, picked_reference,
  created_at, resolved_at)`, unique per `(list_id, contact_spot_id)`: a contact whose park could
  not be told. `candidates` are the distinct parks in the window (empty for none); `status` is
  `open`, `picked` or `not_park`. Resolved rows are kept so a recheck never opens them again.
- `logged_contacts` gains `us_state` (two capital letters) and `gridsquare` (Maidenhead, 4 to 8
  characters in capitals), written on every created or updated contact, and kept out of the content
  hash (`logged_contacts.state` already means live or retracted, hence `us_state`). An unchanged
  resend whose state or grid differs updates them; a new state re-applies the contact.
- `subscriptions` gains no column. `rules_goal_ids(rules)` reads the `goal` rules for
  the delete guard, `connection_count` and `used_by`, over the owner's own connections (at most
  100). A `goal_ids` column would be a cache like `group_ids` (from before rules existed),
  and would need `patch_subscription`, `api_subscription_json` and the preview's unsaved record to
  strip it.
- `account_object_cap()` caps an account at 50 goals ("You can have up to 50 goals.").
- RLS on every new table, `select` only for `authenticated` on its own rows; writes go only
  through the definer RPCs. The `raw_spots` references are plain foreign keys (spots are never
  deleted).

## Marking

All in SQL.

- `goal_contact_facts(user, spot)` says what each live contact of the account (or one) proves:
  its band; the distinct POTA references of POTA spots of the worked base call within 30 minutes
  either side of the logged time (`raw_spots_base_callsign_time_idx`), the one park when there is
  exactly one and the nearest of its spots; whether the station had a POTA spot that UTC day; and
  its state by the three layers (decision 4; `goal_park_state(location, license)` is the park
  layer's rule, `goal_picked_location` a picked park's location). Retracted spots are left out on
  both sides.
- `goal_mark(lists, user, spot)` marks needed entries of the given relay lists from contacts in
  each list's window: each entry takes its earliest contact (after `hand_needed_at`, when set),
  and an "at least" requirement takes only as many entries as it still lacks, earliest contacts
  first. A picked review gives its contact's park, and its state when the window's parks give
  different states (`pick_state`). A mark sets `worked_at` to the contact's time.
- `goal_sync_reviews(lists, user, spot)` opens a review for each such contact whose park can't be
  told (none within 30 minutes but a POTA spot that UTC day, or two parks) while the list has a
  park requirement that isn't complete; an open review's candidates follow the spots, and a
  recheck drops open reviews that no longer qualify.
- `goal_refresh_completion(list)` sets `completed_at` when every requirement is complete
  (keeping the first time) and clears it otherwise.
- `goal_apply_contact(user, spot)` (service role) runs those for one new contact against every
  relay list of the account that isn't complete.
- `goal_recheck(list)` (service role) rebuilds a list from scratch: clears contact marks (hand
  marks and `hand_needed_at` stay), marks again from every live contact in the window, re-applies
  picked reviews, syncs reviews and refreshes completion. Set-based, so it fits the web's 8 s
  statement timeout. It runs after `save_goal`, `mark_goal_entry` and `copy_goal`,
  and after a retraction that touched the list.
- `apply_logged_contacts` (copied whole from `20261029000600`) stores `us_state` and `gridsquare`,
  calls `goal_apply_contact` for every created, updated or revived contact, and before retracting
  a spot (a delete, or an update's old spot) collects the lists whose entries or reviews name it
  (`goals_for_spot`), rechecking each once after the loop. The per-account advisory lock
  already serialises an account's batches.
- Every client RPC that writes marks (`save_goal`, `preview_goal_window`,
  `delete_goal`, `mark_goal_entry`, `resolve_goal_review`, `copy_goal`) takes the
  same lock (`hashtextextended('logged_contacts:' || user, 0)`) before any row lock, so an
  account's marking writes apply one at a time with its contact batches and lock in one order:
  the advisory lock, the list, its entries. Without it a hand mark racing a batch (which marks
  entries before it locks a list to recheck it) could deadlock, or a batch's marks could
  overwrite a mark made since its snapshot.
- `_shared/logged.ts` reads the optional `state` (two letters) and `gridsquare` (Maidenhead),
  trimmed and upper-cased, and drops a malformed one rather than rejecting the contact. They ride
  on the apply item as `us_state` and `gridsquare`, beside the spot and out of the hash.

Known gap: a contact is checked for a park when it arrives, so a POTA spot that arrives later
(spotted up to 30 minutes after the logged time) is seen only at the list's next recheck (a save,
a hand mark or a retraction).

## Matching (PR 2)

- `normalize_subscription_rules` gains the field `goal` (subject "A goal"), op `is`
  only, exactly one value ('A goal rule takes one goal.'), owned by the caller ('Goal
  not found.' when strict).
- `rule_matches` calls `goal_matches(list_id, spot)`: true when the list is missing,
  complete or ended (the rule is off); else true when some requirement isn't complete and has a
  needed entry the spot matches (band = `spot.band`; park = upper(`spot.pota_reference`); state in
  `spot_us_states(spot)`). `marking` has no effect on matching. A goal names no stations, so
  `rules_name_stations`, `watched_among` and the RBN guard stay as they are.
- `save_subscription` locks the named lists `for key share`; `delete_goal` takes `for
  update` and refuses with LL409 'Remove it from its connections first.'
- `preview_subscription` gains `skipped_worked`: spots its other rules pass that the goal
  rule skipped ("N more matched your other rules but were skipped. You've already worked those.").

## RPCs (PR 1)

Authenticated, security definer, `search_path` pinned, listed in `advisor.test.sql`:

- `list_goals()`: cards, by name. A card is `id, name, starts_on, ends_on, marking, status,
  completed_at, requirement_count, worked, total, needed_by_kind {state, park, band},
  connection_count, updated_at`. `worked` and `total` add up the requirements, each counted up to
  its target (the entry count, or `at_least`): "18 of 64 worked". `needed_by_kind` is what
  incomplete requirements still lack ("46 entries still needed" is `total - worked`).
- `get_goal(id)`: the progress page, shape `GoalProgress` in
  `web/src/goals/types.ts`, pinned by `supabase/tests/goals.test.sql`: `list` (a card);
  `requirements[] {id, kind, complete_when, at_least, position, complete, worked, target,
  entries[] {value, label, position, worked_at, worked_how, evidence}}` (`label` is a park's
  catalog name; states and bands are worded in the web; `evidence` is `{worked_call,
  contact_time, logger_app, matched_spot_time}` for a contact mark, else null); `reviews[] {id,
  worked_call, band, mode, contact_time, candidates[] {reference, name}}` (open ones, while a park
  requirement isn't complete); `relay {status: never | recent | stale, last_contact_at,
  logger_app, relay_count}` (recent: a contact in the last 7 days; never: no relay and no
  contact); `used_by[] {id, name, sources, destination_count}`; `first_contact_at`.
- `save_goal(payload)`: create or replace, returning the id. Entries that stay keep their
  worked state (by requirement id and value); removed ones go; then a recheck.
- `preview_goal_window(id, starts_on, ends_on, marking)`: what a save with that window and
  marking would undo, changing nothing, for the edit page's date warning: the entries now worked
  by a contact that would be needed after the save, each `{requirement_id, kind, value,
  worked_at, reason}` with `reason` `before_start`, `after_end` (by the UTC day of the contact
  that marks it now) or `by_hand` (the marking is By hand only). Hand marks are never undone, and
  an entry whose requirement would still be complete is left out (it does not alert before or after). It
  applies the window and runs `goal_recheck` inside a block that always raises a private error
  and catches it, so every change rolls back and the answer comes from the save's own code. An
  entry worked again by a later contact inside the new window is not in it.
- `delete_goal(id)`, `mark_goal_entry(requirement_id, value, worked)`,
  `resolve_goal_review(id, reference | null)`, `copy_goal(id)` ("Copy for next year": same
  requirements and entries, all needed, dates a year on, the name's first four-digit year bumped,
  else " copy" appended, then a number until the name is free).

Server messages (the plan's, plus the ones marked new, which Brad has not seen):

- 'Not signed in.', 'Give the goal a name.', 'You already have a goal with that
  name.', 'Goal not found.', 'Add at least one requirement.', 'Not a US state: %.', 'Not a
  POTA reference: %.', 'Not a band: %.', '"At least" must be smaller than the number of entries.',
  'Remove it from its connections first.', 'You can have up to 50 goals.'
- New: 'Not a goal.', 'Not a requirement.', 'Not a requirement kind: %.', 'Not a "Complete
  when" rule: %.', 'Add at least one entry to each requirement.', 'A goal takes at most 10
  requirements.', 'A requirement takes at most 500 entries.', '"At least" must be a whole number
  of 1 or more.', 'Give the time window a start and an end date.', 'The end date can''t be before
  the start date.', 'Not a date: %.', 'Not a way to mark entries: %.', 'Not on this goal:
  %.', 'Say whether the entry is worked.', 'Review not found.'

## Management API (PR 3)

`GET /v1/goals`, `POST /v1/goals` (201), `GET /v1/goals/:id`, `PUT
/v1/goals/:id`, `DELETE /v1/goals/:id` (LL409 -> 409), `POST
/v1/goals/:id/entries` (`{requirement_id, value, worked}`), `POST
/v1/goals/:id/reviews` (`{review_id, reference | null}`). Reads are `read` scope, the rest
`write`. `docs/openapi.yaml` gains the paths and the `goal` rule.

## Web (PRs 4 to 6)

Routes `/goals`, `/goals/new`, `/goals/:id`, `/goals/:id/edit`; the nav
item after Groups (`ChecklistIcon`). The canvas's check marks are MUI's `CheckIcon`. Phone: cards
stack, chip lists show 12 then "Show all N needed", "How entries get marked" is an `Accordion`,
and the edit page is a full-screen dialog with Save in the top bar. The relay banner's "Dismiss for
7 days" is per list in `localStorage` (`longlines.goalRelayDismissed.<id>`). The connection
editor offers the `goal` field with op `is` labelled "is in", a source warning when a kind
can never match the connection's source (parks match only `pota`), and the preview line from
`skipped_worked`.

## PR order

1. Spec + schema + marking (this file, the migration, `logged.ts`, pgTAP). Hosted: db push, then
   redeploy `relay-api`.
2. Matching + preview. 3. Management API. 4. Web: index + progress page. 5. Web: edit page. 6.
   Web: the rule in the connection editor. 7. longlines-relay: optional `state` and `gridsquare`
   on contacts.

## Copy

From the canvas, word for word; the example values (`2026 chase`, `K4ABC`, counts and dates) are
the canvas's sample data. `[x]` is a button or link labelled x; `(x)` a field label; a check mark
before a worked entry is `CheckIcon`. Desktop frames have the app bar and the nav; the nav reads
`Home`, `Sources`, `Connections`, `Destinations`, `Groups`, `Goals`, `Band map`, `Callsign
lookup`, `Reference lookup`, `Stats`, `Health`, `API tokens`.

### Goals (`/goals`)

Frame "Goals" (desktop):

- Title `Goals`; `[Add goal]`.
- Subtitle: `Tell Long Lines what you still need. Connections stop alerting for anything you've
  worked.`
- Card (a link to the progress page): name `2026 chase`; `3 requirements · Jan 1 – Dec 31, 2026`;
  `18 of 64 worked` with a progress bar; `Used by 2 connections`.
- Card: `POTA hunter award`; `1 requirement · No end date`; `41 of 100 worked`; `Used by 1
  connection`.
- Overline `Finished · 2`.
- Finished card: `Winter Field Day 2026` with a `Complete` chip; `2 requirements · Jan 24 – 25,
  2026`; `30 of 30 worked`; `Rule off on 1 connection`.
- Finished card: `2025 chase` with an `Ended` chip; `3 requirements · Jan 1 – Dec 31, 2025`; `51 of
  64 worked`; `Not used by any connection`.
- Under them: `Finished goals stop counting contacts. Their rule is off on any connection that
  still has it. Delete one once no connection uses it.`

Frame "Mobile: goals": the app bar (`Long Lines`), title `Goals`, the subtitle as on
desktop, `[Add goal]`, then the two active cards as on desktop.

Frame "Edge: no goals yet": title and subtitle as above, then a card: `No goals yet`;
`A goal is what you're still chasing: states, parks, bands. Add one to a connection and it
stops alerting for anything you've already worked.`; `[Add goal]`.

### Progress page (`/goals/:id`)

Frame "Goal progress" (desktop):

- Breadcrumbs `[Goals] / 2026 chase`; title `2026 chase`; `[Edit goal]`.
- `Counts contacts from Jan 1 – Dec 31, 2026 · 64 days left`
- Requirement card `States  ·  Work all 50`; `12 of 50 worked`; `Still needed · 38` with a chip
  per state code (`AK`, `AZ`, … `WY`); `[Show 12 worked]`.
- Requirement card `Parks  ·  Work all 10`; `3 of 10 worked`; `Still needed · 7` with a chip per
  park name (`Hanging Rock State Park`, `Pilot Mountain State Park`, `Jordan Lake State Recreation
  Area`, `Fort Macon State Park`, `Kennesaw Mountain National Battlefield Park`, `Stone Mountain
  Park`, `Chattahoochee River National Recreation Area`); shown worked: `Worked · 3`, then per
  entry a check mark, the name and an evidence line with `[Mark as needed]`:
  - `Great Smoky Mountains National Park` / `Worked K4ABC · Oct 3, 21:14 UTC · Logged in N1MM,
    matched to a POTA spot at 21:09`
  - `Cape Lookout National Seashore` / `Worked N4DEF · Oct 12, 14:02 UTC · Logged in N1MM, matched
    to a POTA spot at 13:58`
  - `Blue Ridge Parkway` / `Marked by hand · Oct 20`
  - then `[Hide worked]`.
- Requirement card `Bands  ·  Work at least 4 of 6`; `3 of 4 worked`; `Still needed · 3` with
  chips `80 m`, `10 m`, `6 m`; `Once you've worked 4, the other bands stop alerting too.`; `[Show
  3 worked]`.
- Side panel: `Progress` / `18 of 64 worked` / `0 of 3 requirements complete`.
- Side panel: `How entries get marked`; `Long Lines relay` with a `Connected` chip; `N1MM · Last
  contact 12 minutes ago`; `When you log a contact, Long Lines checks it against your entries.
  States and bands come from the contact. Parks come from the POTA spot for that station around the
  time you logged it.`; `A spot alone never marks anything worked. Only a contact you logged does.
  You can also mark entries by hand.`
- Side panel: `Used by`; `[POTA states, CW]` / `Parks on the Air · 1 destination`; `DX states` /
  `DX cluster · 2 destinations`; `Every connection using this goal stops alerting for entries
  you've worked.`

Frame "Mobile: goal progress":

- App bar: back, `2026 chase`, `Edit`.
- `Jan 1 – Dec 31, 2026 · 64 days left`; `18 of 64 worked`; `0 of 3 requirements complete`.
- `Relay` with a `Connected` chip; `Last contact 12 minutes ago`.
- `States  ·  Work all 50`; `12 of 50`; `Still needed · 38`; the first 12 chips; `[Show all 38
  needed]`; `[Show 12 worked]`.
- `Parks  ·  Work all 10`; `3 of 10`; `Still needed · 7`; four chips; `[Show all 7 needed]`;
  `Worked · 3`; `Great Smoky Mountains National Park` / `K4ABC · Oct 3, 21:14 UTC · Matched to a
  POTA spot at 21:09` `[Mark as needed]`; `Cape Lookout National Seashore` / `N4DEF · Oct 12, 14:02
  UTC · Matched to a POTA spot at 13:58` `[Mark as needed]`; `Blue Ridge Parkway` / `Marked by
  hand · Oct 20` `[Mark as needed]`.
- `Bands  ·  At least 4 of 6`; `3 of 4`; `Still needed · 3`; `80 m`, `10 m`, `6 m`; `Once you've
  worked 4, the other bands stop alerting too.`
- Folded section `How entries get marked`: `When you log a contact, Long Lines checks it against
  your entries. States and bands come from the contact. Parks come from the POTA spot for that
  station around the time you logged it.`
- `Used by`: `POTA states, CW` / `Parks on the Air · 1 destination`; `DX states` / `DX cluster · 2
  destinations`.

Frame "Edge: relay not connected" (desktop, as the progress page with):

- Warning banner: `Entries aren't being marked automatically`; `The relay hasn't sent a contact in
  9 days. Contacts you log while it's off won't mark anything worked, and your connections will
  keep alerting for them. Open the relay on your logging computer, or mark entries by hand.`;
  `[Download the relay]` `[Dismiss for 7 days]`.
- Side panel `How entries get marked`: `Long Lines relay` with a `Not connected` chip; `Last
  contact Oct 20, 9 days ago`; `While the relay is off, contacts you log don't reach Long Lines, so
  nothing on this goal gets marked worked.`; `[Download the relay]`.

Frame "Edge: contacts that couldn't be matched to a park" (desktop, as the progress page with):

- Banner: `2 logged contacts need a look before they can count toward Parks.` `[Review]`
- Card `Needs a look · 2` / `Contacts we couldn't match to a park`:
  - `AA1ZZ · 20 m CW`; `Oct 27, 20:44 UTC · No POTA spot for this station within 30 minutes of
    when you logged it.`; `[Pick park]` `[Not a park contact]`
  - `W8XYZ · 40 m SSB`; `Oct 26, 15:10 UTC · Spotted at two different parks around then: Hanging
    Rock State Park and Pilot Mountain State Park.`; `[Choose park]` `[Not a park contact]`
- Side panel `Why this happens`: `Your log says who you worked, not which park they were in. Long
  Lines looks for a POTA spot of that station near the time you logged it. No spot, or spots at
  two parks, means it can't tell.`; `States and bands never need a look. They come straight from
  the contact.`

Frame "Edge: everything worked":

- Title `2026 chase` with a `Complete` chip; `[Edit goal]`.
- `Counts contacts from Jan 1 – Dec 31, 2026 · Finished Nov 18, 43 days early`
- Success banner: `You worked everything on this goal`; `All 3 requirements are complete. Nice
  work.`
- Banner: `The goal rule is now off on 2 connections`; `POTA states, CW and DX states no
  longer filter by this goal, so they alert for everything their other rules allow. Add a
  different goal to them, or delete this one once no connection uses it.`; `[Review
  connections]` `[Delete goal]`.
- Requirements: `States  ·  Work all 50  Done` / `50 of 50 worked` / `[Show 50 worked]`; `Parks  ·
  Work all 10  Done` / `10 of 10 worked` / `[Show 10 worked]`; `Bands  ·  Work at least 4 of 6
  Done` / `4 of 4 worked` / `[Show 4 worked]`.
- Side panel: `Progress` / `64 of 64 worked` / `3 of 3 requirements complete`; `Used by` with the
  two connections; `The goal rule is off on both connections.`

Frame "Edge: time window ended":

- Title `2026 chase` with an `Ended` chip; `[Edit goal]`.
- `Counted contacts from Jan 1 – Dec 31, 2026 · Ended 3 days ago`
- Banner: `This goal ended Dec 31, 2026`; `46 entries were still needed. It no longer counts
  new contacts, and the goal rule is now off on the 2 connections using it, so they alert for
  everything their other rules allow. Change the dates to turn it back on.`; `[Change dates]`
  `[Copy for 2027]` `[Delete]`.
- Requirement: `States  ·  Work all 50`; `12 of 50 worked`; `Not worked · 38` with the chips;
  `[Show 12 worked]`.
- Side panel: `Progress` / `18 of 64 worked` / `Final: 0 of 3 requirements complete`; `Used by`
  with the two connections; `The goal rule is off on both connections while this goal is
  ended.`

Frame "Edge: can't delete a list connections use" (a dialog over the progress page):

- Title `Can't delete 2026 chase yet`
- `2 connections use this goal. Remove the goal rule from each one, then you can delete
  it.`
- `POTA states, CW` / `Parks on the Air · 1 destination` `[Open]`; `DX states` / `DX cluster · 2
  destinations` `[Open]`
- `[Close]`

### Edit page (`/goals/new`, `/goals/:id/edit`)

Frame "Edit goal" (desktop):

- Breadcrumbs `[Goals] / [2026 chase]`; title `Edit goal`; `[Cancel]` `[Save goal]`.
- `(Name *)` `2026 chase`
- Section `Time window` / `Which contacts count toward this goal.`: `(Counts contacts)` `Between
  dates`; `(Starts)` `Jan 1, 2026`; `(Ends)` `Dec 31, 2026`; `Choose "No end date" for something
  open-ended, like a POTA award. Long Lines counts contacts logged after you connected the relay.
  Mark earlier ones by hand.`
- Section `How entries get marked` / `Pick what counts as proof that you worked an entry.`: `(Mark
  entries worked)` `From my log, using the relay`; `The relay is connected. Choose "By hand only" if
  you don't log with N1MM or WSJT-X. Spots never mark an entry on their own.`
- Section `Requirements` / `A spot alerts you while it matches anything you still need. Add as many
  requirements as you like.`
  - `(Kind)` `US states`; `(Complete when you've worked)` `All of these`; a delete button (`Delete
    requirement`); `All 50 states`; `(Add a state)` placeholder `Type a state or abbreviation`.
  - `(Kind)` `Parks`; `(Complete when you've worked)` `All of these`; the ten park names as
    chips; `(Add a park)` placeholder `Search by name or reference`.
  - `(Kind)` `Bands`; `(Complete when you've worked)` `At least`; `(How many)` `4`; chips `80 m`,
    `40 m`, `20 m`, `15 m`, `10 m`, `6 m`; `Once you've worked 4 of these, the rest stop
    alerting.`
  - `[Add requirement]`

Frame "Mobile: edit goal" (full screen):

- App bar: back, `Edit goal`, `Save`.
- `(Name)` `2026 chase`
- `Time window`: `Between dates` | `No end date`; `(Start)` `Jan 1, 2026`; `(End)` `Dec 31, 2026`.
- `How entries get marked`: `From my log, using the relay` / `You can still mark by hand`; `By hand
  only`.
- `Requirements`:
  - `States` `[Remove]`; `(Complete when)` `All of these`; `Entries`; `All 50 states` `[Add
    states]`.
  - `Parks` `[Remove]`; `(Complete when)` `All of these`; `Entries`; `Hanging Rock State Park`
    `Pilot Mountain State Park` `Fort Macon State Park` `+ 7 more` `[Add parks]`.
  - `Bands` `[Remove]`; `(Complete when)` `At least`; `(How many)` `4`; `Entries`; `160 m` `80 m`
    `40 m` `20 m` `10 m` `6 m` `[Add bands]`.
- `[Add requirement]` `[Delete goal]`

Frame "Edge: changing dates, and contacts from before the relay" (desktop):

- Breadcrumbs `Goals / 2026 chase / Edit`; title `Edit goal`.
- `Time window`: `Between dates` / `For a contest or a calendar-year award`; `(Start)` `Mar 1,
  2026`; `(End)` `Dec 31, 2026`.
- Warning under the dates: `3 worked entries fall before the new start date`; `GA, SC and Cape
  Lookout National Seashore were worked in January and February. When you save, they go back to
  needed and your connections start alerting for them again.`
- `No end date` / `For a lifetime award like POTA hunter`.
- Info: `Long Lines only knows contacts since Oct 16, 2026`; `That's when you connected the relay.
  Anything you worked before then isn't counted. Mark those entries worked by hand from the
  progress page.`
- `[Cancel]` `[Save]`

### Connection editor (PR 6)

Frame "Edit connection" (desktop; only the goal parts are new):

- Breadcrumbs `[Connections] / POTA states, CW`; title `Edit connection`; `[Cancel]` `[Save
  connection]`; `(Name *)` `POTA states, CW`; `Enabled`.
- Step 1 `Source` / `Where spots come from`: `Parks on the Air`, `678 spots/hour on average`,
  `[View schema]`; `A connection has one source. To use a different source, create a new
  connection.`
- Step 2 `Filter` / `Optional. Leave it empty to pass every spot`; `Pass spots that match all of
  these rules`; `Where`:
  - `(Field)` `Goal`; `(Condition)` `is in`; `(Values)` `2026 chase`; helper `46 entries still
    needed across 3 requirements. This rule updates itself as you work them.` `[View progress]`;
    a delete button (`Delete rule`).
  - `and` `(Field)` `Mode`; `(Condition)` `is`; `(Values)` `CW`.
  - `and` `(Field)` `Callsign group`; `(Condition)` `is in`; `(Values)` `RARS`; `Matches 435
    stations from your groups and callsigns.`
  - `[Add rule]`; `(Repeat spots for the same station)` `At most once per 30 minutes`.
- Step 3 `Destinations` / `Zero or more. Spots that pass the filter are sent to each one`: `Brad's
  devices` / `Push notification` / `Healthy`; `[Add destination]`.
- Preview: `Preview`; `6 of the last 200 POTA spots would pass`; `29 more matched your other rules
  but were skipped. You've already worked those.`

Frame "Warning: source can't match an entry" (the filter step of a SOTAwatch connection):

- Step 1: `SOTAwatch`, `42 spots/hour on average`, `[View schema]`.
- The goal rule's helper: `46 entries still needed across 3 requirements. 7 can't match on
  this source.` `[View progress]`
- Warning under the rule: `Parks in this goal can't match here`; `The Parks requirement has 7
  parks still needed. SOTAwatch spots don't include parks, so those entries will never alert on
  this connection.`; `[Create a Parks on the Air connection]`.
- Then `and` `Mode` `is` `CW`; `[Add rule]`; `(Repeat spots for the same station)` `At most once
  per 30 minutes`.
