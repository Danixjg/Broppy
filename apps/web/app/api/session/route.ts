import type { NextRequest } from "next/server";
import { auth0 } from "../../../lib/auth0";
import { wantsDemo } from "../../../lib/demo";

export async function GET(request: NextRequest) {
  let session = null;
  try { session = await auth0.getSession(); } catch { session = null; }
  const headers = { "cache-control": "no-store" };
  if (session) return Response.json({ user: { name: session.user.name, email: session.user.email } }, { headers });
  if (wantsDemo(request)) return Response.json({ demo: true }, { headers });
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
