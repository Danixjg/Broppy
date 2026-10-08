-- Companies that sign themselves up. A company is listed here when it is created; the API refuses sign-ins from any
-- Auth0 organization that is not listed (the company set up by hand through AUTH0_ORG_ID is always allowed).
alter table public.organizations
  add column if not exists status text not null default 'active' check (status in ('active', 'suspended')),
  add column if not exists created_by_email text,
  add column if not exists created_at timestamptz not null default now();
