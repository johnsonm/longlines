-- Cron calls stop carrying the service-role key (review 4, database: connections, finding 3).
--
-- cron_call_function put "Authorization: Bearer <service-role key from Vault>" in every request it
-- queued with pg_net. net.http_request_queue is supabase_admin's, granted to PUBLIC, and postgres
-- cannot revoke that grant, so any role that can log in, delivery_sender included, could read the
-- key from the queue while a request waited there.
--
-- cron_call_function: as in 20261021000100, sending the anon key as the bearer (Vault
-- longlines_anon_key: the legacy anon JWT, public anyway, which gets a request past the gateway's
-- verify_jwt) and the cron secret in x-cron-secret (Vault longlines_cron_secret, equal to the
-- functions' LONGLINES_CRON_SECRET). isServiceRole (_shared/auth.ts) accepts that header, so every
-- cron-called function keeps verify_jwt = true. The cron secret still sits in the queue, but it
-- only starts the cron-called functions (ingest, archive, imports), not database or Auth admin
-- access, and it can be rotated on its own.
--
-- Rollout: until both new secrets exist in Vault, cron_call_function falls back to the old
-- service-role header, so a db push ahead of the operator's steps (docs/OPERATIONS.md) does not
-- break cron. The signature, defaults and grants are unchanged; missing URL or keys still fail the
-- run as before.
create or replace function public.cron_call_function(
  p_job text,
  p_function text,
  p_body jsonb default '{}'::jsonb,
  p_timeout_ms int default 30000
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      bigint;
  v_anon    text := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_anon_key');
  v_cron    text := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_cron_secret');
  v_headers jsonb;
begin
  if coalesce(v_anon, '') <> '' and coalesce(v_cron, '') <> '' then
    v_headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'x-cron-secret', v_cron
    );
  else
    -- Rollout fallback (see the header): the service-role key, as before. Goes once the hosted
    -- Vault holds both new secrets.
    v_headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
    );
  end if;
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
           || '/functions/v1/' || p_function,
    headers := v_headers,
    body := p_body,
    timeout_milliseconds := p_timeout_ms
  ) into v_id;
  insert into cron_http_requests (request_id, job) values (v_id, p_job);
  return v_id;
end;
$$;
