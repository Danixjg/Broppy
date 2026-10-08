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
  // With several companies a sign-in has to name one. Any link to plain /auth/login (an expired session, an old bookmark)
  // goes through the company page first; invitation links and the company page's own links already name one.
  if (path === "/auth/login" && asksForCompany() && !request.nextUrl.searchParams.has("organization") && !request.nextUrl.searchParams.has("invitation")) {
    return NextResponse.redirect(new URL(signInPath(request.nextUrl.searchParams.get("returnTo") ?? undefined), process.env.APP_BASE_URL));
  }
  if (path.startsWith("/workspace/") && !demo && !await auth0.getSession(request)) {
    return NextResponse.redirect(new URL(signInPath(request.nextUrl.pathname + request.nextUrl.search), process.env.APP_BASE_URL));
  }
  return await auth0.middleware(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"] };
