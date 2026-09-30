-- Backfill existing demo rows into Company A; set their real Auth0 org ID before live use.
create table public.organizations (org_id text primary key, name text not null);
insert into public.organizations values ('demo-company-a', 'Company A');
create table public.brain_state (org_id text primary key, snapshot jsonb not null);
create table public.source_connections (org_id text not null, source text not null, status text not null,
  scope jsonb not null default '{}', token_secret_id uuid, connected_by text, connected_at timestamptz,
  primary key (org_id, source));
create table public.import_jobs (org_id text not null, source text not null, status text not null,
  progress jsonb not null, primary key (org_id, source));

alter table public.source_documents add column org_id text not null default 'demo-company-a';
alter table public.source_documents drop constraint source_documents_source_source_native_id_key;
alter table public.source_documents add unique(org_id, source, source_native_id);
alter table public.source_chunks add column org_id text not null default 'demo-company-a';
alter table public.source_chunks drop constraint source_chunks_doc_id_fkey;
alter table public.source_chunks add foreign key(doc_id) references public.source_documents(doc_id) on delete cascade on update cascade;
update public.source_documents set doc_id = 'demo-company-a/' || doc_id;
update public.source_chunks set chunk_id = 'demo-company-a/' || chunk_id;

alter table public.connector_state add column org_id text not null default 'demo-company-a';
alter table public.sync_runs drop constraint sync_runs_source_fkey;
alter table public.connector_state drop constraint connector_state_pkey;
alter table public.connector_state add primary key(org_id, source);
alter table public.sync_runs add column org_id text not null default 'demo-company-a';
alter table public.sync_runs add unique(org_id, source);
alter table public.sync_runs add foreign key(org_id, source) references public.connector_state(org_id, source);
alter table public.audit_entries add column org_id text not null default 'demo-company-a';
alter table public.audit_entries add column payload jsonb;
alter table public.audit_entries alter column sequence drop identity;
alter table public.merkle_batches drop constraint merkle_batches_first_sequence_fkey;
alter table public.merkle_batches drop constraint merkle_batches_last_sequence_fkey;
alter table public.audit_entries drop constraint audit_entries_pkey;
alter table public.audit_entries add primary key(org_id, sequence);
alter table public.merkle_batches add column org_id text not null default 'demo-company-a';
alter table public.merkle_batches add column payload jsonb;
alter table public.merkle_batches drop constraint merkle_batches_first_sequence_last_sequence_key;
alter table public.merkle_batches add unique(org_id, first_sequence, last_sequence);
alter table public.merkle_batches add foreign key(org_id, first_sequence) references public.audit_entries(org_id, sequence);
alter table public.merkle_batches add foreign key(org_id, last_sequence) references public.audit_entries(org_id, sequence);

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

drop function public.hybrid_search(text, vector, integer);
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

