-- The Slack service secret (SLACK_SERVICE_TOKEN), from which each company's Slack installation gets its own secret.
-- Generated here, in Vault; the API reads it with its service key through broppy_slack_service_token(), so nobody
-- copies it by hand. Setting SLACK_SERVICE_TOKEN on the API overrides it.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'broppy_slack_service_token')
where not exists (select 1 from vault.secrets where name = 'broppy_slack_service_token');

create or replace function public.broppy_slack_service_token() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'broppy_slack_service_token'
$$;
revoke all on function public.broppy_slack_service_token() from public, anon, authenticated;
grant execute on function public.broppy_slack_service_token() to service_role;
