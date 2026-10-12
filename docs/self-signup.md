# Companies that sign themselves up

A new customer opens the site, presses **Create your company**, enters a company name, their name and their work email,
and opens the invitation emailed to them. They become the company's first admin and land in the guided setup. Nothing is
set up by hand: no SQL, no Auth0 dashboard.

## Two ways to sign up

The front page offers **Sign up** (personal) and **Enterprise sign up** (a company); `/signup` lets a visitor pick.

- **Enterprise sign up** is the flow described below: a company name, the person's name and work email, and that person
  becomes the company's first admin.
- **Sign up** makes a workspace for one person. It is named after them and they are its only member and admin. It is the
  same thing underneath (an Auth0 organization, a row in `public.organizations`, an invitation), so everything below applies
  to it. Its Auth0 organization name is `me-` plus 16 hex characters worked out from the email, so nobody needs to remember
  a company name: **Sign in** has a Personal box that asks for the email and finds the workspace from it. The same email
  always gives the same workspace, and an email already on any workspace gets the same answer as everyone else and creates
  nothing. A repeated sign-up for an unopened personal workspace sends the invitation again.
- There is no separate switch: both need `SELF_SIGNUP=on`, and `SIGNUP_ACCESS_CODE` applies to both.
- Not built yet: the guided setup still shows the "Add your team" step to a personal workspace (it can be skipped), and
  nothing marks a workspace as personal in the database.

## What happens

1. The sign-up form posts to the web app, which calls `POST /v1/signup` on the API.
2. The API creates an Auth0 organization for the company. Its short name, the sign-in address people type, is the
   company name in lowercase letters, digits and hyphens followed by a random ending, such as `acme-7k2qmx`, so two
   companies may share a name and nobody can take a name before the real company signs up. The admin sees the address at
   the top of the guided setup. It then turns on the sign-in database
   for it, lists the company in `public.organizations`, sends an Auth0 organization invitation to that email, and only then
   adds the person as the company's admin in `workspace_users`.
3. The admin is whoever can open the invitation. At their first sign-in the directory entry becomes theirs only if
   Auth0 says the email is verified (the same rule as every other person), so a form with someone else's email creates a
   company nobody can enter.
4. Their sign-in token names their company. The API builds that company's own workspace on the first request: its
   people, saved state, audit chain, source connections, AI model choice and, when set up, remote tuples are all scoped to
   the company's organization ID.
5. Returning people go to **Sign in**, type their company's name, and are sent to that company's Auth0 sign-in.

If anything fails after the Auth0 organization is created (listing the company, sending the email, adding the admin),
the API removes the organization and its listing. The admin's entry is added last, so a failed attempt leaves nothing in the
directory that would stop the same person trying again. (If the API itself stops between creating the Auth0 organization and
listing it, that organization is left holding its name; delete it in the Auth0 dashboard.)

## Switching it on

Apply `infra/supabase/migrations/012_company_signup.sql` first (fresh projects: `infra/supabase/schema.sql`).

**Auth0**
- In Auth0, open **Applications → Applications**, choose the machine-to-machine application used for invitations (the
  one whose Client ID is `AUTH0_MANAGEMENT_CLIENT_ID`), then its **APIs** tab. On the **Auth0 Management API** row press
  **Edit**, open **Client Access**, and tick these permissions (the list has a search box): `create:organizations`,
  `read:organizations`, `delete:organizations`, `create:organization_connections`, plus the five it should already have for
  invitations: `create:organization_invitations`, `read:organization_invitations`, `delete:organization_invitations`,
  `create:organization_members`, `delete:organization_members`. Save. "User-delegated Access" is a different setting and
  isn't needed.
- Copy the ID of the sign-in database (Authentication → Database → your connection, `con_...`). New companies use it.
- Set the web application's **Application Login URI** (Applications → your web app → Settings → Application URIs) to
  `https://YOUR-WEB-DOMAIN/invited`. On the same application's **Login Experience** tab (older dashboards: Organizations
  tab), **Types of Users** must be Business Users or Both; if the application requires an organization, new companies
  work with it as is, because sign-in always names one. On its **Connections** tab, switch on the sign-in database too.

**API project (`broppy-beii`)**

| Setting | Value |
| --- | --- |
| `SELF_SIGNUP` | `on` to let anyone sign a company up, `closed` to keep serving companies that already signed up but accept no new ones, unset for the old single-company behavior |
| `AUTH0_SIGNUP_CONNECTION_ID` | the `con_...` ID above |
| `SIGNUP_ACCESS_CODE` | optional; when set the form asks for it, so a launch can be limited to people you have told |
| `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET`, `AUTH0_CLIENT_ID`, `SOURCE_OAUTH_JSON`, `API_ORIGIN`, `WEB_ORIGIN` | as before; all are needed |

Keep `AUTH0_ORG_ID`: it is your existing company, and it keeps working exactly as before.

**Web project (`broppy-one`)**: set `SELF_SIGNUP` to the same value, and `SIGNUP_NEEDS_CODE=on` if the API has an access
code. The web project no longer pins sign-in to `AUTH0_ORG_ID` once `SELF_SIGNUP` is set: the existing company signs in the
same way as the others, by typing its name at **Sign in** (its Auth0 organization name, in lowercase with hyphens).
Redeploy both projects.

## Limits, said plainly

- **Sign-up is open to anyone** while `SELF_SIGNUP=on`. Each email may ask three times an hour, the API creates at most
  twenty companies an hour per running instance, and the web form allows five tries an hour per visitor. These counters
  live in each running instance, so they slow abuse down; they are not a hard limit. Use `SIGNUP_ACCESS_CODE` for an
  invite-only launch, and `closed` to stop sign-ups.
- An email that someone has already signed in with gets the same answer as anyone else and nothing is created. An email
  that was only invited and never signed in doesn't count, so nobody can use a stranger's address to stop them signing their
  own company up (they get an invitation they can ignore). The answers match but not the time they take, so a patient caller
  could still tell the two apart.
- Company names are not unique and prove nothing: anyone can sign up a company called "Aspire". The real Aspire still
  signs up and gets its own address, but invitations from the other one look just as real. Companies that signed up
  before addresses had a random ending keep their plain address.
- A company's AI model can be Anthropic or OpenAI only. The "OpenAI-compatible" option with an address of its own is
  refused for companies that signed up, because the API would call that address from inside its own network. Your existing
  company keeps it.
- Don't pin `cloudId` or `baseUrl` for Jira or Confluence in `SOURCE_OAUTH_JSON` when self-signup is on: those pin one
  company's site, and other companies would be refused.
- **The Slack app (`apps/slack`) and its `/broppy` command serve the existing company only.** A new company still
  connects Slack as a source through the guided setup; installing the Broppy bot into a second company's Slack is not
  built yet.
- The AI usage budget (`LLM_USAGE_FILE`) is shared by every company using the built-in or operator model. A company that
  picks its own model on the Connectors page is not counted against it.
- The service identity the Slack app uses (`SLACK_SERVICE_TOKEN`) belongs to the existing company.
- Removing or suspending a company is a database change: set `organizations.status` to `suspended`. The API stops serving it
  within a minute.
- The API keeps up to 25 companies' workspaces in memory per instance and rebuilds one from the database when needed.
