-- Broppy baseline schema for a FRESH Supabase project: the end state of migrations 001-018 in one runnable file.
-- Existing databases keep applying infra/supabase/migrations in order; do not run this on top of them.
-- Requires the pgvector and Supabase Vault extensions (both available in Supabase projects) and Supabase Auth (auth.users).
-- org_id defaults to 'demo-company-a' so the demo keeps working; set AUTH0_ORG_ID and insert your organization before live use.
-- org_id columns deliberately have no foreign key to organizations: the API creates rows for AUTH0_ORG_ID without inserting an organizations row.

create extension if not exists vector;
create extension if not exists supabase_vault with schema vault;

create table public.organizations (org_id text primary key, name text not null,
  status text not null default 'active' check (status in ('active', 'suspended')), created_by_email text, created_at timestamptz not null default now(),
  kind text check (kind in ('company', 'personal')));
insert into public.organizations (org_id, name) values ('demo-company-a', 'Company A');

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

-- 008: OAuth sign-in state shared by every API instance
-- The state itself is stored only as a SHA-256 hash.
create table public.oauth_flows (org_id text not null, state_hash text not null, provider text not null, flow_mode text not null,
  person text not null, person_sub text not null, code_verifier text not null, expires_at timestamptz not null,
  primary key (org_id, state_hash));
alter table public.oauth_flows enable row level security;
revoke all on public.oauth_flows from public, anon, authenticated;
grant select, insert, update, delete on public.oauth_flows to service_role;

create function public.begin_oauth_flow(organization text, state_hash text, provider text, flow_mode text, person text, person_sub text, code_verifier text, ttl_seconds integer)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.oauth_flows where expires_at < now();
  insert into public.oauth_flows(org_id,state_hash,provider,flow_mode,person,person_sub,code_verifier,expires_at)
    values(organization,state_hash,provider,flow_mode,person,person_sub,code_verifier,now() + pg_catalog.make_interval(secs => ttl_seconds));
end $$;

create function public.consume_oauth_flow(organization text, state_hash text)
returns jsonb language sql security invoker set search_path = '' as $$
  with taken as (delete from public.oauth_flows f where f.org_id=organization and f.state_hash=consume_oauth_flow.state_hash and f.expires_at > now() returning f.*)
  select pg_catalog.to_jsonb(taken) - 'org_id' - 'state_hash' - 'expires_at' from taken;
$$;

revoke all on function public.begin_oauth_flow(text,text,text,text,text,text,text,integer), public.consume_oauth_flow(text,text) from public, anon, authenticated;
grant execute on function public.begin_oauth_flow(text,text,text,text,text,text,text,integer), public.consume_oauth_flow(text,text) to service_role;

create table public.slack_task_links (
  org_id text not null,
  project text not null,
  fingerprint text not null,
  title text not null,
  tokens text[] not null,
  issue_key text not null,
  issue_url text not null,
  assignee_slack_id text not null,
  tracked_by text not null,
  channel text not null,
  message_ts text not null,
  mention_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project, fingerprint)
);
create index slack_task_links_recent on public.slack_task_links (org_id, project, updated_at desc);

create table public.slack_claims (
  org_id text not null,
  key text not null,
  claimed_at timestamptz not null default now(),
  primary key (org_id, key)
);

alter table public.slack_task_links enable row level security;
alter table public.slack_claims enable row level security;
revoke all on public.slack_task_links, public.slack_claims from public, anon, authenticated;
grant select, insert, update on public.slack_task_links to service_role;
grant select, insert, delete on public.slack_claims to service_role;

create function public.record_slack_task_repeat(organization text, project_key text, task_fingerprint text,
  repeat_channel text, repeat_ts text)
returns void language sql security invoker set search_path = '' as $$
  update public.slack_task_links
    set mention_count = mention_count + 1, updated_at = now(), channel = repeat_channel, message_ts = repeat_ts
    where org_id = organization and project = project_key and fingerprint = task_fingerprint;
$$;
revoke all on function public.record_slack_task_repeat(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.record_slack_task_repeat(text,text,text,text,text) to service_role;

begin;

alter table public.slack_task_links add column source jsonb not null default '{}'::jsonb;
alter table public.slack_task_links add column operation_id uuid;
alter table public.slack_task_links add column title_fingerprint text;
update public.slack_task_links set title_fingerprint=fingerprint;
create index slack_task_links_exact_title on public.slack_task_links(org_id,project,title_fingerprint,created_at);

create table public.slack_task_proposals (
  org_id text not null,
  id uuid not null,
  source_key text not null,
  revision integer not null check (revision >= 1),
  status text not null check (status in ('pending','dismissed','linked','created')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id,id),
  unique (org_id,source_key)
);

create table public.slack_task_operations (
  org_id text not null,
  id uuid not null,
  project text not null,
  fingerprint text not null,
  proposal_id uuid not null,
  state text not null check (state in ('reserved','creating','remote_succeeded','linked','notifying','notified','uncertain','refused')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id,id),
  unique (org_id,project,fingerprint),
  foreign key (org_id,proposal_id) references public.slack_task_proposals(org_id,id)
);

create table public.slack_link_operations (
  org_id text not null,
  id uuid not null,
  project text not null,
  fingerprint text not null,
  proposal_id uuid not null,
  state text not null check (state in ('remote_succeeded','linked','notifying','notified')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id,id),
  unique (org_id,proposal_id),
  foreign key (org_id,proposal_id) references public.slack_task_proposals(org_id,id)
);

create table public.slack_legacy_fences (
  org_id text not null,
  project text not null,
  fingerprint text not null,
  channel text not null,
  message_ts text not null,
  created_at timestamptz not null default now(),
  primary key (org_id,project,fingerprint,channel,message_ts)
);

create table public.slack_task_sightings (
  org_id text not null,
  project text not null,
  fingerprint text not null,
  channel text not null,
  message_ts text not null,
  created_at timestamptz not null default now(),
  primary key (org_id,project,fingerprint,channel,message_ts),
  foreign key (org_id,project,fingerprint) references public.slack_task_links(org_id,project,fingerprint)
);

create table public.slack_completion_observations (
  org_id text not null,
  project text not null,
  fingerprint text not null,
  category text not null check (category in ('new','indeterminate','done')),
  provider_version text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id,project,fingerprint)
);

create table public.slack_completion_feedback (
  org_id text not null,
  id uuid not null,
  project text not null,
  fingerprint text not null,
  state text not null check (state in ('pending','sending','delivered','uncertain')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id,id),
  unique (org_id,project,fingerprint)
);

insert into public.slack_task_proposals (org_id,id,source_key,revision,status,payload)
select org_id, md5('legacy:' || org_id || ':' || project || ':' || fingerprint)::uuid,
  jsonb_build_array('',channel,message_ts)::text, 1, 'linked',
  jsonb_build_object('id',md5('legacy:' || org_id || ':' || project || ':' || fingerprint)::uuid,
    'revision',1,'status','linked','issueKey',issue_key,'issueUrl',issue_url,'reviewerSlackId',tracked_by,
    'suggestion',jsonb_build_object('t',title,'a',assignee_slack_id,'p',project,'c',channel,'ts',message_ts,'s',''))
from public.slack_task_links on conflict do nothing;

create function public.save_slack_proposal(organization text, proposal jsonb, expected_revision integer default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_row public.slack_task_proposals; origin text; target_proposal_id uuid;
begin
  target_proposal_id := (proposal->>'id')::uuid;
  origin := jsonb_build_array(coalesce(proposal->>'teamId',''),proposal#>>'{suggestion,c}',proposal#>>'{suggestion,ts}')::text;
  if expected_revision is null then
    if (proposal->>'revision')::integer <> 1 then return false; end if;
    insert into public.slack_task_proposals(org_id,id,source_key,revision,status,payload)
      values (organization,target_proposal_id,origin,1,proposal->>'status',proposal) on conflict do nothing;
    return found;
  end if;
  select * into current_row from public.slack_task_proposals where org_id=organization and id=target_proposal_id for update;
  if not found or current_row.revision<>expected_revision or (proposal->>'revision')::integer<>expected_revision+1 or current_row.status<>'pending' or current_row.source_key<>origin then return false; end if;
  if current_row.payload->'teamId' is distinct from proposal->'teamId'
    or current_row.payload->'authorSlackId' is distinct from proposal->'authorSlackId'
    or current_row.payload->'permalink' is distinct from proposal->'permalink'
    or current_row.payload->'reviewerSlackId' is distinct from proposal->'reviewerSlackId'
    or current_row.payload#>'{suggestion,s}' is distinct from proposal#>'{suggestion,s}'
    or current_row.payload#>'{suggestion,th}' is distinct from proposal#>'{suggestion,th}' then return false; end if;
  if exists (select 1 from public.slack_task_operations where org_id=organization and slack_task_operations.proposal_id=target_proposal_id and (state<>'refused' or payload ? 'issueKey'))
    or exists (select 1 from public.slack_link_operations where org_id=organization and slack_link_operations.proposal_id=target_proposal_id) then return false; end if;
  delete from public.slack_task_operations where org_id=organization and slack_task_operations.proposal_id=target_proposal_id and state='refused' and not (payload ? 'issueKey');
  update public.slack_task_proposals set revision=expected_revision+1,status=proposal->>'status',payload=proposal,updated_at=now() where org_id=organization and id=target_proposal_id;
  return true;
end $$;

create function public.complete_slack_proposal(organization text, proposal_id uuid, expected_revision integer, operation_id uuid,
  task_fingerprint text, reviewed_by text, reviewed_at text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare stored public.slack_task_proposals; op public.slack_task_operations; result jsonb; next_status text;
begin
  select * into stored from public.slack_task_proposals where org_id=organization and id=proposal_id for update;
  if not found or stored.status<>'pending' or stored.revision<>expected_revision then return null; end if;
  select * into op from public.slack_task_operations where org_id=organization and id=operation_id;
  if not found then select * into op from public.slack_link_operations where org_id=organization and id=operation_id; end if;
  if not found or op.state not in ('remote_succeeded','linked','notifying','notified') or op.project<>stored.payload#>>'{suggestion,p}'
    or op.fingerprint<>task_fingerprint or not (op.payload ? 'issueKey') or not (op.payload ? 'issueUrl')
    or (op.proposal_id=proposal_id and (op.payload->>'proposalRevision')::integer<>expected_revision) then return null; end if;
  next_status := case when op.proposal_id<>proposal_id or (op.payload->>'existing')::boolean then 'linked' else 'created' end;
  result := stored.payload || jsonb_build_object('revision',expected_revision+1,'status',next_status,'operationId',operation_id,
    'issueKey',op.payload->>'issueKey','issueUrl',op.payload->>'issueUrl','reviewedBy',reviewed_by,'reviewedAt',reviewed_at);
  update public.slack_task_proposals set revision=expected_revision+1,status=next_status,payload=result,updated_at=now() where org_id=organization and id=proposal_id;
  return result;
end $$;

create function public.reserve_slack_operation(organization text, proposal_id uuid, expected_revision integer,
  operation_id uuid, task_fingerprint text, actor_slack_id text, existing_issue jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare stored public.slack_task_proposals; result jsonb; project_key text; operation_state text;
begin
  select * into stored from public.slack_task_proposals where org_id=organization and id=proposal_id for update;
  if not found or stored.revision<>expected_revision or stored.status<>'pending' then return null; end if;
  select payload into result from public.slack_link_operations where org_id=organization and slack_link_operations.proposal_id=reserve_slack_operation.proposal_id;
  if found then return result; end if;
  project_key := stored.payload#>>'{suggestion,p}';
  operation_state := case when existing_issue is null then 'reserved' else 'remote_succeeded' end;
  if existing_issue is null and exists (select 1 from public.slack_claims where org_id=organization and key='track:' || (stored.payload#>>'{suggestion,c}') || ':' || (stored.payload#>>'{suggestion,ts}')) then
    insert into public.slack_legacy_fences(org_id,project,fingerprint,channel,message_ts)
      values (organization,project_key,task_fingerprint,stored.payload#>>'{suggestion,c}',stored.payload#>>'{suggestion,ts}') on conflict do nothing;
  end if;
  if existing_issue is null and exists (select 1 from public.slack_legacy_fences where org_id=organization and project=project_key and fingerprint=task_fingerprint) then operation_state := 'uncertain'; end if;
  result := jsonb_build_object('id',operation_id,'project',project_key,'fingerprint',task_fingerprint,
    'proposalId',proposal_id,'proposalRevision',expected_revision,'proposal',stored.payload,'actorSlackId',actor_slack_id,
    'state',operation_state,'existing',existing_issue is not null);
  if existing_issue is not null then result := result || jsonb_build_object('issueKey',existing_issue->>'key','issueUrl',existing_issue->>'url'); end if;
  insert into public.slack_task_operations(org_id,id,project,fingerprint,proposal_id,state,payload)
    values (organization,operation_id,project_key,task_fingerprint,proposal_id,operation_state,result) on conflict (org_id,project,fingerprint) do nothing;
  if operation_state='uncertain' then
    update public.slack_task_operations set state='uncertain',payload=payload || '{"state":"uncertain"}'::jsonb,updated_at=now()
      where org_id=organization and project=project_key and fingerprint=task_fingerprint and state in ('reserved','refused');
  end if;
  select payload into result from public.slack_task_operations where org_id=organization and project=project_key and fingerprint=task_fingerprint;
  return result;
end $$;

create function public.reserve_slack_link_operation(organization text, proposal_id uuid, expected_revision integer,
  operation_id uuid, task_fingerprint text, actor_slack_id text, existing_issue jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare stored public.slack_task_proposals; owned public.slack_task_operations; result jsonb;
begin
  select * into stored from public.slack_task_proposals where org_id=organization and id=proposal_id for update;
  if not found or stored.revision<>expected_revision or stored.status<>'pending' or existing_issue is null
    or coalesce(jsonb_typeof(existing_issue->'key'),'')<>'string' or coalesce(jsonb_typeof(existing_issue->'url'),'')<>'string' then return null; end if;
  select payload into result from public.slack_link_operations where org_id=organization and slack_link_operations.proposal_id=reserve_slack_link_operation.proposal_id;
  if found then
    if result->>'issueKey'=existing_issue->>'key' and (result->>'proposalRevision')::integer=expected_revision then return result; end if;
    return null;
  end if;
  select * into owned from public.slack_task_operations where org_id=organization and slack_task_operations.proposal_id=reserve_slack_link_operation.proposal_id for update;
  if found then
    if owned.state<>'refused' or owned.payload ? 'issueKey' then return null; end if;
    delete from public.slack_task_operations where org_id=organization and id=owned.id;
  end if;
  result := jsonb_build_object('id',operation_id,'project',stored.payload#>>'{suggestion,p}','fingerprint',task_fingerprint,
    'proposalId',proposal_id,'proposalRevision',expected_revision,'proposal',stored.payload,'actorSlackId',actor_slack_id,
    'state','remote_succeeded','existing',true,'kind','link','issueKey',existing_issue->>'key','issueUrl',existing_issue->>'url');
  insert into public.slack_link_operations(org_id,id,project,fingerprint,proposal_id,state,payload)
    values (organization,operation_id,stored.payload#>>'{suggestion,p}',task_fingerprint,proposal_id,'remote_succeeded',result);
  return result;
end $$;

create function public.advance_slack_operation(organization text, operation_id uuid, expected_state text, patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb; stored public.slack_task_operations; is_link boolean := false;
begin
  select * into stored from public.slack_task_operations where org_id=organization and id=operation_id and state=expected_state for update;
  if not found then
    select * into stored from public.slack_link_operations where org_id=organization and id=operation_id and state=expected_state for update;
    if not found then return null; end if;
    is_link := true;
  end if;
  if is_link then
    if patch ? 'state' and patch->>'state' not in ('remote_succeeded','linked','notifying','notified') then return null; end if;
    update public.slack_link_operations set payload=payload || patch || jsonb_build_object('id',id),state=coalesce(patch->>'state',state),updated_at=now()
      where org_id=organization and id=operation_id returning payload into result;
    return result;
  end if;
  if patch->>'state'='creating' and expected_state in ('reserved','refused') and exists
    (select 1 from public.slack_legacy_fences where org_id=organization and project=stored.project and fingerprint=stored.fingerprint) then
    update public.slack_task_operations set state='uncertain',payload=payload || '{"state":"uncertain"}'::jsonb,updated_at=now() where org_id=organization and id=operation_id;
    return null;
  end if;
  update public.slack_task_operations set payload=payload || patch || jsonb_build_object('id',id),state=coalesce(patch->>'state',state),updated_at=now()
    where org_id=organization and id=operation_id returning payload into result;
  return result;
end $$;

create or replace function public.record_slack_task_repeat(organization text, project_key text, task_fingerprint text, repeat_channel text, repeat_ts text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from public.slack_task_links where org_id=organization and project=project_key and fingerprint=task_fingerprint and channel=repeat_channel and message_ts=repeat_ts) then return; end if;
  insert into public.slack_task_sightings(org_id,project,fingerprint,channel,message_ts) values (organization,project_key,task_fingerprint,repeat_channel,repeat_ts) on conflict do nothing;
  if found then
    update public.slack_task_links set mention_count=mention_count+1,updated_at=now() where org_id=organization and project=project_key and fingerprint=task_fingerprint;
  end if;
end $$;

create function public.observe_slack_completion(organization text, task_link jsonb, observation jsonb, delivery_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare previous text; project_key text; task_fingerprint text; new_category text; result jsonb;
begin
  project_key := task_link->>'project'; task_fingerprint := task_link->>'fingerprint'; new_category := observation->>'statusCategory';
  perform 1 from public.slack_task_links where org_id=organization and project=project_key and fingerprint=task_fingerprint for update;
  if not found then return; end if;
  select category into previous from public.slack_completion_observations where org_id=organization and project=project_key and fingerprint=task_fingerprint;
  insert into public.slack_completion_observations(org_id,project,fingerprint,category,provider_version)
    values (organization,project_key,task_fingerprint,new_category,observation->>'providerVersion')
    on conflict (org_id,project,fingerprint) do update set category=excluded.category,provider_version=excluded.provider_version,updated_at=now();
  update public.slack_task_links set updated_at=now() where org_id=organization and project=project_key and fingerprint=task_fingerprint;
  if previous is null or previous='done' or new_category<>'done' then return; end if;
  result := jsonb_build_object('id',delivery_id,'link',task_link,'providerVersion',observation->>'providerVersion','state','pending');
  insert into public.slack_completion_feedback(org_id,id,project,fingerprint,state,payload)
    values (organization,delivery_id,project_key,task_fingerprint,'pending',result) on conflict (org_id,project,fingerprint) do nothing;
end $$;

create function public.advance_slack_feedback(organization text, delivery_id uuid, expected_state text, patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  update public.slack_completion_feedback set payload=payload || patch || jsonb_build_object('id',id),state=coalesce(patch->>'state',state),updated_at=now()
    where org_id=organization and id=delivery_id and state=expected_state returning payload into result;
  return result;
end $$;

alter table public.slack_task_proposals enable row level security;
alter table public.slack_task_operations enable row level security;
alter table public.slack_link_operations enable row level security;
alter table public.slack_legacy_fences enable row level security;
alter table public.slack_task_sightings enable row level security;
alter table public.slack_completion_observations enable row level security;
alter table public.slack_completion_feedback enable row level security;
revoke all on public.slack_task_proposals,public.slack_task_operations,public.slack_link_operations,public.slack_legacy_fences,public.slack_task_sightings,public.slack_completion_observations,public.slack_completion_feedback from public,anon,authenticated;
grant delete on public.slack_task_operations to service_role;
grant select,insert,update on public.slack_task_proposals,public.slack_task_operations,public.slack_link_operations,public.slack_legacy_fences,public.slack_task_sightings,public.slack_completion_observations,public.slack_completion_feedback to service_role;
revoke all on function public.save_slack_proposal(text,jsonb,integer),public.complete_slack_proposal(text,uuid,integer,uuid,text,text,text),public.reserve_slack_operation(text,uuid,integer,uuid,text,text,jsonb),public.reserve_slack_link_operation(text,uuid,integer,uuid,text,text,jsonb),public.advance_slack_operation(text,uuid,text,jsonb),public.record_slack_task_repeat(text,text,text,text,text),public.observe_slack_completion(text,jsonb,jsonb,uuid),public.advance_slack_feedback(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_slack_proposal(text,jsonb,integer),public.complete_slack_proposal(text,uuid,integer,uuid,text,text,text),public.reserve_slack_operation(text,uuid,integer,uuid,text,text,jsonb),public.reserve_slack_link_operation(text,uuid,integer,uuid,text,text,jsonb),public.advance_slack_operation(text,uuid,text,jsonb),public.record_slack_task_repeat(text,text,text,text,text),public.observe_slack_completion(text,jsonb,jsonb,uuid),public.advance_slack_feedback(text,uuid,text,jsonb) to service_role;

commit;

create table public.slack_install_attempts (
  attempt_id bigint generated always as identity primary key,
  org_id text not null,
  app_id text not null,
  state_hash text not null unique check (state_hash ~ '^[a-f0-9]{64}$'),
  person text not null,
  person_sub text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  completed_at timestamptz
);
create index slack_install_attempts_org_app on public.slack_install_attempts(org_id, app_id);
create index slack_install_attempts_expiry on public.slack_install_attempts(expires_at);
create table public.slack_installations (
  app_id text not null,
  team_id text not null,
  org_id text not null,
  team_name text not null,
  bot_user_id text not null,
  scopes text[] not null,
  lifecycle text not null check (lifecycle in ('active','disconnected','uninstalled')),
  generation bigint not null check (generation > 0),
  installed_at timestamptz not null,
  last_attempt_id bigint not null,
  secret_id uuid,
  primary key (app_id, team_id),
  unique (org_id, app_id),
  check ((lifecycle = 'active') = (secret_id is not null))
);
alter table public.slack_install_attempts enable row level security;
alter table public.slack_installations enable row level security;
revoke all on public.slack_install_attempts, public.slack_installations from public, anon, authenticated;
grant select, insert, update, delete on public.slack_install_attempts, public.slack_installations to service_role;
grant usage, select on sequence public.slack_install_attempts_attempt_id_seq to service_role;

create function public.begin_slack_install(organization text, application text, state_hash text, person text, person_sub text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if organization = '' or application = '' or person = '' or person_sub = '' then raise exception 'Invalid install actor'; end if;
  delete from public.slack_install_attempts where expires_at < now();
  insert into public.slack_install_attempts(org_id,app_id,state_hash,person,person_sub,expires_at)
    values(organization,application,state_hash,person,person_sub,now() + interval '10 minutes');
end $$;
create function public.consume_slack_install(organization text, application text, state_hash text)
returns jsonb language sql security invoker set search_path = '' as $$
  with taken as (
    update public.slack_install_attempts a set consumed_at=now()
    where a.org_id=organization and a.app_id=application and a.state_hash=consume_slack_install.state_hash
      and a.expires_at > now() and a.consumed_at is null returning a.*
  ) select pg_catalog.jsonb_build_object('attemptId',attempt_id,'orgId',org_id,'appId',app_id,'person',person,'personSub',person_sub) from taken;
$$;
create function public.slack_install_status(organization text, application text)
returns jsonb language sql security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('state',lifecycle,'teamId',team_id,'teamName',team_name,'generation',generation,'installedAt',installed_at)
  from public.slack_installations where org_id=organization and app_id=application;
$$;
create function public.publish_slack_install(organization text, application text, attempt bigint, workspace text, workspace_name text,
  bot_user text, granted_scopes text[], bundle jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare old public.slack_installations; owned_secret uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/team/' || application || '/' || workspace, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/org/' || application || '/' || organization, 0));
  if not exists (select 1 from public.slack_install_attempts a where a.attempt_id=attempt and a.org_id=organization and a.app_id=application
    and a.consumed_at is not null and a.completed_at is null and a.expires_at > now()) then return false; end if;
  select * into old from public.slack_installations where org_id=organization and app_id=application for update;
  if old.app_id is not null and (old.team_id <> workspace or old.last_attempt_id >= attempt) then return false; end if;
  if exists(select 1 from public.slack_installations where app_id=application and team_id=workspace and org_id <> organization) then return false; end if;
  if workspace = '' or bot_user = '' or pg_catalog.jsonb_typeof(bundle) <> 'object'
    or bundle->'runtime'->>'orgId' is distinct from organization
    or bundle->>'accessToken' is null or bundle->>'accessToken' = '' or pg_catalog.jsonb_typeof(bundle->'runtime') <> 'object' then
    raise exception 'Invalid install bundle';
  end if;
  select vault.create_secret(bundle::text) into owned_secret;
  insert into public.slack_installations(app_id,team_id,org_id,team_name,bot_user_id,scopes,lifecycle,generation,installed_at,last_attempt_id,secret_id)
    values(application,workspace,organization,workspace_name,bot_user,granted_scopes,'active',coalesce(old.generation,0)+1,now(),attempt,owned_secret)
    on conflict(org_id,app_id) do update set team_name=excluded.team_name,bot_user_id=excluded.bot_user_id,scopes=excluded.scopes,
      lifecycle='active',generation=excluded.generation,installed_at=excluded.installed_at,last_attempt_id=excluded.last_attempt_id,secret_id=excluded.secret_id;
  delete from vault.secrets where id=old.secret_id;
  update public.slack_install_attempts set completed_at=now() where attempt_id=attempt;
  return true;
end $$;
create function public.resolve_slack_install(application text, workspace text)
returns jsonb language sql security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('appId',i.app_id,'teamId',i.team_id,'orgId',i.org_id,'botUserId',i.bot_user_id,
    'generation',i.generation,'accessToken',s.decrypted_secret::jsonb->>'accessToken','runtime',s.decrypted_secret::jsonb->'runtime')
  from public.slack_installations i join vault.decrypted_secrets s on s.id=i.secret_id
  where i.app_id=application and i.team_id=workspace and i.lifecycle='active';
$$;
create function public.current_slack_install(application text, workspace text, expected_generation bigint)
returns boolean language sql security invoker set search_path = '' as $$
  select exists(select 1 from public.slack_installations where app_id=application and team_id=workspace and lifecycle='active' and generation=expected_generation);
$$;
create function public.refresh_slack_runtime(organization text, application text, expected_generation bigint, runtime jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare old public.slack_installations; bundle jsonb; owned_secret uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/org/' || application || '/' || organization, 0));
  select * into old from public.slack_installations where org_id=organization and app_id=application for update;
  if old.lifecycle <> 'active' or old.generation <> expected_generation or old.app_id is null then return false; end if;
  if runtime->>'orgId' is distinct from organization or pg_catalog.jsonb_typeof(runtime) <> 'object' then raise exception 'Invalid runtime'; end if;
  select s.decrypted_secret::jsonb into bundle from vault.decrypted_secrets s where s.id=old.secret_id;
  if bundle is null then raise exception 'Missing owned secret'; end if;
  select vault.create_secret(pg_catalog.jsonb_set(bundle,'{runtime}',runtime)::text) into owned_secret;
  update public.slack_installations set secret_id=owned_secret,generation=generation+1 where app_id=application and org_id=organization;
  delete from vault.secrets where id=old.secret_id;
  return true;
end $$;
create function public.deactivate_slack_install(organization text, application text, workspace text, expected_generation bigint, reason text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare old public.slack_installations;
begin
  if reason not in ('disconnected','uninstalled') then raise exception 'Invalid lifecycle'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/org/' || application || '/' || organization, 0));
  select * into old from public.slack_installations where org_id=organization and app_id=application and team_id=workspace for update;
  if old.app_id is null or old.generation <> expected_generation or old.lifecycle <> 'active' then return false; end if;
  update public.slack_installations set lifecycle=reason,generation=generation+1,secret_id=null where org_id=organization and app_id=application;
  update public.slack_install_attempts set expires_at=now() where org_id=organization and app_id=application and completed_at is null;
  delete from vault.secrets where id=old.secret_id;
  return true;
end $$;
revoke all on function public.begin_slack_install(text,text,text,text,text), public.consume_slack_install(text,text,text),
  public.slack_install_status(text,text), public.publish_slack_install(text,text,bigint,text,text,text,text[],jsonb),
  public.resolve_slack_install(text,text), public.current_slack_install(text,text,bigint),
  public.refresh_slack_runtime(text,text,bigint,jsonb), public.deactivate_slack_install(text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.begin_slack_install(text,text,text,text,text), public.consume_slack_install(text,text,text),
  public.slack_install_status(text,text), public.publish_slack_install(text,text,bigint,text,text,text,text[],jsonb),
  public.resolve_slack_install(text,text), public.current_slack_install(text,text,bigint),
  public.refresh_slack_runtime(text,text,bigint,jsonb), public.deactivate_slack_install(text,text,text,bigint,text) to service_role;

create index slack_task_links_team_poll on public.slack_task_links (org_id, (source->>'teamId'), updated_at);
create index slack_task_links_team_title on public.slack_task_links (org_id, (source->>'teamId'), project, title_fingerprint, created_at);
create index slack_feedback_team_pending on public.slack_completion_feedback (org_id, (payload->'link'->>'teamId'), created_at) where state <> 'delivered';

-- 011: organization chat model (see migrations/011_org_model.sql)
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

-- Workspace snapshot revisions (migration 014).
alter table public.brain_state add column if not exists revision bigint not null default 0;

create or replace function public.save_brain_state_at(organization text, snapshot jsonb, expected bigint)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare current_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain_state/' || organization, 0));
  select revision into current_revision from public.brain_state where org_id = organization;
  if coalesce(current_revision, 0) <> expected then return null; end if;
  perform public.save_brain_state(organization, snapshot);
  update public.brain_state set revision = expected + 1 where org_id = organization;
  return expected + 1;
end $$;
revoke all on function public.save_brain_state_at(text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_brain_state_at(text, jsonb, bigint) to service_role;

-- Unique company names (migration 015).
create unique index if not exists organizations_company_name_unique
  on public.organizations (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')))
  where kind is distinct from 'personal';

-- Background sync schedule (migration 016). Store broppy_api_origin in Vault; the shared secret is generated here.
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

-- Slack service secret (migration 017), generated in Vault.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'broppy_slack_service_token')
where not exists (select 1 from vault.secrets where name = 'broppy_slack_service_token');

create or replace function public.broppy_slack_service_token() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'broppy_slack_service_token'
$$;
revoke all on function public.broppy_slack_service_token() from public, anon, authenticated;
grant execute on function public.broppy_slack_service_token() to service_role;

-- Slack workspaces can move between companies once inactive (migration 018).
create or replace function public.publish_slack_install(organization text, application text, attempt bigint, workspace text, workspace_name text,
  bot_user text, granted_scopes text[], bundle jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare old public.slack_installations; owned_secret uuid; stale uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/team/' || application || '/' || workspace, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('slack/org/' || application || '/' || organization, 0));
  if not exists (select 1 from public.slack_install_attempts a where a.attempt_id=attempt and a.org_id=organization and a.app_id=application
    and a.consumed_at is not null and a.completed_at is null and a.expires_at > now()) then return false; end if;
  select * into old from public.slack_installations where org_id=organization and app_id=application for update;
  if old.app_id is not null and (old.last_attempt_id >= attempt or (old.team_id <> workspace and old.lifecycle = 'active')) then return false; end if;
  if exists(select 1 from public.slack_installations where app_id=application and team_id=workspace and org_id <> organization and lifecycle = 'active') then return false; end if;
  if workspace = '' or bot_user = '' or pg_catalog.jsonb_typeof(bundle) <> 'object'
    or bundle->'runtime'->>'orgId' is distinct from organization
    or bundle->>'accessToken' is null or bundle->>'accessToken' = '' or pg_catalog.jsonb_typeof(bundle->'runtime') <> 'object' then
    raise exception 'Invalid install bundle';
  end if;
  -- The workspace's old, inactive record in another company goes, with any grant it still held.
  for stale in delete from public.slack_installations where app_id=application and team_id=workspace and org_id <> organization returning secret_id loop
    if stale is not null then delete from vault.secrets where id=stale; end if;
  end loop;
  select vault.create_secret(bundle::text) into owned_secret;
  insert into public.slack_installations(app_id,team_id,org_id,team_name,bot_user_id,scopes,lifecycle,generation,installed_at,last_attempt_id,secret_id)
    values(application,workspace,organization,workspace_name,bot_user,granted_scopes,'active',coalesce(old.generation,0)+1,now(),attempt,owned_secret)
    on conflict(org_id,app_id) do update set team_id=excluded.team_id,team_name=excluded.team_name,bot_user_id=excluded.bot_user_id,scopes=excluded.scopes,
      lifecycle='active',generation=excluded.generation,installed_at=excluded.installed_at,last_attempt_id=excluded.last_attempt_id,secret_id=excluded.secret_id;
  if old.secret_id is not null then delete from vault.secrets where id=old.secret_id; end if;
  update public.slack_install_attempts set completed_at=now() where attempt_id=attempt;
  return true;
end $$;
