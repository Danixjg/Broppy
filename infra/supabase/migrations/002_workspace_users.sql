-- Demo identities are provisioned in Supabase Auth. The API alone reads roles
-- and source identity mappings; browser clients receive no table privileges.
create table if not exists public.workspace_users (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  user_id text not null unique,
  name text not null,
  email text not null unique,
  role text not null check (role in ('member', 'admin', 'compliance')),
  groups jsonb not null default '[]'::jsonb check (jsonb_typeof(groups) = 'array'),
  contractor boolean not null default false,
  platform_identities jsonb not null default '{}'::jsonb check (jsonb_typeof(platform_identities) = 'object')
);

alter table public.workspace_users enable row level security;
revoke all on public.workspace_users from public, anon, authenticated;
grant select, insert, update on public.workspace_users to service_role;
