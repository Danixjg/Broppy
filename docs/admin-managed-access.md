# Admin-managed access: who can sign in to Broppy

A company's admin decides who can use Broppy. Nobody gets in just by having an Auth0 account or by being a member of the
Auth0 organization: their work email must be on the admin's list, under **People and access** in the workspace.

## How it works

1. **The admin adds work emails.** `People and access` (`/workspace/people.html`, linked from the admin tab and the
   Connectors page) takes one email per line, with a role (member, compliance or admin) and optional groups. Each email
   becomes an entry in `workspace_users` with no Auth0 subject yet, and Auth0 emails the person an organization
   invitation (Management API, `POST /organizations/{org}/invitations`).
2. **The person accepts the invitation** and signs in with that email. At the first sign-in the API asks Auth0's
   `/userinfo` for the email. If it is **verified** and matches an **active** entry that no one has claimed, the entry
   becomes theirs: the API stores their Auth0 `sub` on it, in one conditional update, so an entry can be claimed once.
3. **Anyone else is turned away with a reason they can act on** (HTTP 403, shown in the workspace):
   - `not_added`: the email isn't on the list. They are told to ask their admin.
   - `removed`: the admin removed them.
   - `email_unverified`: they must open Auth0's verification email first.
   - `email_in_use`: the entry for that email already belongs to another sign-in.
4. **Removing someone** marks the entry inactive first, so access ends on their next request, and then withdraws their
   open invitations and organization membership in Auth0. If Auth0 fails, the person is still removed from Broppy and
   the page says what to fix in Auth0. The last admin and your own entry cannot be removed. Adding the email again
   restores the person.

Three independent gates now apply: Auth0 organization membership (the token must carry the org's `org_id`), an active
directory entry, and a verified email for the first link. The API records `person_added`, `person_invited` and
`person_removed` in the audit log, with the person's Broppy ID and never their email.

## Source accounts and reading access

Each source is asked about a person by their account there (`platform_identities`: `slack`, `jira`, `confluence`,
`drive`). A person added by the admin starts with their work email for all four. A source with no account for someone
shows them nothing from it, so the admin can change one when a person's account at a source uses another email:
**People → Source accounts** (an empty value puts the work email back). **Check** asks Slack and Atlassian whether they
know the email (Drive has no lookup: a share names an email, and it either matches or it doesn't). Adding someone runs
the check straight away, so a mismatch shows then and not as an empty answer later.

What a person can see is stored per item as the list of people who passed the source check at the last permission pass
(about hourly in live mode). A new person isn't on those lists yet, so Broppy reads their access right away:

- **At their first sign-in**, and **when the admin saves their source accounts**: Broppy asks each source about every
  item for that person only and adds them where the source allows it. It adds and never removes. It stops after a few
  seconds and leaves the rest to the next pass.
- **Refresh access** (People page): reads every item's permissions at the source again and fills in any missing source
  account with the work email, for people added before this existed. It carries on until every item is read.
- **Taking access away** needs none of this: every answer asks the source again, so it takes effect at once.

Audit events: `person_identities_changed` (which sources, never the emails) and `access_refreshed` (counts only).

## Settings only an Auth0 admin can change

Do these once, in the Auth0 dashboard for the tenant.

1. **Applications → Applications → your Regular Web Application → Settings**
   - **Application Login URI**: `https://YOUR-WEB-DOMAIN/auth/login`, for example `https://broppy-one.vercel.app/auth/login`.
     Auth0 puts this in every invitation email; the link adds `invitation` and `organization`, and the web app forwards
     them to Auth0.
2. **Same application → Organizations tab**
   - **Types of Users**: **Business Users**. Personal accounts can then never sign in, because every login must name the organization.
   - **Login Flow**: **Prompt for Credentials**. The web app already sends the organization.
3. **Organizations → your organization → Connections**
   - Enable only the connection your people use (normally the database connection).
   - Leave **Enable Auto-Membership** off, so signing in never adds someone to the organization. Only invitations do.
4. **Authentication → Database → your connection → Settings → Disable Sign-ups**
   - Turn this on so strangers can't register at all. It is hardening, not the lock: the three gates above already
     refuse anyone who isn't on the list. Test one invitation after turning it on. If the invitation link can't create the
     account, turn it off again; access stays closed either way.
5. **Applications → Create Application → Machine to Machine** (for example "Broppy API management")
   - Authorize the **Auth0 Management API** with these permissions: `create:organization_invitations`,
     `read:organization_invitations`, `delete:organization_invitations`, `create:organization_members`,
     `delete:organization_members`.
   - Copy its Client ID and Client Secret.
6. **Branding → Email Provider**: connect your own provider before real use. Auth0's built-in test provider is rate limited and
   is meant for testing. Invitation and verification emails both go through it.

Then set these on the **API** project (Vercel project `broppy-beii`, or `.env.local` locally) and redeploy:

| Variable | Value |
| --- | --- |
| `AUTH0_MANAGEMENT_CLIENT_ID` | The machine-to-machine application's Client ID |
| `AUTH0_MANAGEMENT_CLIENT_SECRET` | Its Client Secret. Mark it Sensitive. |
| `AUTH0_CLIENT_ID` | The **web** application's Client ID (the same value the web project already has). Invitations land on that application. |

Set all three or none. With none, People still records the list and sign-in is still gated, but the page tells the admin
that invitations aren't set up, and you must add each person to the Auth0 organization yourself
(Organizations → your organization → Members → Add Members, or Invite).

No database migration is needed: `workspace_users` already allows an entry with no Auth0 subject.

## The first admin

The first admin of a company can't add themselves through a page they can't open yet, so add the row once in the Supabase SQL editor
(replace the values; `org_id` is the Auth0 organization ID, `org_...`):

```sql
insert into public.workspace_users (org_id, user_id, name, email, role, groups, platform_identities)
values ('org_REPLACE', 'sarah', 'Sarah', 'sarah@yourcompany.com', 'admin', '[]', '{"slack": "sarah@yourcompany.com"}')
on conflict (org_id, email) do update set active = true, role = 'admin';
```

Then invite that email from the Auth0 dashboard (Organizations → your organization → Members → Invite) or, if they
are already a member, just sign in. After that, the admin adds everyone else from the People page.

## Who is affected on the day you turn this on

People who are members of the Auth0 organization but have no `workspace_users` row (or whose row was deactivated)
now see "Your email isn't on your company's Broppy list yet" instead of getting in. People who already have a row with an
Auth0 `sub` keep working unchanged.

## Limits

- A running API instance learns about a person added or linked on another instance when that person's request reaches it.
  Until then it can't use them as a task owner.
- Role and group changes after adding aren't on the People page yet; the existing group tools and SQL still work.
- Auth0 roles aren't read. A person's Broppy role comes from the directory entry the admin set.
- Auth0 sends the invitation; if the email never arrives, **Resend invitation** replaces the earlier link.
