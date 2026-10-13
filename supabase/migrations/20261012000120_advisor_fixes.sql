-- Security advisor fixes. Earlier migrations are applied and so not edited.
--
-- Anon could execute the Phase 2 RPCs. 20261006000001/2/3/7 revoked their
-- functions from public only, but Supabase's default privileges grant EXECUTE
-- on new functions to anon and authenticated directly, so both kept it. The
-- RPCs refuse a caller without auth.uid(), so nothing leaked, but the grants
-- were never meant to be there. The helpers in those migrations run only
-- inside definer RPCs and the matcher, and trigger functions fire without
-- EXECUTE, so none of them needs a client grant.
--
-- callsign_available stays callable by anon on purpose: the sign-up form asks
-- before there is a session (20261006000001).
--
-- The default-privileges entry that granted anon and authenticated directly on
-- new public functions is trimmed, so `revoke all ... from public` is enough
-- to close a new function again. The built-in PUBLIC grant stays: revoking it
-- globally would also close pg_temp test helpers and pgTAP when postgres
-- installs it. service_role keeps its default grant.
--
-- search_path: the helpers below get an empty search_path. Their bodies use
-- only pg_catalog and schema-qualified public functions, so nothing resolves
-- differently. Left alone on purpose:
--   * mode_bucket, is_self_spot, spot_matches, source_matches and
--     callsign_matches are one-expression SQL functions that Postgres inlines;
--     a SET clause stops that. Pinned, mode_bucket ran 10x slower and
--     is_self_spot 20x slower, and both run per row over the RBN rollups and
--     the stats refresh. They are invoker functions over pg_catalog and
--     qualified public names, so a caller's search_path cannot redirect them.
--   * int_array_sum is an aggregate; Postgres has no SET clause for one. Its
--     transition function int_array_add is pinned instead.
-- supabase/tests/advisor.test.sql keeps every list here from growing.

revoke execute on function public.create_destination(text, text, text) from anon;
revoke execute on function public.rotate_signing_secret(uuid) from anon;
revoke execute on function public.save_subscription(jsonb) from anon;
revoke execute on function public.delete_subscription(uuid) from anon;
revoke execute on function public.preview_subscription(jsonb) from anon;

revoke all on function public.parse_https_url(text) from public, anon, authenticated;
revoke all on function public.is_private_host(text) from public, anon, authenticated;
revoke all on function public.validate_destination_url(text, text) from public, anon, authenticated;
revoke all on function public.destination_url_display(text, text) from public, anon, authenticated;
revoke all on function public.jsonb_text_array(jsonb, text) from public, anon, authenticated;
revoke all on function public.spot_matches(subscriptions, raw_spots) from public, anon, authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_delete() from public, anon, authenticated;
revoke all on function public.normalize_profile_callsign() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.subscriptions_rbn_needs_callsign() from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

alter function public.normalize_profile_callsign() set search_path = '';
alter function public.set_updated_at() set search_path = '';
alter function public.subscriptions_rbn_needs_callsign() set search_path = '';
alter function public.parse_https_url(text) set search_path = '';
alter function public.is_private_host(text) set search_path = '';
alter function public.validate_destination_url(text, text) set search_path = '';
alter function public.destination_url_display(text, text) set search_path = '';
alter function public.jsonb_text_array(jsonb, text) set search_path = '';
alter function public.archive_slice_minutes(text) set search_path = '';
alter function public.last_rollup_day() set search_path = '';
alter function public.int_array_add(int[], int[]) set search_path = '';
-- Output is unchanged, so rbn_spots_base_callsign_time_idx stays valid.
alter function public.base_callsign(text) set search_path = '';
