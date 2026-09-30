-- Requires Supabase Vault (enabled by default in Supabase projects).
create extension if not exists supabase_vault with schema vault;
create function public.store_source_token(organization text, provider text, token jsonb, actor text)
returns void language plpgsql security invoker set search_path = '' as $$
declare secret_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(organization || '/' || provider, 0));
  select token_secret_id into secret_id from public.source_connections where org_id=organization and source=provider;
  if secret_id is null then
    select vault.create_secret(token::text) into secret_id;
  else
    perform vault.update_secret(secret_id, token::text);
  end if;
  insert into public.source_connections(org_id,source,status,scope,token_secret_id,connected_by,connected_at)
    values(organization,provider,'Connected','{}',secret_id,actor,now())
    on conflict(org_id,source) do update set token_secret_id=excluded.token_secret_id;
end $$;
create function public.read_source_token(organization text, provider text)
returns jsonb language sql security invoker set search_path = '' as $$
  select s.decrypted_secret::jsonb from public.source_connections c join vault.decrypted_secrets s on s.id=c.token_secret_id
  where c.org_id=organization and c.source=provider;
$$;
create function public.remove_source_token(organization text, provider text)
returns void language plpgsql security invoker set search_path = '' as $$
declare secret_id uuid;
begin
  select token_secret_id into secret_id from public.source_connections where org_id=organization and source=provider;
  update public.source_connections set token_secret_id=null where org_id=organization and source=provider;
  delete from vault.secrets where id=secret_id;
end $$;
revoke all on function public.store_source_token(text,text,jsonb,text), public.read_source_token(text,text), public.remove_source_token(text,text) from public, anon, authenticated;
grant execute on function public.store_source_token(text,text,jsonb,text), public.read_source_token(text,text), public.remove_source_token(text,text) to service_role;
grant usage on schema vault to service_role;
grant select on vault.decrypted_secrets to service_role;
grant select, insert, update, delete on vault.secrets to service_role;
grant execute on function vault.create_secret(text,text,text,uuid), vault.update_secret(uuid,text,text,text) to service_role;
