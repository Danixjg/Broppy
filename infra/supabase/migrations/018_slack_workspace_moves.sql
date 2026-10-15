-- A Slack workspace can move to another Broppy company once it is no longer active in the first one (disconnected
-- there, or Broppy uninstalled from Slack), and a company can switch to another workspace once its current one is no
-- longer active. While an installation is active, neither is allowed, as before.
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
