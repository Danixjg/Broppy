# Companies that sign themselves up

A new customer opens the site, presses **Create your company**, enters a company name, their name and their work email,
and opens the invitation emailed to them. They become the company's first admin and land in the guided setup. Nothing is
set up by hand: no SQL, no Auth0 dashboard.

## What happens

1. The sign-up form posts to the web app, which calls `POST /v1/signup` on the API.
2. The API creates an Auth0 organization for the company (its short name is the company name in lowercase letters,
   digits and hyphens; a name that is already taken is refused, so one name is one company), turns on the sign-in database
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
- Set the web application's **Application Login URI** to `https://YOUR-WEB-DOMAIN/invited`, and keep **Allow
  organization logins** on the application's Organizations tab. If the application requires an organization, new companies
  work with it as is, because sign-in always names one.

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
- Anyone can sign up with a company name that sounds like a real one before the real company does. The access code or
  `closed` mode is the defence; names can't be reclaimed from the page.
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
