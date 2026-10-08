import { redirect } from "next/navigation";
import { AuthShell } from "../auth-shell";
import { authConfigured } from "../../lib/auth0";
import { allow } from "../../lib/visitor-limit";
import { apiOrigin, asksForCompany, safeReturn, signupMode } from "../../lib/company";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Broppy" };

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The company's ID and name, asked of the API. Nothing about the company's people or data is revealed. */
async function findCompany(name: string): Promise<{ organization: string } | "none" | "busy"> {
  const origin = apiOrigin();
  if (!origin) return "busy";
  try {
    const response = await fetch(new URL(`/v1/companies/find?${new URLSearchParams({ name })}`, origin), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
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
  let problem: string | undefined;
  if (company) {
    const list = await headers();
    const visitor = list.get("x-forwarded-for")?.split(",")[0].trim() || list.get("x-real-ip") || "unknown";
    if (!allow(`find:${visitor}`, 30, 600_000)) problem = "Too many tries. Please wait a few minutes and try again.";
    else {
      const found = await findCompany(company);
      if (typeof found === "object") redirect(`/auth/login?${new URLSearchParams({ organization: found.organization, returnTo })}`);
      problem = found === "none" ? "We couldn't find a company with that name. Check the spelling, or ask your admin for the name they used." : "We couldn't reach Broppy just now. Please try again in a minute.";
    }
  }
  return <AuthShell>
    <section className="form-card">
      <h1>Sign in</h1>
      <p className="form-lead">Enter your company's name and we'll take you to its sign-in.</p>
      {problem && <p className="form-error" role="alert">{problem}</p>}
      <form method="get" action="/signin" className="form">
        <label>Company name<input name="company" required maxLength={80} autoComplete="organization" defaultValue={company} placeholder="Acme" autoFocus /></label>
        {returnTo !== "/workspace/index.html" && <input type="hidden" name="returnTo" value={returnTo} />}
        <button className="btn primary" type="submit">Continue</button>
      </form>
      {signupMode() === "on" && <p className="form-foot">New to Broppy? <a href="/signup">Create your company</a></p>}
    </section>
  </AuthShell>;
}
