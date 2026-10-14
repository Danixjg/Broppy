import { NextResponse, type NextRequest } from "next/server";
import { auth0, authConfigured, orgIdProblem } from "./lib/auth0";
import { asksForCompany, pinnedOrganization, signInPath } from "./lib/company";
import { demoApiUrl, sameHostRedirect, wantsDemo } from "./lib/demo";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const demo = wantsDemo(request);
  if (!authConfigured) {
    // Without SSO settings, a deployment can still serve the start page and the public demo.
    if (demoApiUrl() && (path === "/" || path === "/demo" || path === "/demo/exit" || demo)) return NextResponse.next();
    if (path.startsWith("/api/")) return NextResponse.json({ error: "SSO is not configured" }, { status: 503 });
    if (path !== "/") return sameHostRedirect(request, "/");
    return NextResponse.next();
  }
  const orgProblem = pinnedOrganization() ? orgIdProblem() : undefined;
  if (orgProblem && (path.startsWith("/auth/") || path.startsWith("/workspace/"))) {
    // Fail with the fix instead of bouncing through Auth0 and ending on a bare 500 at /auth/callback.
    return NextResponse.json({ error: orgProblem }, { status: 503 });
  }
  // With several companies, a plain sign-in names none: Auth0 asks for the email and password first, then for the
  // company if the person belongs to more than one (the application's login flow is "Prompt for Credentials").
  // A signed-out visit to the workspace goes straight there, and comes back to the same page.
  if (path.startsWith("/workspace/") && !demo && !await auth0.getSession(request)) {
    const returnTo = request.nextUrl.pathname + request.nextUrl.search;
    return NextResponse.redirect(new URL(asksForCompany() ? `/auth/login?${new URLSearchParams({ returnTo })}` : signInPath(returnTo), process.env.APP_BASE_URL));
  }
  return await auth0.middleware(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"] };
