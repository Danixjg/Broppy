import { NextResponse, type NextRequest } from "next/server";
import { auth0, authConfigured } from "./lib/auth0";
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
  if (path.startsWith("/workspace/") && !demo && !await auth0.getSession(request)) {
    return NextResponse.redirect(new URL("/auth/login", process.env.APP_BASE_URL));
  }
  return await auth0.middleware(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"] };
