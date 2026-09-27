create extension if not exists vector;

create table source_documents (
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
  unique (source, source_native_id)
);

create index source_documents_active_source_idx
  on source_documents (source) where deleted_at is null;
create index source_documents_search_idx
  on source_documents using gin (search_vector);

create table source_chunks (
  chunk_id text primary key,
  doc_id text not null references source_documents(doc_id) on delete cascade,
  ordinal integer not null,
  content text not null,
  embedding vector(384),
  unique (doc_id, ordinal)
);

create index source_chunks_doc_idx on source_chunks (doc_id);

create table connector_state (
  source text primary key check (source in ('slack', 'jira', 'confluence', 'drive')),
  cursor text not null,
  last_successful_sync_at timestamptz
);

create table sync_runs (
  run_id bigserial primary key,
  source text not null references connector_state(source),
  cursor_from text not null,
  cursor_to text not null,
  checkpoint text,
  pending_ids jsonb not null,
  status text not null check (status in ('running', 'failed', 'complete')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index sync_runs_incomplete_idx
  on sync_runs (source, started_at desc) where status <> 'complete';

create table audit_entries (
  sequence bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event_type text not null,
  actor_id text not null,
  data jsonb not null,
  previous_hash text not null,
  entry_hash text not null unique
);

create table merkle_batches (
  batch_id bigserial primary key,
  first_sequence bigint not null references audit_entries(sequence),
  last_sequence bigint not null references audit_entries(sequence),
  root_hash text not null,
  sealed_at timestamptz not null default now(),
  check (last_sequence >= first_sequence),
  unique (first_sequence, last_sequence)
);

revoke all on source_documents, source_chunks, connector_state,
  sync_runs, audit_entries, merkle_batches from anon, authenticated;
