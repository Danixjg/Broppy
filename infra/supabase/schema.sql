-- Broppy baseline schema for a FRESH Supabase project: the end state of migrations 001-007 in one runnable file.
-- Existing databases keep applying infra/supabase/migrations in order; do not run this on top of them.
-- Requires the pgvector and Supabase Vault extensions (both available in Supabase projects) and Supabase Auth (auth.users).
-- org_id defaults to 'demo-company-a' so the demo keeps working; set AUTH0_ORG_ID and insert your organization before live use.
-- org_id columns deliberately have no foreign key to organizations: the API creates rows for AUTH0_ORG_ID without inserting an organizations row.

create extension if not exists vector;
create extension if not exists supabase_vault with schema vault;

create table public.organizations (org_id text primary key, name text not null);
insert into public.organizations values ('demo-company-a', 'Company A');

create table public.workspace_users (
  auth_user_id uuid,
  user_id text not null,
  name text not null,
  email text not null,
  role text not null check (role in ('member', 'admin', 'compliance')),
  groups jsonb not null default '[]'::jsonb check (jsonb_typeof(groups) = 'array'),
  contractor boolean not null default false,
  platform_identities jsonb not null default '{}'::jsonb check (jsonb_typeof(platform_identities) = 'object'),
  auth0_sub text,
  org_id text not null default 'demo-company-a',
  active boolean not null default true,
  primary key (org_id, user_id),
  unique (org_id, auth0_sub),
  unique (org_id, email)
);

create table public.brain_state (org_id text primary key, snapshot jsonb not null);

create table public.source_connections (org_id text not null, source text not null, status text not null,
  scope jsonb not null default '{}', token_secret_id uuid, connected_by text, connected_at timestamptz,
  primary key (org_id, source));

create table public.import_jobs (org_id text not null, source text not null, status text not null,
  progress jsonb not null, primary key (org_id, source));

create table public.source_documents (
  doc_id text primary key,
  source text not null check (source in ('slack', 'jira', 'confluence', 'drive')),
  source_native_id text not null,
  title text not null,
  content text not null,
  url text not null,
  version bigint not null check (version > 0),
  content_hash text not null,
  permission_hash text not null,
  metadata_hash text not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  metadata jsonb not null default '{}',
  permissions jsonb not null,
  tier text not null check (tier in ('open', 'internal', 'restricted')),
  last_indexed_at timestamptz not null,
  last_permission_sync_at timestamptz not null,
  search_vector tsvector generated always as
    (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) stored,
  org_id text not null default 'demo-company-a',
  unique (org_id, source, source_native_id)
);
create index source_documents_active_source_idx on public.source_documents (source) where deleted_at is null;
create index source_documents_search_idx on public.source_documents using gin (search_vector);

create table public.source_chunks (
  chunk_id text primary key,
  doc_id text not null references public.source_documents(doc_id) on delete cascade on update cascade,
  ordinal integer not null,
  content text not null,
  embedding vector(1024),
  search_vector tsvector generated always as (to_tsvector('english', content)) stored,
  org_id text not null default 'demo-company-a',
  unique (doc_id, ordinal)
);
create index source_chunks_doc_idx on public.source_chunks (doc_id);
create index source_chunks_search_idx on public.source_chunks using gin (search_vector);
create index source_chunks_embedding_idx on public.source_chunks using hnsw (embedding vector_cosine_ops);

create table public.connector_state (
  source text not null check (source in ('slack', 'jira', 'confluence', 'drive')),
  cursor text not null,
  last_successful_sync_at timestamptz,
  org_id text not null default 'demo-company-a',
  primary key (org_id, source)
);

create table public.sync_runs (
  run_id bigserial primary key,
  source text not null,
  cursor_from text not null,
  cursor_to text not null,
  checkpoint text,
  pending_ids jsonb not null,
  status text not null check (status in ('running', 'failed', 'complete')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  org_id text not null default 'demo-company-a',
  unique (org_id, source),
  foreign key (org_id, source) references public.connector_state(org_id, source)
);
create index sync_runs_incomplete_idx on public.sync_runs (source, started_at desc) where status <> 'complete';

create table public.audit_entries (
  sequence bigint not null,
  occurred_at timestamptz not null default now(),
  event_type text not null,
  actor_id text not null,
  data jsonb not null,
  previous_hash text not null,
  entry_hash text not null unique,
  org_id text not null default 'demo-company-a',
  payload jsonb,
  primary key (org_id, sequence)
);

create table public.merkle_batches (
  batch_id bigserial primary key,
  first_sequence bigint not null,
  last_sequence bigint not null,
  root_hash text not null,
  sealed_at timestamptz not null default now(),
  org_id text not null default 'demo-company-a',
  payload jsonb,
  check (last_sequence >= first_sequence),
  unique (org_id, first_sequence, last_sequence),
  foreign key (org_id, first_sequence) references public.audit_entries(org_id, sequence),
  foreign key (org_id, last_sequence) references public.audit_entries(org_id, sequence)
);

create table public.user_source_connections (org_id text not null, user_id text not null, source text not null,
  token_secret_id uuid, connected_at timestamptz not null default now(), primary key (org_id, user_id, source));


-- No browser access: identity and authorization are enforced by the API.
alter table public.workspace_users enable row level security;
revoke all on public.workspace_users from public, anon, authenticated;
grant select, insert, update on public.workspace_users to service_role;
alter table public.user_source_connections enable row level security;
revoke all on public.user_source_connections from public, anon, authenticated;
grant select, insert, update, delete on public.user_source_connections to service_role;

create function public.hybrid_search(organization text, query_text text, query_embedding vector(1024), match_count integer)
returns table (doc_id text, chunk_id text, score double precision)
language sql stable security invoker
as $$
  with query as (
    select websearch_to_tsquery('english', query_text) as terms
  )
  select d.doc_id, c.chunk_id,
    (0.65 * coalesce(1 - (c.embedding <=> query_embedding), 0)
      + 0.25 * least(1.0, ts_rank_cd(
        setweight(to_tsvector('english', d.title), 'A') || c.search_vector,
        q.terms, 32))
      + 0.10 / (1 + greatest(0, extract(epoch from (now() - d.updated_at)) / 86400) / 30))::double precision as score
  from source_chunks c
  join source_documents d on d.doc_id = c.doc_id
  cross join query q
  where d.org_id = organization and c.org_id = organization and d.deleted_at is null
    and ((c.embedding is not null and 1 - (c.embedding <=> query_embedding) > 0)
      or c.search_vector @@ q.terms
      or to_tsvector('english', d.title) @@ q.terms)
  order by score desc, d.doc_id, c.chunk_id
  limit greatest(match_count, 0);
$$;

revoke all on function public.hybrid_search(text, text, vector, integer) from public, anon, authenticated;
grant execute on function public.hybrid_search(text, text, vector, integer) to service_role;


create function public.reject_audit_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Audit records are append-only'; end $$;
create trigger audit_immutable before update or delete on public.audit_entries for each statement execute function public.reject_audit_mutation();
create trigger batches_immutable before update or delete on public.merkle_batches for each statement execute function public.reject_audit_mutation();
create trigger audit_no_truncate before truncate on public.audit_entries execute function public.reject_audit_mutation();
create trigger batches_no_truncate before truncate on public.merkle_batches execute function public.reject_audit_mutation();

create function public.append_audit_record(organization text, kind text, record jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare prior text; existing jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(organization, 0));
  if kind = 'entry' then
    select payload into existing from public.audit_entries where org_id = organization and sequence = (record->>'sequence')::bigint;
    if found then
      if existing = record then return; end if;
      raise exception 'Conflicting audit entry';
    end if;
    select entry_hash into prior from public.audit_entries where org_id = organization order by sequence desc limit 1;
    if coalesce(prior, repeat('0',64)) <> record->>'previousHash' then raise exception 'Audit chain conflict'; end if;
    if (record->>'sequence')::bigint <> (select coalesce(max(sequence),0)+1 from public.audit_entries where org_id=organization) then raise exception 'Audit sequence conflict'; end if;
    insert into public.audit_entries(org_id, sequence, occurred_at, event_type, actor_id, data, previous_hash, entry_hash, payload)
    values(organization, (record->>'sequence')::bigint, (record->>'timestamp')::timestamptz,
      record->>'type', record->>'actor', record->'data', record->>'previousHash', record->>'hash', record);
  elsif kind = 'batch' then
    select payload into existing from public.merkle_batches where org_id=organization and first_sequence=(record->>'firstSequence')::bigint;
    if found then
      if existing = record then return; end if;
      raise exception 'Conflicting audit batch';
    end if;
    select root_hash into prior from public.merkle_batches where org_id=organization order by last_sequence desc limit 1;
    if coalesce(prior,repeat('0',64)) <> record->>'previousRoot' then raise exception 'Batch chain conflict'; end if;
    insert into public.merkle_batches(org_id,first_sequence,last_sequence,root_hash,sealed_at,payload)
    values(organization,(record->>'firstSequence')::bigint,(record->>'lastSequence')::bigint,
      record->>'root',(record->>'sealedAt')::timestamptz,record);
  else raise exception 'Invalid audit kind'; end if;
end $$;

create function public.save_brain_state(organization text, snapshot jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare item jsonb;
begin
  insert into public.brain_state values(organization,snapshot) on conflict(org_id) do update set snapshot=excluded.snapshot;
  for item in select value from jsonb_array_elements(snapshot->'states') loop
    insert into public.connector_state(org_id,source,cursor,last_successful_sync_at)
      values(organization,item->>'source',item->>'cursor',(item->>'lastSuccessfulSyncAt')::timestamptz)
      on conflict(org_id,source) do update set cursor=excluded.cursor,last_successful_sync_at=excluded.last_successful_sync_at;
  end loop;
  for item in select value from jsonb_array_elements(snapshot->'runs') loop
    insert into public.sync_runs(org_id,source,cursor_from,cursor_to,checkpoint,pending_ids,status)
      values(organization,item->>'source',item->>'cursorFrom',item->>'cursorTo',item->>'checkpoint',item->'pendingIds',item->>'status')
      on conflict(org_id,source) do update set cursor_from=excluded.cursor_from,cursor_to=excluded.cursor_to,
        checkpoint=excluded.checkpoint,pending_ids=excluded.pending_ids,status=excluded.status;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(snapshot->'connections','[]')) loop
    insert into public.source_connections(org_id,source,status,scope,connected_by,connected_at)
      values(organization,item->>'source',item->>'status',item->'scope',item->>'connectedBy',(item->>'connectedAt')::timestamptz)
      on conflict(org_id,source) do update set status=excluded.status,scope=excluded.scope,connected_by=excluded.connected_by,connected_at=excluded.connected_at;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(snapshot->'jobs','[]')) loop
    insert into public.import_jobs values(organization,item->>'source',item->>'status',item)
      on conflict(org_id,source) do update set status=excluded.status,progress=excluded.progress;
  end loop;
end $$;

-- No browser access: identity and authorization are enforced by the API.
do $$ declare t text; begin
  foreach t in array array['organizations','brain_state','source_connections','import_jobs','source_documents','source_chunks','connector_state','sync_runs','audit_entries','merkle_batches'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to service_role',t);
  end loop;
end $$;
revoke update, delete, truncate on public.audit_entries, public.merkle_batches from service_role;
grant usage, select on sequence public.sync_runs_run_id_seq, public.merkle_batches_batch_id_seq to service_role;
revoke all on function public.save_brain_state(text,jsonb), public.append_audit_record(text,text,jsonb), public.reject_audit_mutation() from public, anon, authenticated;
grant execute on function public.save_brain_state(text,jsonb), public.append_audit_record(text,text,jsonb) to service_role;


-- Source token Vault functions (migration 005).
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

-- Per-user source token functions (migration 007).
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
