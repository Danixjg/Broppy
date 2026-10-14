-- The workspace snapshot gets a revision, so several API instances (Vercel runs many) never overwrite each other's
-- newer state with an older copy. A save names the revision it started from and is refused if another instance saved
-- in between; the refused instance reloads. save_brain_state stays for older API versions.
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
