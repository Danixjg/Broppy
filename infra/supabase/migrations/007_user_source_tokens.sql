-- Per-user source connections: one Vault secret per (organization, user, source), alongside the org-wide admin connection.
create table public.user_source_connections (org_id text not null, user_id text not null, source text not null,
  token_secret_id uuid, connected_at timestamptz not null default now(), primary key (org_id, user_id, source));
alter table public.user_source_connections enable row level security;
revoke all on public.user_source_connections from public, anon, authenticated;
grant select, insert, update, delete on public.user_source_connections to service_role;

create function public.store_user_source_token(organization text, person text, provider text, token jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare secret_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(organization || '/' || person || '/' || provider, 0));
  select token_secret_id into secret_id from public.user_source_connections where org_id=organization and user_id=person and source=provider;
  if secret_id is null then
    select vault.create_secret(token::text) into secret_id;
  else
    perform vault.update_secret(secret_id, token::text);
  end if;
  insert into public.user_source_connections(org_id,user_id,source,token_secret_id,connected_at)
    values(organization,person,provider,secret_id,now())
    on conflict(org_id,user_id,source) do update set token_secret_id=excluded.token_secret_id, connected_at=excluded.connected_at;
end $$;

create function public.read_user_source_token(organization text, person text, provider text)
returns jsonb language sql security invoker set search_path = '' as $$
  select s.decrypted_secret::jsonb from public.user_source_connections c join vault.decrypted_secrets s on s.id=c.token_secret_id
  where c.org_id=organization and c.user_id=person and c.source=provider;
$$;

-- person null purges every user's connection to the provider (used when an admin disconnects the source).
create function public.remove_user_source_tokens(organization text, person text, provider text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from vault.secrets where id in (select token_secret_id from public.user_source_connections
    where org_id=organization and source=provider and (person is null or user_id=person) and token_secret_id is not null);
  delete from public.user_source_connections where org_id=organization and source=provider and (person is null or user_id=person);
end $$;

create function public.list_user_source_connections(organization text, person text)
returns table(source text, connected_at timestamptz) language sql security invoker set search_path = '' as $$
  select source, connected_at from public.user_source_connections where org_id=organization and user_id=person and token_secret_id is not null;
$$;

revoke all on function public.store_user_source_token(text,text,text,jsonb), public.read_user_source_token(text,text,text),
  public.remove_user_source_tokens(text,text,text), public.list_user_source_connections(text,text) from public, anon, authenticated;
grant execute on function public.store_user_source_token(text,text,text,jsonb), public.read_user_source_token(text,text,text),
  public.remove_user_source_tokens(text,text,text), public.list_user_source_connections(text,text) to service_role;
