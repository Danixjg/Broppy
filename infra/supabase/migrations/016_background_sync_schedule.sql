-- Background sync: every 10 minutes Supabase asks the API to sync every company with a connected source
-- (POST /v1/cron/sync). The API's address and the shared secret are read from Vault at each run, so neither is in this
-- file: create them once with
--   select vault.create_secret('https://YOUR-API-HOST', 'broppy_api_origin');
--   select vault.create_secret('<the API''s SYNC_CRON_SECRET>', 'broppy_sync_cron_secret');
-- Until both exist the call has no address and simply fails in cron's log. See docs/background-sync.md.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('broppy-background-sync') where exists (select 1 from cron.job where jobname = 'broppy-background-sync');
select cron.schedule('broppy-background-sync', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'broppy_api_origin') || '/v1/cron/sync',
    headers := jsonb_build_object('content-type', 'application/json', 'authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'broppy_sync_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
