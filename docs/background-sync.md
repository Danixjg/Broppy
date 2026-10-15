# Background sync

Broppy keeps each company's index up to date by syncing its connected tools every 10 minutes, whether or not anyone
is using it. On Vercel there is no long-running process to keep a timer, so the schedule lives in Supabase:

1. **Supabase `pg_cron`** runs the job `broppy-background-sync` every 10 minutes
   ([migration 016](../infra/supabase/migrations/016_background_sync_schedule.sql)).
2. The job calls the API's `POST /v1/cron/sync` with `pg_net`, sending the shared secret as a bearer token.
3. The API checks the secret, lists the companies with at least one
   connected source, least recently synced first, and syncs each one's connected tools. It stops after about 40 seconds
   (`SYNC_CRON_BUDGET_MS`); the companies it didn't reach come first next time.
4. Each run logs one line, `{"event":"background_sync", ...}`, with how many companies were synced, left and failed.
   Each company's own **Sync health** page shows when each tool last synced.

Without a secret anywhere, `/v1/cron/sync` answers 404; with a wrong one, 401.

## Set up

Migration 016 generates the shared secret in Supabase Vault. The API reads it with its service key through
`broppy_sync_cron_secret()`, which only the service role may call, so nobody copies it by hand. Setting
`SYNC_CRON_SECRET` (or Vercel's `CRON_SECRET`) on the API overrides it, and Vault must then hold the same value.

1. Store the API's address in Vault: `select vault.create_secret('https://YOUR-API-HOST', 'broppy_api_origin');`
2. Apply migration 016. Check it with `select * from cron.job_run_details order by start_time desc limit 5;` and
   `select status_code, content from net._http_response order by created desc limit 5;`.

To change how often it runs, reschedule the job: `select cron.schedule('broppy-background-sync', '*/5 * * * *', ...)`
with the same command. To stop it: `select cron.unschedule('broppy-background-sync');`.

## Limits

- A run that takes longer than the function's maximum duration is cut off; what it saved stays saved, and the next run
  continues.
- Sync reads changes since the last checkpoint. A source that refuses (an expired connection, a revoked app) shows
  **Needs attention** on Sync health until the admin reconnects it.
