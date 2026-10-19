-- A new webhook pauses after 20 failed requests by default (webhook spec,
-- decision 10). 20261018000300 kept the pause null until the web editor,
-- which shows a paused webhook and turns it back on, shipped with this
-- migration. Existing webhooks keep what they have: only the defaults that the
-- trigger, save_webhook_destination and the preview start from change.
-- Otherwise webhook_default_settings is unchanged from 20261018000300;
-- create or replace keeps its grants (none beyond the owner and service_role).
create or replace function public.webhook_default_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'fields', jsonb_build_array('id', 'time', 'callsign', 'frequency', 'mode', 'band', 'source', 'reference',
                                'place_name', 'state', 'spotter'),
    'key_style', 'snake',
    'time_format', 'iso_utc',
    'frequency_unit', 'khz',
    'missing_values', 'omit',
    'batch_seconds', 0,
    'retry_policy', 'three_10m',
    'pause_after_failures', 20);
$$;
