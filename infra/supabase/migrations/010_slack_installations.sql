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
