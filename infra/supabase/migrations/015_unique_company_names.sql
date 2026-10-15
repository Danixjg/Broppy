-- One company per name. Names are compared ignoring capitals and runs of spaces ("Acme", "ACME ", "acme" are one name).
-- Personal workspaces are named after people, so they don't take part. The API checks first and explains; this index is
-- what stops two sign-ups at the same moment from both getting a name.
create unique index if not exists organizations_company_name_unique
  on public.organizations (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')))
  where kind is distinct from 'personal';
