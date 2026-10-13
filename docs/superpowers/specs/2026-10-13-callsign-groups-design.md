# Callsign groups: design

Date: 2026-10-13. Status: **Section 1 (schema and RPCs) approved.** Sections 2–4 are proposals.
Before implementing one of them, its PR's chat presents it to Brad and gets a yes. If the design
changes, update this file in that PR.

## Purpose

A user keeps named lists of callsigns, such as a club roster, an award list or friends, and points
subscriptions at them instead of retyping calls. A typical list is a few hundred calls, but
the design must handle tens of thousands. Lists are entered by typing, by pasting a block of
text, or by importing a CSV file.

## What Brad asked for

- A group is a name plus a list of callsigns.
- A user can have any number of groups. Group names are unique within the account.
- The size of a group is effectively unlimited.
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
| Deleting a group in use | Refused: "Remove it from its subscriptions first." This mirrors destinations. |
| Deduplication | Comes from the design: group membership is tested with `exists`. `match_pending_spots` already makes one delivery per (destination, spot), and the quiet window is per (subscription, callsign). |
| Storage approach | Normalised and indexed (approach A). Members sit in their own table and the matcher looks them up through an index. Rejected: a merged array on `subscriptions` kept current by triggers (linear `= any` scans, every subscription rewritten when a group changes), and copying calls into the subscription on save (edits wouldn't reach existing subscriptions). |
| CSV columns | Use the column headed `call`, `callsign`, `call sign` or `call_sign` (case-insensitive) if there is one. Otherwise use the first column. Show the parsed calls and the rejected cells before adding. |
| Export | Not in scope. |

## Section 1: Schema and RPCs (approved; PR 1)

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

## Section 2: Matching (proposed; PR 2)

Migration `20261013000110_callsign_group_matching.sql`.

- New helper: `group_matches(p_group_ids uuid[], p_call text, p_base text) returns boolean`,
  `stable`, with a pinned search path. It returns `cardinality(p_group_ids) > 0 and exists
  (select 1 from public.callsign_group_members m where m.callsign in (p_call, p_base) and
  m.group_id = any (p_group_ids))`. Revoke it from clients.
- `spot_matches` becomes `stable`, because it now reads a table. Its callsign clause becomes:
  `(cardinality(sub.callsigns) = 0 and cardinality(sub.group_ids) = 0) or
  callsign_matches(sub.callsigns, …) or group_matches(sub.group_ids, …)`. The RBN guard becomes
  `spot.source <> 'rbn' or cardinality(sub.callsigns) > 0 or cardinality(sub.group_ids) > 0`.
  (PR 1 already relaxed the save-time trigger the same way.)
  Update `advisor.test.sql` if `spot_matches` leaves the unpinned-helper list. Update the
  CLAUDE.md bullet that calls RBN matching "subscriptions that name callsigns": groups count.
- `watched_among` has to cover group members. It runs on every RBN firehose batch, so drive it
  from the member index rather than looping over subscriptions. Roughly: the distinct calls in
  the batch → members whose `callsign in (c, b)` → enabled subscriptions whose `group_ids`
  contain that group and whose `source_matches` holds. A GIN index on `subscriptions.group_ids`
  may help; decide with `EXPLAIN ANALYZE`.
- `preview_subscription` reads `filter -> 'group_ids'` and keeps only the caller's ids:
  `array(select g.id from callsign_groups g where g.user_id = auth.uid() and g.id = any (…))`.
  It passes them into the row it builds. The matcher and the preview keep sharing `spot_matches`.
- `match_pending_spots` is unchanged. Confirm that a spot whose call is in two of a
  subscription's groups produces one candidate row.
- **Performance check:** use a 50,000-member group, 20 subscriptions using groups, and a batch of
  500 spots, plus a 1,000-call `watched_among` batch. Record timings in the PR. The matcher runs
  every minute and after every ingest.
- **Tests:** extend `matcher.test.sql` and `rbn.test.sql` (the watched set), and add preview
  cases: the merge and deduplication, an empty group matching nothing, mixed typed and group
  calls, base-call matching through a group, and another user's group id being ignored in
  preview.

## Section 3: Groups page (proposed; PR 3)

**Copy first.** Add a Groups section to `docs/ui-mock.html` before building, since the web app
uses the mock's copy word for word. Show the proposed copy to Brad in chat and get a yes before
writing it.

- New route `/groups` (RequireAuth) and a nav item **Groups** between Subscriptions and
  Destinations.
- **List view.** One row per group: name, "N calls", "Used by M subscriptions". Each row has
  rename and delete actions. If the delete guard fires, show its message. A "New group" button
  opens a name dialog.
- **Group detail** (a dialog or `/groups/:id`; follow how Destinations does it):
  - A member list that is paged (1,000 per page, the PostgREST cap) and searchable.
  - Multi-select, with "Remove selected".
  - **Add calls:** a chip input for typing (Enter or comma), and a "Paste a list" text area.
    It splits on commas, whitespace, semicolons and newlines.
  - **Import CSV:** a file picker that runs the column detection from the Decisions table.
  - **Confirm step** for paste and import: "N calls found, K rejected", with the rejected
    examples and the detected column name. Add, then send to `add_group_callsigns` in chunks of
    2,000 with a progress indicator, and report the summed added, already and rejected counts.
- **Pure parsing module** `web/src/groups/parse.ts`, unit-tested in node:
  - It contains a small CSV parser: quoted fields, embedded commas, doubled quotes, CRLF, and a BOM.
  - Adding a dependency would need a justifying comment, and none is warranted for this.
  - Column detection and paste splitting.
  - Client-side validation with `isValidCallsign`, for the preview counts only. The server is
    authoritative.
- `web/src/lib/api.ts` gains typed functions for each RPC and for the paged member read.
  Regenerate `database.types.ts`.
- Tests: component tests through `web/src/test/render.tsx` with `vi.mock("../lib/api")`,
  covering the phone layout (`setMobile(true)`) and the confirm and chunked-add flow. Meet the
  80% coverage gate.

## Section 4: Groups in subscriptions (proposed; PR 4)

- `SubscriptionDialog` gets a **Groups** multi-select (an autocomplete over
  `list_callsign_groups`) next to Callsigns. The helper text says the groups and the typed calls
  are merged, and that a call is never sent twice. Take that text from the mock and add it there
  first.
- `SubscriptionInput` gains `group_ids`. Also update `blankSub`, `toInput` and the preview
  payload, which adds `group_ids` to the memoised JSON key.
- `filterChips` shows group names, for example "Group: Club roster". The subscriptions list
  needs the group names, so it either joins `list_callsign_groups` or receives the names from
  `api.ts`. Never resolve membership in TypeScript.
- With no groups, the picker shows a link to `/groups` in its place.
- Docs: add a "Callsign group rules" section to CLAUDE.md covering live membership, the
  empty-filter rule, the delete guard, the preview ownership filter, and that membership is never
  resolved in TypeScript. Update `docs/ARCHITECTURE.md`.
- Tour: no change unless Brad asks.

## PR order

1. Schema and RPCs (branch `callsign-groups`, worktree `../longlines-callsign-groups`). This
   spec is committed there.
2. Matching. Starts after PR 1 merges.
3. Groups page. Needs PR 1 only, so it can run alongside PR 2. Don't run pgTAP in two chats at
   once: the local stack is shared.
4. Groups in subscriptions. Needs PRs 2 and 3.

Nothing is pushed, merged or deployed without Brad asking. Merging to main applies the migrations
on hosted through the GitHub integration.
