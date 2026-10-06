import { NextResponse, type NextRequest } from "next/server";
import { auth0, authConfigured, orgIdProblem } from "./lib/auth0";
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
  const orgProblem = orgIdProblem();
  if (orgProblem && (path.startsWith("/auth/") || path.startsWith("/workspace/"))) {
    // Fail with the fix instead of bouncing through Auth0 and ending on a bare 500 at /auth/callback.
    return NextResponse.json({ error: orgProblem }, { status: 503 });
  }
  if (path.startsWith("/workspace/") && !demo && !await auth0.getSession(request)) {
    const login = new URL("/auth/login", process.env.APP_BASE_URL);
    login.searchParams.set("returnTo", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return await auth0.middleware(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"] };
