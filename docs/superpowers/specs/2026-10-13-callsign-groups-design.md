# Callsign groups: design

Date: 2026-10-13. Status: **Section 1 (schema and RPCs) approved and built in PR #129.** Brad
then supplied UI mocks (`callsign-groups-mocks/`). They overrode four things: a cap of 1,000 per
group, members stored as base calls, whole-list saves, and "on the air now". Those changes are
approved and are Section 1b. Sections 2–4 were proposals revised to follow the mocks; Sections 2
and 3 are now approved and built. Before
implementing one of them, its PR's chat presents it to Brad and gets a yes. If the design
changes, update this file in that PR.

**The mocks are authoritative for layout and copy on the Groups page, the group dialog and the
subscription dialog.** Ignore anything else in them that doesn't match the current app: the
"Band map" nav item, a sources list that shows only POTA and SOTAwatch, and the stale Sources
page statuses. `nav.png` only shows where Groups goes in the nav.

| Mock | File |
|---|---|
| Groups page | `callsign-groups-mocks/groups-page.png` |
| New group dialog | `callsign-groups-mocks/new-group.png` |
| Edit group dialog | `callsign-groups-mocks/edit-group.png` |
| Subscription dialog with groups | `callsign-groups-mocks/subscription-dialog.png` |
| Nav placement | `callsign-groups-mocks/nav.png` |

## Purpose

A user keeps named lists of callsigns, such as a club roster, an award list or friends, and points
subscriptions at them instead of retyping calls. A list holds up to 1,000 calls. Lists are entered
by typing, by pasting a block of text, or by importing a CSV file.

## What Brad asked for

- A group is a name plus a list of callsigns.
- A user can have any number of groups. Group names are unique within the account.
- ~~The size of a group is effectively unlimited.~~ Replaced by the mocks: a group holds **up to
  1,000 callsigns**. That limit is easy to raise later.
- A subscription can target more than one group. The groups merge into one deduplicated list:
  a call that appears in two groups still produces one delivery, not two.
- Groups can be filled by typing, pasting or importing a CSV. A CSV's callsign column is
  detected, and the user confirms what was found before anything is added.

## Decisions

| Topic | Decided |
|---|---|
| Edits | Live. Changing a group changes every subscription that uses it, with no re-save. |
| Matching rule | The same as typed calls: an exact match or the base call (`callsign_matches`). An RBN station in a group counts as watched, through `watched_among`. |
| Mixing | A subscription can have typed callsigns and groups together. Its callsign filter is the union of both. |
| Empty groups | The callsign filter is on when the subscription has typed callsigns or any group. If every group is empty and nothing is typed, the subscription matches **nothing**. It never falls back to "any station". |
| Deleting a group in use | Refused: "Remove it from its subscriptions first." This mirrors destinations. In the UI, Delete is disabled while the group is in use. |
| Deduplication | Comes from the design: group membership is tested with `exists`. `match_pending_spots` already makes one delivery per (destination, spot), and the quiet window is per (subscription, callsign). |
| Storage approach | Normalised and indexed (approach A). Members sit in their own table and the matcher looks them up through an index. Rejected: a merged array on `subscriptions` kept current by triggers (linear `= any` scans, every subscription rewritten when a group changes), and copying calls into the subscription on save (edits wouldn't reach existing subscriptions). |
| CSV columns | Use the column headed `call`, `callsign`, `call sign` or `call_sign` (case-insensitive) if there is one. Otherwise use the first column. Show what was found and what was skipped before the calls go into the list. |
| Export | Not in scope. |
| Size (from the mocks) | At most **1,000** callsigns per group, which equals PostgREST's `max_rows`. The server enforces it. |
| Stored form (from the mocks) | Members are stored as **base calls** (`base_callsign()` in SQL). Adding `KK4PWJ/P` stores `KK4PWJ`, which matches every portable variant. A group can't target only `/P`; a typed subscription callsign still can. The web never works out a base call. |
| Editing (from the mocks) | One dialog holds the name and the whole list. Nothing is written until **Create group** or **Save changes**. Then a single RPC replaces the name and members atomically. |
| On the air now (from the mocks) | A member spotted in the last **30 minutes** in `raw_spots` (POTA, SOTAwatch, DX Cluster, and RBN copies of watched calls), matched on `raw_spots.base_callsign`. Computed in SQL. |
| Get alerts on a group | Works like Get alerts on a profile (`CallsignPage.getAlerts`). It creates "<group name> on the air" with `group_ids = [id]`, the first healthy destination and a 30-minute quiet window. If a subscription already uses this group, it says "You already have <name>." and opens Subscriptions instead. With no healthy destination it says "Add a destination to start getting alerts.". |

## Section 1: Schema and RPCs (approved; built in #129)

As built. Section 1b replaces the RPC list, the members' stored form and the paged reads below.

Migration `20261013000100_callsign_groups.sql`. Recheck the number across every worktree first
(`git worktree list`). `20261013000010` is already taken by `stats-hourly-window`.

**Tables**

- `callsign_groups(id uuid pk default gen_random_uuid(), user_id uuid not null references
  auth.users on delete cascade, name text not null, created_at, updated_at)`. Uniqueness is a
  unique index on `(user_id, lower(name))`. Names are stored trimmed, and the RPCs reject empty
  names. The `set_updated_at` trigger keeps `updated_at` current, as it does on subscriptions.
- `callsign_group_members(group_id uuid references callsign_groups on delete cascade, callsign
  text not null, primary key (group_id, callsign))`, plus an index on `(callsign, group_id)`.
  The matcher probes that index. Callsigns are stored uppercase and trimmed, and a check
  constraint applies the same rule as `profiles.callsign` (`CALLSIGN_RE` in
  `web/src/lib/callsign.ts`): `W1AW/P` passes, junk cells don't.
- `subscriptions.group_ids uuid[] not null default '{}'`. It is an array rather than a join table
  because `preview_subscription` matches against an unsaved `subscriptions` row built from the
  dialog's filter, the same way `sources`, `bands` and the others work. The column is added
  last, so every positional `(…)::subscriptions` cast must gain it. Grep for `::subscriptions`.

**Integrity without a foreign key on the array.** Clients have no direct insert or update on any
of these tables, and every write goes through an RPC:

- `save_subscription` takes `group_ids` and checks that each one belongs to the caller. If not,
  it raises "Group not found.". An update without a `group_ids` key keeps the subscription's
  groups, so a client that predates groups cannot drop them.
- The `subscriptions_rbn_needs_callsign` trigger accepts an RBN-only subscription that has a group
  instead of typed calls: a group is a list of callsigns.
- `delete_callsign_group(id)` refuses while any subscription's `group_ids` contains the id. It
  raises "Remove it from its subscriptions first.".
- `preview_subscription` (PR 2) keeps only the caller's own group ids before matching. Otherwise
  preview could probe whether another user's group contains a call.

**RPCs.** Each is `security definer` with a pinned `search_path`, executable by `authenticated`
only. Each goes on the client-callable list in `supabase/tests/advisor.test.sql`.

- `create_callsign_group(p_name text) → uuid`
- `rename_callsign_group(p_id uuid, p_name text)`. A duplicate name, in either this RPC or create,
  raises "You already have a group with that name.". Catch `unique_violation` and re-raise with
  that message.
- `add_group_callsigns(p_id uuid, p_calls text[]) → jsonb {added int, already int, rejected
  text[]}`. One RPC covers typing, pasting and CSV import. It trims any whitespace (tabs, line
  ends and non-breaking spaces as well as spaces), uppercases and validates. Blank values are skipped.
  Invalid values come back in `rejected` and are not raised. It ends with `insert … on conflict do
  nothing`. The client sends large imports in chunks of 2,000.
- `remove_group_callsigns(p_id uuid, p_calls text[]) → int` (rows removed)
- `delete_callsign_group(p_id uuid)`
- `list_callsign_groups() → table(id, name, member_count bigint, subscription_count bigint,
  updated_at)`. It is ordered by `lower(name)`.

Every RPC raises "Not signed in." when `auth.uid()` is null, and "Group not found." when the id
isn't the caller's. Adding or removing members bumps the group's `updated_at`.

**Reads.** `select` on `callsign_groups` and `callsign_group_members`, with own-row RLS
(membership through the parent group). PostgREST caps responses at `max_rows = 1000`, so the
web pages through members with `.range()` and an `ilike` search. Direct insert, update and
delete are revoked. The grants match those on subscriptions.

**Account deletion.** Groups cascade from `auth.users`. Add them to
`supabase/tests/account_delete.test.sql`.

**Tests:** a new pgTAP suite, `supabase/tests/callsign_groups.test.sql`, covering:

- RLS from another user's view (`pg_temp.as_user`)
- unique names, case-insensitively
- the add counts and rejections
- the delete guard
- `save_subscription` group ownership
- grants

Also extend the advisor and account-delete tests.

## Section 1b: Changes from the mocks (approved; PR 1b)

Branch `callsign-groups-ui-fixes`, worktree `../longlines-callsign-groups-ui`, based on main
after #129 merged. The migration is
`20261013000210_callsign_groups_ui.sql`. Recheck the number: it must be above every migration in
every worktree. `20261013000200` belongs to another branch.

- **Base calls.** Members are stored as `public.base_callsign(callsign)`. The migration rewrites
  any existing rows to base calls and drops the duplicates that creates. A check constraint
  `callsign = public.base_callsign(callsign)` sits next to the format check. Also add
  `callsign_group_members` to the CLAUDE.md rule that says what a `base_callsign()` change must
  rewrite. *As built:* the rewrite is `rebase_callsign_group_members()` (service role only), so
  pgTAP can run it and a later `base_callsign()` change can call it again. It also drops a row
  whose base fails the format check.
- **One normaliser, used twice.** `normalize_group_callsigns(p_calls text[]) → jsonb {callsigns
  text[], rejected text[]}`:
  - It trims all whitespace and uppercases.
  - It validates the value as typed against the `CALLSIGN_RE` rule.
  - It maps each call to its base call and removes duplicates.
  - It drops blanks.
  - *As built:* it also rejects a call whose base fails the rule, since it couldn't be stored
    (`W1AW/12345` has base `12345`). `rejected` keeps the order given, so the save's
    "Not a callsign" names the first bad value typed.
  
  It is granted to `authenticated` and listed in `advisor.test.sql`. The dialog's Type, Paste and
  CSV tabs call it, so the chips show exactly what will be stored. `save_callsign_group` uses the
  same code.
- **Whole-list save.** `save_callsign_group(payload jsonb {id?, name, callsigns[]}) → uuid`
  creates the group when `id` is absent and otherwise updates it. In one transaction it:
  - Validates the name ("Give the group a name." or "You already have a group with that name.").
  - Normalises the calls. If any are rejected it raises "Not a callsign: <first rejected>.".
  - Raises "A group can hold up to 1,000 callsigns." when there are more than 1,000 after
    deduplication.
  - Updates the members by diff: it deletes the ones that are gone and inserts the new ones, so
    unchanged rows aren't rewritten.
  - Bumps `updated_at`.
- **Drop** `create_callsign_group`, `rename_callsign_group`, `add_group_callsigns` and
  `remove_group_callsigns`. No client ever shipped them. Remove them from `advisor.test.sql`.
  `delete_callsign_group` stays as it is.
- **`list_callsign_groups()`** is dropped and recreated with a new return type: `id, name,
  callsigns text[]` (all members, alphabetical; the cap keeps this small), `member_count,
  subscription_count, updated_at, on_air jsonb`. The shape of `on_air` is `{"count": int,
  "latest": {callsign, frequency_khz, band, mode, source, reference, spot_time} | null}`:
  - `count` is the number of distinct members with a `raw_spots` row whose `base_callsign` is the
    member and whose `spot_time > now() - interval '30 minutes'`.
  - `latest` is the newest of those spots.
  - `reference` is `coalesce(pota_reference, sota_summit_ref)`.
  
  This uses the existing `(base_callsign, spot_time)` index. The edit dialog takes its list from
  here, so the web needs no paged member read.
- **Tests:** update `callsign_groups.test.sql`. Cover:
  - the base-call rewrite and its deduplication
  - the cap, both at exactly 1,000 and at 1,001
  - rejection
  - the diff save keeping unchanged rows
  - the name rules
  - `on_air` counting with a spot at 29 minutes and one at 31 minutes, and the same member
    spotted twice
  - another user's group being invisible
  
  Regenerate `database.types.ts`.

## Section 2: Matching (approved; PR 2)

Migration `20261013000330_callsign_group_matching.sql` (220 was passed by #130's 300 and the
review fixes' 310 and 320 before PR 2 started).

*As built,* with Brad's approval, it differs from the proposal below in these ways:

- `spot_matches` checks groups last, as `cardinality(sub.group_ids) > 0 and group_matches(…)`.
  `group_matches` has a subquery, so Postgres never inlines it. A subscription without groups
  never calls it, and the source, band, mode and reference checks run first. `spot_matches` still
  calls only functions, so it stays inlinable and on the unpinned-helper list. `group_matches` is
  pinned and runs as invoker: its callers are definer functions.
- `station_count` counts distinct **base** calls. Typed `W1AW/P` plus a `W1AW` member is one
  station.
- Preview compares group ids as text (`g.id::text = any (…)`). A malformed id is ignored like
  another user's id, rather than raising a uuid cast error.
- In `watched_among`, the group arm materializes the batch's member rows first: one index probe
  per distinct base call, then a hashed check against the groups that enabled subscriptions
  accepting the source use. Left to the planner, it probed once per (call, watched group) pair.
  There's no GIN index on `group_ids`, because nothing searches subscriptions by group.
- Performance check, local stack, 1M members, 300 subscriptions (250 with groups):
  `match_pending_spots` takes about 0.42 s per 500-spot batch (11 ms with the group
  subscriptions disabled), `watched_among` 70–85 ms for 1,000 calls, and preview about 5 ms. The
  matcher's cost is one `group_matches` call (about 6 µs) per surviving (subscription, spot)
  pair, so it grows with the number of group subscriptions.

- New helper: `group_matches(p_group_ids uuid[], p_base text) returns boolean`, `stable`, with a
  pinned search path. It returns `cardinality(p_group_ids) > 0 and exists (select 1 from
  public.callsign_group_members m where m.callsign = p_base and m.group_id = any (p_group_ids))`.
  Members are base calls, so probing with the spot's base call is enough. Revoke it from clients.
- `spot_matches` becomes `stable`, because it now reads a table. Its callsign clause becomes:
  `(cardinality(sub.callsigns) = 0 and cardinality(sub.group_ids) = 0) or
  callsign_matches(sub.callsigns, …) or group_matches(sub.group_ids, spot.base_callsign)`. The
  RBN guard becomes `spot.source <> 'rbn' or cardinality(sub.callsigns) > 0 or
  cardinality(sub.group_ids) > 0`. (PR 1 already relaxed the save-time trigger the same way.)
  Update `advisor.test.sql` if `spot_matches` leaves the unpinned-helper list. Update the
  CLAUDE.md bullet that calls RBN matching "subscriptions that name callsigns": groups count.
- `watched_among` has to cover group members. It runs on every RBN firehose batch, so drive it
  from the member index rather than looping over subscriptions. Roughly: the distinct base calls
  in the batch → members with that callsign → enabled subscriptions whose `group_ids` contain
  that group and whose `source_matches` holds. A GIN index on `subscriptions.group_ids` may help;
  decide with `EXPLAIN ANALYZE`.
- `preview_subscription` reads `filter -> 'group_ids'` and keeps only the caller's ids:
  `array(select g.id from callsign_groups g where g.user_id = auth.uid() and g.id = any (…))`.
  It passes them into the row it builds. The matcher and the preview keep sharing `spot_matches`.
  **It also returns `station_count`**: the number of distinct calls in the typed callsigns plus
  the members of the caller's selected groups. That number drives "Matches N stations from your
  groups and callsigns.". Changing the return type means dropping and recreating the function;
  keep `api.ts` compiling, regenerate `database.types.ts`, and re-grant to `authenticated` only.
- `match_pending_spots` is unchanged. Confirm that a spot whose call is in two of a
  subscription's groups produces one candidate row.
- **Performance check:** 50 users, each with 20 groups of 1,000 members and 5 subscriptions
  using groups, against a batch of 500 spots, plus a 1,000-call `watched_among` batch. Record the
  timings in the PR. The matcher runs every minute and after every ingest.
- **Tests:** extend `matcher.test.sql` and `rbn.test.sql` (the watched set), and add preview
  cases:
  - merging and deduplication
  - an empty group matching nothing
  - typed and group calls mixed
  - a `KK4PWJ/P` spot matching through a `KK4PWJ` member
  - another user's group id being ignored in preview, including in `station_count`

## Section 3: Groups page (approved; PR 3)

Build it to the mocks: `groups-page.png`, `new-group.png` and `edit-group.png`. The copy comes
from the Copy section below. The strings the mocks don't show were approved and are in the Copy
section. *As built:* chips are alphabetical, as `list_callsign_groups` returns them (the mock's
order is just sample data). `SubscriptionInput` gains an optional `group_ids` for Get alerts;
PR 4 makes the dialog edit it.

- **Route and nav.** `/groups` (RequireAuth). A **Groups** nav item with a people icon goes
  between Subscriptions and Destinations.
- **Page.**
  - Header: title, subtitle and a **New group** button.
  - The cards sit in a grid: two columns on desktop, one on phone.
  - Groups come from `list_callsign_groups` on load and after each save or delete. No polling.
- **Card**, one per group:
  - The name.
  - "N callsigns · used by M subscriptions", with the singular "subscription" for 1.
  - The first 10 members as outlined chips, then a "+N more" chip.
  - When `on_air.count > 0`: a success-colored chip reading "N on the air now". Below it, the
    latest spot on two lines: "KK4PWJ 14062.0 kHz CW" and "20m · POTA · US-2763 · 2m ago". Use
    the existing time helpers in `lib/time.ts`.
  - Actions: **Get alerts** (bell; see Decisions), **Edit** (pencil) and **Delete** (trash, error
    color). Delete is disabled while `subscription_count > 0`. For any delete confirmation,
    follow the Destinations page.
- **Group dialog** (New group / Edit group):
  - Left side: the **Group name** field (required), then an "Add callsigns" subheading with tabs
    TYPE, PASTE and IMPORT CSV.
    - TYPE: a **Callsign** field (placeholder `KK4PWJ`) and an **Add** button.
    - PASTE: a text area and an Add button.
    - IMPORT CSV: a file picker. It reports the detected column and the found and skipped counts,
      then has an Add button.
    - Every tab sends its raw values through `normalize_group_callsigns` and merges the result
      into the list.
    - Rejected values are listed under the tab (*proposed* copy).
    - If an add would push the list past 1,000, the tab refuses it with a message (*proposed*)
      and adds nothing.
  - Right panel:
    - "N callsigns" and a **Remove all** button (error color, disabled at 0).
    - The fixed helper text.
    - The members as deletable chips, alphabetical.
    - The empty-state line.
  - Footer: **Cancel**, plus **Create group** or **Save changes**. The primary button stays
    disabled until there's a name. Saving calls `save_callsign_group`, and server errors show in
    the dialog.
  - Phone layout: the panes stack. Check it with `setMobile(true)`.
- **Pure parsing module** `web/src/groups/parse.ts`, unit-tested in node:
  - It contains a small CSV parser: quoted fields, embedded commas, doubled quotes, CRLF, and a BOM.
    Use no new dependency.
  - Column detection.
  - Paste and type splitting on commas, whitespace, semicolons and newlines.
  - It doesn't validate. The server's normaliser decides.
- `web/src/lib/api.ts`: `listGroups`, `saveGroup`, `deleteGroup` and `normalizeCallsigns`.
- **Tests:** component tests through `web/src/test/render.tsx` with `vi.mock("../lib/api")`.
  Cover:
  - the card states: on the air or not, used or unused
  - the tabs
  - Remove all
  - the 1,000 refusal
  - the save errors
  - Get alerts in its three outcomes
  - the phone layout
  
  Meet the 80% gate.

## Section 4: Groups in subscriptions (proposed; PR 4)

Build it to `subscription-dialog.png`.

- **Callsigns** stays where it is. When any group is selected, its helper text becomes "Added to
  the groups below.". With no groups selected it keeps "Leave empty to match any station." (the
  *proposed* rule; confirm with Brad).
- A **Callsign groups** multi-select (an autocomplete over `list_callsign_groups`, chips of group
  names) goes directly below Callsigns. When there are typed calls or selected groups, its helper
  reads "Matches N stations from your groups and callsigns.", with N from the preview's
  `station_count`. With no groups in the account, the field is replaced by a link to `/groups`
  (*proposed* copy).
- `SubscriptionInput` gains `group_ids`. Also update `blankSub`, `toInput` and the preview
  payload, which adds `group_ids` to the memoised JSON key.
- `filterChips` shows each group's name as a chip. Names come from the groups list that `api.ts`
  already loads. Never resolve membership in TypeScript.
- Docs: add a "Callsign group rules" section to CLAUDE.md covering:
  - live membership
  - base-call storage
  - the 1,000 cap
  - the empty-filter rule
  - the delete guard
  - the preview ownership filter
  - membership and station counts being resolved only in SQL
  
  Update `docs/ARCHITECTURE.md`.
- Tour: no change unless Brad asks.

## Copy

Transcribed from the mocks, word for word. `docs/ui-mock.html` is a bundled build, so, as with
the callsign-lookup spec, this section is the copy source for these screens. Anything *proposed*
above is added here once Brad approves it.

**Nav:** Groups

**Groups page**
- Title: Groups
- Subtitle: A group is a named list of callsigns, like your club roster. Use groups in subscriptions to get alerts when any member is spotted.
- Button: New group
- Card meta: {N} callsigns · used by {M} subscriptions (singular forms: "1 callsign", "1 subscription")
- Overflow chip: +{N} more
- On-air chip: {N} on the air now
- Latest spot: {CALL} {kHz} kHz {MODE} / {band} · {Source} · {reference} · {age} ago
- Actions: Get alerts · Edit · Delete
- Empty (approved): No groups yet. / button Create your first group
- Delete has no confirmation, as on Destinations and Subscriptions. Disabled tooltip: Remove it
  from its subscriptions first
- Toasts (approved): Created {name} · Saved changes · Deleted {name}. Get alerts reuses the
  profile's: Created {name} on the air · You already have {name}. · Add a destination to start
  getting alerts.

**Group dialog**
- Titles: New group / Edit group
- Field: Group name *
- Subheading: Add callsigns
- Tabs: Type · Paste · Import CSV
- Type tab field: Callsign (placeholder KK4PWJ), button Add
- Type tab helper: Press Enter to add. Spaces or commas add several at once.
- Paste tab (approved): field Callsigns (multi-line, placeholder KK4PWJ, N4DXX, AB4RD), helper
  Separate them with commas, spaces or new lines., button Add
- Import CSV tab (approved): button Choose file; helper One callsign per row. Long Lines uses the
  column headed Call or Callsign, or the first column if there isn't one.; after parsing
  "{file}: using the {Header} column. Found {N} callsigns, skipped {M}." (or "using the first
  column"), then button Add; "No callsigns found in {file}."; "Couldn't read that file."
- Rejected values (approved, under the tab): Not callsigns, so not added: {CALL}, {CALL}, …
  (past 20, it ends "and {N} more")
- Limit refusal (approved, under the tab, nothing added): That would make {N} callsigns. A group
  can hold up to 1,000.
- Panel heading: {N} callsigns
- Panel button: Remove all
- Panel helper: Portable suffixes like /P are removed, so KK4PWJ also matches KK4PWJ/P. Up to 1,000 per group.
- Empty: No callsigns yet. Type, paste, or import them on the left.
- Buttons: Cancel · Create group (new) / Save changes (edit)

**Subscription dialog**
- Callsigns helper, groups selected: Added to the groups below.
- Field: Callsign groups
- Groups helper: Matches {N} stations from your groups and callsigns.

**Errors (from the RPCs)**
- Give the group a name.
- You already have a group with that name.
- Not a callsign: {CALL}.
- A group can hold up to 1,000 callsigns.
- Remove it from its subscriptions first.
- Group not found.

## PR order

1. #129, schema and RPCs (branch `callsign-groups`). Merged 2026-10-13.
2. PR 1b, the changes from the mocks (branch `callsign-groups-ui-fixes`). This
   revision of the spec and the mock images are committed there.
3. PR 2, matching (branch `callsign-group-matching`). Starts after PR 1b merges.
4. PR 3, the Groups page. Also needs only PR 1b, so it can run alongside PR 2. Don't run pgTAP
   in two chats at once: the local stack is shared.
5. PR 4, groups in subscriptions. Needs PRs 2 and 3.

Nothing is pushed, merged or deployed without Brad asking. Merging to main applies the migrations
on hosted through the GitHub integration. Brad isn't letting users in until all of these ship, so
the gap where a group-only subscription matches "any callsign" (until PR 2) is accepted.
