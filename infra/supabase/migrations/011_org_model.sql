-- The chat model an organization's admin chose (Anthropic, OpenAI or any OpenAI-compatible server). The API key lives
-- in Supabase Vault; the table holds only a reference to it. Requires migration 005 (Vault grants).
create table public.org_models (org_id text primary key, provider text not null check (provider in ('anthropic','openai','openai_compatible')),
  model text not null, base_url text, secret_id uuid, updated_by text not null, updated_at timestamptz not null default now());
alter table public.org_models enable row level security;
revoke all on public.org_models from public, anon, authenticated;
grant select, insert, update, delete on public.org_models to service_role;
create function public.store_org_model(organization text, provider_name text, model_name text, endpoint text, api_key text, actor text)
returns void language plpgsql security invoker set search_path = '' as $$
declare existing uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org_model/' || organization, 0));
  select secret_id into existing from public.org_models where org_id = organization;
  if existing is null then
    select vault.create_secret(api_key) into existing;
  else
    perform vault.update_secret(existing, api_key);
  end if;
  insert into public.org_models(org_id, provider, model, base_url, secret_id, updated_by, updated_at)
    values (organization, provider_name, model_name, endpoint, existing, actor, now())
    on conflict (org_id) do update set provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
      secret_id = excluded.secret_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;
create function public.read_org_model(organization text)
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('provider', m.provider, 'model', m.model, 'baseUrl', m.base_url,
    'apiKey', s.decrypted_secret, 'updatedBy', m.updated_by, 'updatedAt', m.updated_at))
  from public.org_models m join vault.decrypted_secrets s on s.id = m.secret_id where m.org_id = organization;
$$;
create function public.remove_org_model(organization text)
returns void language plpgsql security invoker set search_path = '' as $$
declare existing uuid;
begin
  select secret_id into existing from public.org_models where org_id = organization;
  delete from public.org_models where org_id = organization;
  delete from vault.secrets where id = existing;
end $$;
revoke all on function public.store_org_model(text,text,text,text,text,text), public.read_org_model(text), public.remove_org_model(text) from public, anon, authenticated;
grant execute on function public.store_org_model(text,text,text,text,text,text), public.read_org_model(text), public.remove_org_model(text) to service_role;
