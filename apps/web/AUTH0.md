# Auth0 sign-in: setup, checklist and troubleshooting

The website signs people in with the official `@auth0/nextjs-auth0` v4 SDK. The existing workspace UI is served by
the Next.js host under `/workspace/`. The request path is:

1. **Browser → Next.js host** (`http://127.0.0.1:3001`). The SDK runs the Auth0 login and keeps the session in an
   encrypted HttpOnly cookie. Browser JavaScript never sees a token: `/auth/access-token` is disabled.
2. **`/api/brain/*` → API** (`http://127.0.0.1:3000`). The host attaches the session's access token server-side.
3. **API.** It validates the token's issuer, audience, RS256 signature and `org_id`. It then looks up the token's
   `sub` in the Supabase `workspace_users` table. Only active directory members of that organization get in.

For local development, both processes read the same private file, **`.env.local` at the repository root**. Deployed,
each process should get its own environment (see `decisions.md`, D5).

> Always open **`http://127.0.0.1:3001`**, never `localhost:3001`. Cookies belong to the host in `APP_BASE_URL`;
> mixing the two breaks the login round-trip.

## 1. Create `.env.local`

```sh
cp .env.example .env.local
```

Fill it in. The file is gitignored; never commit it.

| Variable | Used by | Where it comes from |
| --- | --- | --- |
| `AUTH0_AUDIENCE` | web + API | Auth0 → Applications → APIs → your API's **Identifier** |
| `AUTH0_ORG_ID` | web + API | Auth0 → Organizations → Company A → **ID** (`org_…`, not the display name) |
| `APP_BASE_URL` | web | `http://127.0.0.1:3001` locally |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` | web | The application's settings (already in `.env.example`) |
| `AUTH0_CLIENT_SECRET` | web | The application's settings. Private. |
| `AUTH0_SECRET` | web | `openssl rand -hex 32` (64 hex characters). Private. |
| `BRAIN_API_URL` | web | `http://127.0.0.1:3000` locally |
| `AUTH0_ISSUER` | API | `https://AUTH0_DOMAIN/`, **with** the trailing slash |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | API | Supabase → Project Settings → API. Use the HTTPS origin only, with no path. The key is private. |
| `AUDIT_SIGNING_KEY_FILE` | API | A path relative to the repository root, e.g. `audit-signing-key.pem`. Generate it with `openssl genpkey -algorithm ed25519 -out audit-signing-key.pem`. `*.pem` is gitignored. |

Keep comments on their own lines and values unquoted: Next.js and Node's `--env-file` both parse this file.

## 2. Auth0 dashboard checklist

Confirm each item on tenant `dev-3es7focax4cjcswg.us.auth0.com`. Each one can make login fail on Auth0's side, before
our code runs.

- [ ] **Application** `msyBcV9l7aWnFYDW2NqlF2BvjeeUHwlD` is a **Regular Web Application**. Its authentication method
      is **Client Secret Post**, and its secret matches `AUTH0_CLIENT_SECRET`.
- [ ] **Allowed Callback URLs** contains `http://127.0.0.1:3001/auth/callback`.
- [ ] **Allowed Logout URLs** contains `http://127.0.0.1:3001`, exactly as written in `APP_BASE_URL`. The SDK sends
      that value unchanged as the logout `returnTo`, and Auth0 matches it exactly. Adding `http://127.0.0.1:3001/`
      as well is harmless.
- [ ] **Allowed Web Origins** contains `http://127.0.0.1:3001`.
- [ ] **API:** an API exists whose **Identifier** equals `AUTH0_AUDIENCE`. It uses RS256 and a short token lifetime
      (5–15 minutes).
- [ ] **Allow Offline Access** is turned on for that API. Login asks for `offline_access`. Without a refresh token,
      every workspace call fails with 502 once the short access token expires.
- [ ] The application is allowed to request that API. For a Regular Web Application this is normally automatic; check
      the API's **Application Access** tab if your tenant restricts it.
- [ ] **Organizations:** on the application's **Organizations** tab, organization login is allowed ("Business users"
      or "Both").
- [ ] **Organization** Company A exists, and its ID equals `AUTH0_ORG_ID`. The database connection is enabled on the
      organization's **Connections** tab.
- [ ] Each person who signs in is a **member** of Company A. The seed script in section 3 adds the six demo users.

## 3. Supabase checklist

- [ ] Migrations `infra/supabase/migrations/001` to `005` are applied in order. `004` needs the pgvector extension,
      and `005` needs Vault.
- [ ] The six demo identities are provisioned in Auth0, in the organization and in `workspace_users`. The seed
      script needs these variables, on top of the API variables in `.env.local`:
  - A Management API machine-to-machine application with permission to read and create users and add organization
    members: `AUTH0_MANAGEMENT_CLIENT_ID` and `AUTH0_MANAGEMENT_CLIENT_SECRET`.
  - The database connection's name in `AUTH0_DATABASE_CONNECTION`.
  - `MOCK_USER_PASSWORDS_JSON`, with one password of 12 or more characters per user ID.

  Set these in your shell for the one-off run, so they don't need to live in `.env.local`:

  ```sh
  AUTH0_MANAGEMENT_CLIENT_ID=… AUTH0_MANAGEMENT_CLIENT_SECRET=… \
  AUTH0_DATABASE_CONNECTION=Username-Password-Authentication \
  MOCK_USER_PASSWORDS_JSON='{"ravi":"…","maya":"…","alex":"…","david":"…","nur":"…","wei":"…"}' \
  pnpm exec tsx --env-file=.env.local data/seed-auth0-users.ts
  ```

  The script reuses existing Auth0 accounts and does not reset their passwords. It prints `Provisioned <id>` for each
  user.
- [ ] Sign in as a **seeded** user, e.g. `ravi@aspire.example`. A personal or newly created account has no directory
      entry, and the API rejects it.

## 4. Run

```sh
pnpm install
pnpm dev:sso               # API on 127.0.0.1:3000, Auth0 mode, reads .env.local
pnpm --dir apps/web dev    # web host on 127.0.0.1:3001 (restart it after workspace UI edits)
```

`pnpm dev` is still the **demo** API: it accepts `x-demo-user` for curl testing and loads no env file. The website
can't use it, because the website only ever sends real Auth0 tokens.

## 5. End-to-end check

1. Run `curl http://127.0.0.1:3000/health`. It should return `"ok":true`.
2. Open `http://127.0.0.1:3001/` and choose **Sign in with SSO**. Log in as a seeded user. The page shows
   "Signed in as …".
3. Open `http://127.0.0.1:3001/api/session`. It should return your email.
4. Open `http://127.0.0.1:3001/api/brain/v1/me`. It should return your ID and role. If not, find the status code in
   the table below.

## 6. Symptom → cause

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/` says "SSO setup is incomplete" | The web host is missing `APP_BASE_URL`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` or `AUTH0_SECRET` | Fill them in the root `.env.local` and restart the web host |
| `/auth/login` returns 500 | The host can't fetch `https://AUTH0_DOMAIN/.well-known/openid-configuration` (wrong domain, or no network) | Check `AUTH0_DOMAIN` and outbound access |
| Auth0 shows an error page after **Sign in** (callback mismatch, organization, audience or "service not found") | A dashboard setting | Recheck section 2: callback URL, the Organizations tab, org membership and connection, API identifier |
| Callback fails with an invalid-state error, or login loops | `localhost` and `127.0.0.1` were mixed, or `AUTH0_SECRET` changed mid-login | Use `http://127.0.0.1:3001` only, and log in again |
| Logout shows an Auth0 error about the logout URL | **Allowed Logout URLs** doesn't contain the exact `APP_BASE_URL` value | Add `http://127.0.0.1:3001` |
| The workspace says "You are signed in, but the workspace API did not accept your account" (401) | The API rejected a valid session. In order of likelihood: 1. The API was started with `pnpm dev` instead of `pnpm dev:sso`. 2. `AUTH0_ISSUER`, `AUTH0_AUDIENCE` or `AUTH0_ORG_ID` differ between the token and the API. 3. The user's `sub` isn't in `workspace_users` for that org, or the row has `active = false`. | Check each in order. The workspace shows **Log out**, so you can switch to a seeded user. |
| "Your sign-in session has ended. Log in again." (401) | The web session cookie is gone or expired, or `AUTH0_SECRET` changed | Log in again |
| 502 "Workspace request failed; sign in again or check API availability" | The API isn't running at `BRAIN_API_URL`, or the access token expired and couldn't be refreshed (**Allow Offline Access** is off) | Start `pnpm dev:sso`; turn on offline access; log out and in |
| 503 "Workspace API audience and organization are not configured" | `AUTH0_AUDIENCE` or `AUTH0_ORG_ID` is empty for the web host | Set both and restart the web host |

### API startup errors (`pnpm dev:sso`)

| Message | Cause |
| --- | --- |
| `.env.local: not found` | There's no `.env.local` at the repository root |
| `Auth0 configuration required when demo authentication is disabled` | `AUTH0_ISSUER`, `AUTH0_AUDIENCE` and `AUTH0_ORG_ID` are all empty |
| `Auth0 requires the Supabase user directory` | `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are empty |
| `Supabase directory requires URL and secret key` | Only one of the two is set |
| `SUPABASE_URL must be an HTTPS project origin` | The URL isn't `https://…`, or it has a path |
| `Supabase workspace users failed (401)` / `(404)` / `fetch failed` | Wrong secret key, migrations `002`/`003` missing, or no network |
| `Invalid persistence configuration` | `AUTH0_ORG_ID` is empty while `SUPABASE_URL` is set |
| `AUDIT_SIGNING_KEY_FILE is required for durable audit` | No signing key path is set |
| `ENOENT … .pem` | The key path is wrong. It's resolved from the repository root. |
| `Invalid Auth0 configuration` | `AUTH0_ISSUER` isn't exactly `https://AUTH0_DOMAIN/` (check the trailing slash), or the audience or org is empty |

## How the code fits

- `lib/auth0.ts` creates the SDK client. It requests `openid profile email offline_access`, plus `audience` and
  `organization` when they're configured.
- `proxy.ts` runs the SDK middleware and redirects signed-out requests for `/workspace/*` to `/auth/login`.
- `app/api/brain/[...path]/route.ts` gets the access token with `auth0.getAccessToken()` and forwards it to the fixed
  `BRAIN_API_URL`. It never forwards caller-supplied bearer or `x-demo-user` headers, requires a matching Origin on
  mutating requests, and caps request bodies at 100 KB. It separates two kinds of 401:
  - `code: "signed_out"`: there's no web session.
  - `code: "account_rejected"`: the API refused a live session. There's one message for every cause, so
    configuration and directory details aren't revealed.
- The API side is `apps/api/src/auth.ts` (token validation) and `apps/api/src/user-directory.ts` (directory
  lookup).

## Production

Run `pnpm --dir apps/web build`, then `pnpm --dir apps/web start`. Set `APP_BASE_URL` and the Auth0 allowlists
(callback, logout and web origin) to the deployed HTTPS origin. Give the API and the web host separate environments,
and set `BRAIN_API_URL` to the API's origin.

Reference: https://github.com/auth0/nextjs-auth0
