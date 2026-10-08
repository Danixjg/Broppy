import { NextResponse, type NextRequest } from "next/server";

/**
 * Where the emailed invitation link lands (set this as the application's login address in Auth0). It passes the
 * invitation on to sign-in and sends the person to the guided setup afterwards: the company's first admin has setup to
 * do, and anyone else is taken on to the workspace.
 */
export function GET(request: NextRequest) {
  const incoming = request.nextUrl.searchParams;
  const login = new URL("/auth/login", process.env.APP_BASE_URL ?? request.nextUrl.origin);
  for (const name of ["invitation", "organization", "organization_name"]) {
    const value = incoming.get(name);
    if (value && value.length < 200 && /^[\w\-. ]+$/.test(value)) login.searchParams.set(name, value);
  }
  login.searchParams.set("returnTo", "/workspace/setup.html?welcome=1");
  return NextResponse.redirect(login);
}
