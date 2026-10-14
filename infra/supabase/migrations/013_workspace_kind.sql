-- Whether a signed-up workspace is a company or one person's own. Rows from before this column are null until the API
-- next builds that workspace: it then reads the Auth0 address (personal ones start with "me-") and writes the answer.
alter table public.organizations
  add column if not exists kind text check (kind in ('company', 'personal'));
