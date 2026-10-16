-- One-time setup: let the outbound sender log in as its database role.
--
-- 20261015000200_sender_role.sql creates `delivery_sender` with nologin and no
-- password (roles are cluster-wide, so the migration never carries one). The
-- sender process on Fly (sender/) connects as this role through the Supavisor
-- pooler, so the hosted project needs this once, after `supabase db push`,
-- either in the Studio SQL editor or with psql:
--
--   psql "$DATABASE_URL" -f scripts/setup-sender-role.sql
--
-- Replace the placeholder first (`openssl rand -base64 32` is fine). Do NOT
-- commit a copy with the real value. Then hand the URL to the sender; the
-- username carries the project ref because the pooler routes on it, the host
-- and port are the project's session pooler (Dashboard, Connect, "Session
-- pooler": port 5432, IPv4), and a password with reserved characters must be
-- URL-encoded:
--
--   fly secrets set -a longlines-sender \
--     SENDER_DATABASE_URL='postgresql://delivery_sender.<PROJECT_REF>:<PASSWORD>@<POOLER_HOST>:5432/postgres'
--
-- To rotate: run the alter again with a new value, then set the secret again
-- (the sender restarts on the secret change and reconnects). The role's
-- connection limit, timeouts and search_path come from the migration and are
-- not repeated here. Local development never runs this: `npm run sender` uses
-- the stack's postgres URL.

alter role delivery_sender with login password '<PASSWORD>';

-- Verify (no secrets in the output):
-- select rolname, rolcanlogin, rolconnlimit from pg_roles where rolname = 'delivery_sender';
