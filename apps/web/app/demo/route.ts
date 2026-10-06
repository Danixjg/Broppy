import type { NextRequest } from "next/server";
import { DEMO_COOKIE, demoApiUrl, sameHostRedirect } from "../../lib/demo";
import { workspaceTarget } from "../../links";

export function GET(request: NextRequest) {
  if (!demoApiUrl()) return sameHostRedirect(request, "/");
  const response = sameHostRedirect(request, workspaceTarget(request.nextUrl.searchParams));
  response.cookies.set(DEMO_COOKIE, "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60,
    secure: request.nextUrl.protocol === "https:" });
  return response;
}
