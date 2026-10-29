-- One-time setup: store the values the cron jobs need in Supabase Vault.
--
-- Run ONCE against the hosted project after `supabase db push`, either in the
-- Studio SQL editor or with psql:
--
--   psql "$DATABASE_URL" -f scripts/setup-db-settings.sql
--
-- Replace the placeholders first. Do NOT commit a copy with real values.
--
-- cron_call_function (20261029000500) sends the anon key and the cron secret once both
-- longlines_anon_key and longlines_cron_secret exist, and only falls back to
-- longlines_service_role_key until then (pg_net's queue is readable by every role, so the
-- service-role key should not go through it). Set LONGLINES_CRON_SECRET on the functions first
-- (docs/OPERATIONS.md, "Cron secret").
--
-- To rotate a value later:
--   select vault.update_secret(id, '<new value>') from vault.secrets where name = 'longlines_service_role_key';

select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'longlines_supabase_url',
  'Long Lines: project URL used by cron to reach the ingest Edge Functions');

select vault.create_secret('<SERVICE_ROLE_KEY>', 'longlines_service_role_key',
  'Long Lines: service-role key cron sends only until the two secrets below exist');

select vault.create_secret('<LEGACY_ANON_JWT>', 'longlines_anon_key',
  'Long Lines: anon key (legacy JWT) cron sends as Bearer token to pass verify_jwt');

select vault.create_secret('<CRON_SECRET>', 'longlines_cron_secret',
  'Long Lines: x-cron-secret header; equals the functions'' LONGLINES_CRON_SECRET');

-- Verify (values are decrypted on read; do not paste the output anywhere):
-- select name, created_at from vault.secrets where name like 'longlines_%';
