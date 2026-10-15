-- Background sync: every 10 minutes Supabase asks the API to sync every company with a connected source
-- (POST /v1/cron/sync). The shared secret is generated here, in Vault, and the API reads it with its service key through
-- broppy_sync_cron_secret(), so nobody copies it by hand. The API's address is read from Vault too; create it once with
--   select vault.create_secret('https://YOUR-API-HOST', 'broppy_api_origin');
-- Until it exists the call has no address and simply fails in cron's log. See docs/background-sync.md.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'broppy_sync_cron_secret')
where not exists (select 1 from vault.secrets where name = 'broppy_sync_cron_secret');

create or replace function public.broppy_sync_cron_secret() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'broppy_sync_cron_secret'
$$;
revoke all on function public.broppy_sync_cron_secret() from public, anon, authenticated;
grant execute on function public.broppy_sync_cron_secret() to service_role;

select cron.unschedule('broppy-background-sync') where exists (select 1 from cron.job where jobname = 'broppy-background-sync');
select cron.schedule('broppy-background-sync', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'broppy_api_origin') || '/v1/cron/sync',
    headers := jsonb_build_object('content-type', 'application/json', 'authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'broppy_sync_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
