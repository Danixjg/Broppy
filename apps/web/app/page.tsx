import { auth0, authConfigured } from "../lib/auth0";
import { demoApiUrl } from "../lib/demo";
export const dynamic = "force-dynamic";
export default async function Home() {
  const demo = Boolean(demoApiUrl());
  if (!authConfigured && !demo) return <main className="login-card">
    <h1>Sign in to Internal Brain</h1>
    <p>SSO setup is incomplete. Ask your workspace administrator to finish configuring sign-in.</p>
  </main>;
  const session = authConfigured ? await auth0.getSession() : null;
  return <main className="login-card">
    <h1>Internal Brain</h1>
    {session ? <>
      <p>Signed in as {session.user.email || session.user.name}</p>
      <p><a href="/workspace/index.html">Open workspace</a></p>
      <p><a href="/auth/logout">Sign out</a></p>
    </> : <>
      {authConfigured && <p><a href="/auth/login">Sign in with SSO</a></p>}
      {demo && <p><a href="/demo">Try the demo</a>: no sign-in; choose who you are viewing as in the workspace header.
        All people and data in the demo are fictional.</p>}
    </>}
  </main>;
}
