import { redirect } from "next/navigation";
import { AuthShell } from "../auth-shell";
import { authConfigured } from "../../lib/auth0";
import { allow } from "../../lib/visitor-limit";
import { apiOrigin, asksForCompany, safeReturn, signupMode, signupPath } from "../../lib/company";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Broppy" };

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The company's ID and name, asked of the API. Nothing about the company's people or data is revealed. */
async function findCompany(query: { name: string } | { email: string }): Promise<{ organization: string } | "none" | "busy"> {
  const origin = apiOrigin();
  if (!origin) return "busy";
  try {
    const response = await fetch(new URL(`/v1/companies/find?${new URLSearchParams(query)}`, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) { await response.body?.cancel(); return "none"; }
    if (!response.ok) { await response.body?.cancel(); return "busy"; }
    const found = await response.json() as { organization?: unknown };
    return typeof found.organization === "string" && /^org_[A-Za-z0-9]+$/.test(found.organization) ? { organization: found.organization } : "none";
  } catch { return "busy"; }
}

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  if (!authConfigured) redirect("/");
  // With one fixed company there is nothing to choose: go straight to its sign-in.
  if (!asksForCompany()) redirect(`/auth/login?${new URLSearchParams({ returnTo: safeReturn(query.returnTo) })}`);
  const returnTo = safeReturn(query.returnTo);
  const company = one(query.company).trim().slice(0, 80);
  const email = one(query.email).trim().slice(0, 254);
  let problem: { for: "company" | "email"; text: string } | undefined;
  const search = company ? { for: "company" as const, find: { name: company } } : email ? { for: "email" as const, find: { email } } : undefined;
  if (search) {
    const list = await headers();
    const visitor = list.get("x-forwarded-for")?.split(",")[0].trim() || list.get("x-real-ip") || "unknown";
    if (!allow(`find:${visitor}`, 30, 600_000)) problem = { for: search.for, text: "Too many tries. Please wait a few minutes and try again." };
    else {
      const found = await findCompany(search.find);
      if (typeof found === "object") redirect(`/auth/login?${new URLSearchParams({ organization: found.organization, returnTo })}`);
      problem = { for: search.for, text: found === "none"
        ? search.for === "company" ? "We couldn't find a company at that address. Check the spelling, or ask your admin: it is shown on their setup page."
          : "We couldn't find a personal workspace for that email. Check the spelling, or sign up for one."
        : "We couldn't reach Broppy just now. Please try again in a minute." };
    }
  }
  const hidden = returnTo !== "/workspace/index.html" && <input type="hidden" name="returnTo" value={returnTo} />;
  const login = `/auth/login?${new URLSearchParams({ returnTo })}`;
  return <AuthShell>
    <section className="form-card">
      <h1>Sign in</h1>
      <p className="form-lead">Sign in with your email and password. If you belong to more than one company, you'll choose which one next.</p>
      <p className="form-actions"><a className="btn primary" href={login}>Sign in</a></p>
      {signupMode() === "on" && <p className="form-foot">New to Broppy? <a href={signupPath("personal")}>Sign up</a> · <a href={signupPath("enterprise")}>Enterprise sign up</a></p>}
      {/* Rarely needed: someone told an address, or an account that isn't a member of its company yet. */}
      <details className="form-more" open={Boolean(problem)}>
        <summary>Sign in with a company address instead</summary>
        {problem?.for === "company" && <p className="form-error" role="alert">{problem.text}</p>}
        <form method="get" action="/signin" className="form">
          <label>Company address<input name="company" required maxLength={80} autoComplete="off" spellCheck={false} defaultValue={company} placeholder="acme-7k2qmx" /></label>
          {hidden}
          <button className="btn" type="submit">Continue</button>
        </form>
        {problem?.for === "email" && <p className="form-error" role="alert">{problem.text}</p>}
      </details>
    </section>
  </AuthShell>;
}
