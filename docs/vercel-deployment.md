# Deploy the web and API on Vercel

Configure separate Vercel projects for the web host and the signed-in API. Apply environment variables to the deployment environment you use, then redeploy each affected project. Your local `.env.local` does not configure Vercel.

## Configure the projects

| Project | Root Directory | Build |
| --- | --- | --- |
| Web | `apps/web` | Next.js preset with `pnpm build` |
| API | `apps/api` | Use the committed `vercel.json` build command and the detected `src/server.ts` Node server |

Enable access to source files outside the Root Directory for both projects. Keep the repository's pnpm workspace installation. Remove conflicting API build overrides so `bash ../../scripts/build-slack.sh` runs before Vercel traces the function.

The API build uses the shared Rust bootstrap despite its Slack name. It installs Rust when Cargo is absent and builds `packages/rust-core/brain-core.node` on the build host. The API function configuration includes that artifact in the deployment.

## Set the web environment

Replace the placeholders with your deployment origins and Auth0 application values.

```dotenv
APP_BASE_URL=https://WEB_PROJECT.vercel.app
BRAIN_API_URL=https://API_PROJECT.vercel.app
AUTH0_DOMAIN=DOMAIN
AUTH0_CLIENT_ID=REGULAR_WEB_APPLICATION_CLIENT_ID
AUTH0_CLIENT_SECRET=REGULAR_WEB_APPLICATION_CLIENT_SECRET
AUTH0_SECRET=GENERATED_SESSION_SECRET
AUTH0_AUDIENCE=API_IDENTIFIER
AUTH0_ORG_ID=ORGANIZATION_ID
```

Generate `AUTH0_SECRET` with `openssl rand -hex 32`. Set `AUTH0_AUDIENCE` and `AUTH0_ORG_ID` in the web project even when they already exist in the API project. The web host requests an access token for that audience and organization.

In the Auth0 Regular Web Application, add `https://WEB_PROJECT.vercel.app/auth/callback` to Allowed Callback URLs. Add `https://WEB_PROJECT.vercel.app` to Allowed Logout URLs and Allowed Web Origins. Enable organization login and the API's offline access. Use the same API identifier and organization in both Vercel projects.

## Set the API environment

```dotenv
AUTH0_ISSUER=https://DOMAIN/
AUTH0_AUDIENCE=API_IDENTIFIER
AUTH0_ORG_ID=ORGANIZATION_ID
SUPABASE_URL=https://SUPABASE_PROJECT.supabase.co
SUPABASE_SECRET_KEY=SUPABASE_SERVER_SECRET_KEY
AUDIT_SIGNING_KEY=ED25519_PEM_PRIVATE_KEY
WEB_ORIGIN=https://WEB_PROJECT.vercel.app
API_ORIGIN=https://API_PROJECT.vercel.app
```

Keep the trailing slash on `AUTH0_ISSUER`. Provision the Supabase schema and active organization directory members using [live sources and sign-in](live-sources-and-sign-in.md).

`AUDIT_SIGNING_KEY` holds the Ed25519 PEM private key itself (Vercel has no place for a key file). Add it as a **Sensitive** variable; line breaks may be pasted as real newlines or written as `\n`. Generate one with `openssl genpkey -algorithm ed25519`. `AUDIT_SIGNING_KEY_FILE` (a path to a PEM in the running function) still works and is used only when `AUDIT_SIGNING_KEY` is unset. Do not commit private keys.

Configure connector credentials separately through [Slack onboarding](slack-onboarding.md) and [live sources](live-sources-and-sign-in.md). Keep `PUBLIC_DEMO` disabled for this signed-in API. A public demo requires its own API and the web host's separate `DEMO_API_URL`.

## Verify the deployment

1. Check the API build log for `Built packages/rust-core/brain-core.node` before function packaging.
2. Inspect the generated function artifact for `packages/rust-core/brain-core.node` beside `packages/rust-core/src/index.mjs`. Load that packaged module in a compatible Linux runtime. A local build alone does not prove the deployed function contains it.
3. Request `https://API_PROJECT.vercel.app/health` and confirm HTTP 200. If it fails, inspect the new runtime error. Auth0, directory, and audit initialization run before this route can respond.
4. After redeploying the web project, sign out and sign in again to obtain a token with the configured audience and organization.
5. Open `/api/brain/v1/me` on the web host and confirm the signed-in user's identity. Open Connectors and confirm it loads.

If Connectors reports that the workspace API audience and organization are not configured, check the web project's `AUTH0_AUDIENCE` and `AUTH0_ORG_ID`. If API logs report `MODULE_NOT_FOUND` for `../brain-core.node`, check the API build command and function artifact.

Before using Vercel for ongoing imports, review the [current deployment limits](live-sources-and-sign-in.md). The API uses process-local sync state and timers, and its documented operating model requires one API writer per organization. Packaging the native module does not establish that background imports or concurrent function instances satisfy that model.
