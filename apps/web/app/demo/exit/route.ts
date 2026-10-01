import type { NextRequest } from "next/server";
import { DEMO_COOKIE, sameHostRedirect } from "../../../lib/demo";

export function GET(request: NextRequest) {
  const response = sameHostRedirect(request, "/");
  response.cookies.delete(DEMO_COOKIE);
  return response;
}
