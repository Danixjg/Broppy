import { auth0 } from "../../../../lib/auth0";
import type { NextRequest } from "next/server";

const signedOut = { error: "Your sign-in session has ended. Log in again.", code: "signed_out" };
// One message for every API rejection cause, so configuration and directory details are not revealed.
const accountRejected = { error: "You are signed in, but the workspace API did not accept your account. " +
  "Ask an administrator to check the API's Auth0 settings and your workspace directory entry.", code: "account_rejected" };

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!await auth0.getSession()) return Response.json(signedOut, { status: 401 });
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== new URL(process.env.APP_BASE_URL!).origin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!process.env.AUTH0_AUDIENCE || !process.env.AUTH0_ORG_ID) {
    return Response.json({ error: "Workspace API audience and organization are not configured" }, { status: 503 });
  }
  const { path } = await context.params;
  if (!(path[0] === "v1" || (path.length === 1 && path[0] === "health")) || path.some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const { token } = await auth0.getAccessToken();
    const base = new URL(process.env.BRAIN_API_URL ?? "http://127.0.0.1:3000");
    const target = new URL(`/${path.join("/")}`, base);
    target.search = request.nextUrl.search;
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
    if (body && Buffer.byteLength(body) > 100_000) return Response.json({ error: "Request too large" }, { status: 413 });
    const response = await fetch(target, { method: request.method, redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(60_000) });
    if (response.status === 401) {
      await response.body?.cancel();
      return Response.json(accountRejected, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Workspace request failed; sign in again or check API availability" }, { status: 502 });
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
