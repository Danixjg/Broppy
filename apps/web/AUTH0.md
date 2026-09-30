# Auth0 Regular Web Application setup

The web host uses Next.js 16 and the official `@auth0/nextjs-auth0` v4 SDK. The existing workspace UI is still compiled with Vite and served by Next.js under `/workspace/`. All sign-in and session handling runs through the SDK; the old manual browser PKCE/token-storage code has been removed.

1. In the Auth0 application `msyBcV9l7aWnFYDW2NqlF2BvjeeUHwlD` on tenant `dev-3es7focax4cjcswg.us.auth0.com`, retain **Regular Web Application** and **Client Secret Post**.
2. Set **Allowed Callback URLs** to `http://127.0.0.1:3001/auth/callback` and **Allowed Logout URLs** to `http://127.0.0.1:3001/`. Use `http://127.0.0.1:3001` for the local application origin. These dashboard settings must be saved by the tenant administrator.
3. Edit `.env.local` privately. Keep this file at the repository root (`TrippyAspire/.env.local`). The web dev, build, and start commands load environment variables from that root. Public configuration is in the root `.env.example`; `.env.local` is ignored. Enter the real `AUTH0_CLIENT_SECRET` locally. `AUTH0_SECRET` must contain 64 random hexadecimal characters; a new private file receives a generated value without printing it. Existing environment files are preserved. Never use the masked example as a secret.
4. Login and the identity page use `APP_BASE_URL`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and `AUTH0_SECRET`. For the knowledge workspace, also set `AUTH0_AUDIENCE` to the existing API identifier and `AUTH0_ORG_ID` to Company A's Auth0 organization ID. Register the application with that API/organization and provision the user's real subject in the Supabase directory.
5. Configure the separate API server with matching `AUTH0_ISSUER=https://dev-3es7focax4cjcswg.us.auth0.com/`, `AUTH0_AUDIENCE`, `AUTH0_ORG_ID`, Supabase directory/storage credentials, and audit signing key as described in `docs/live-sources-and-sign-in.md`. Web secrets are not forwarded to the API. A demo-only API does not accept real Auth0 tokens.
6. Run `pnpm --dir apps/web dev`, then visit `http://127.0.0.1:3001/`. Click **Sign in with SSO** or **Sign up**. After signing in, the home page shows your identity and a link to the existing workspace. Signing up alone does not grant workspace access: directory membership is required.

For production: `pnpm --dir apps/web build`, then `pnpm --dir apps/web start`. Update `APP_BASE_URL` and the Auth0 allowlists to the deployed HTTPS origin. During local UI development, restart `pnpm --dir apps/web dev` after workspace UI edits to rebuild its Vite assets.

`lib/auth0.ts` creates the SDK client. `proxy.ts` returns the SDK middleware response and protects workspace assets. SDK-managed encrypted HttpOnly cookies replace sessionStorage tokens. `/api/brain/*` obtains an access token through `auth0.getAccessToken()` and forwards it server-side to the fixed `BRAIN_API_URL`; it does not accept caller-supplied bearer or demo identity headers. Mutating requests require a matching Origin. `/auth/access-token` is disabled so browser JavaScript cannot retrieve bearer tokens.

Reference: https://github.com/auth0/nextjs-auth0
