-- OAuth sign-in state shared by every API instance. A flow is single use: consume_oauth_flow deletes it as it returns it.
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
