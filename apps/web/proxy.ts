import { NextResponse, type NextRequest } from "next/server";
import { auth0, authConfigured } from "./lib/auth0";

export async function proxy(request: NextRequest) {
  if (!authConfigured) {
    if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "SSO is not configured" }, { status: 503 });
    if (request.nextUrl.pathname !== "/") return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith("/workspace/") && !await auth0.getSession(request)) {
    return NextResponse.redirect(new URL("/auth/login", process.env.APP_BASE_URL));
  }
  return await auth0.middleware(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"] };
