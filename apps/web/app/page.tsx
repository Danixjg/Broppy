import { auth0, authConfigured } from "../lib/auth0";
export const dynamic = "force-dynamic";
export default async function Home() {
  if (!authConfigured) return <main className="login-card">
    <h1>Sign in to Internal Brain</h1>
    <p>SSO setup is incomplete. Ask your workspace administrator to finish configuring sign-in.</p>
  </main>;
  const session = await auth0.getSession();
  return <main className="login-card">
    <h1>Internal Brain</h1>
    {session ? <>
      <p>Signed in as {session.user.email || session.user.name}</p>
      <p><a href="/workspace/index.html">Open workspace</a></p>
      <p><a href="/auth/logout">Sign out</a></p>
    </> : <>
      <p><a href="/auth/login">Sign in with SSO</a></p>
      <p><a href="/auth/login?screen_hint=signup">Sign up</a></p>
    </>}
  </main>;
}
