-- auth_user_id was itself the primary key; drop it before making it nullable.
-- Memberships are keyed per organization so identical user IDs/emails in two companies cannot overwrite each other.
alter table public.workspace_users
  drop constraint workspace_users_auth_user_id_fkey,
  drop constraint workspace_users_pkey,
  drop constraint workspace_users_user_id_key,
  drop constraint workspace_users_email_key,
  alter column auth_user_id drop not null,
  add column auth0_sub text,
  add column org_id text not null default 'demo-company-a',
  add column active boolean not null default true,
  add primary key (org_id, user_id),
  add unique (org_id, auth0_sub),
  add unique (org_id, email);
