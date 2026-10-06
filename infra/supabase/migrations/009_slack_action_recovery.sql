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
