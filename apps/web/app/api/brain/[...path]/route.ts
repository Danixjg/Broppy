import { auth0 } from "../../../../lib/auth0";
import { browserOrigin, demoApiUrl, wantsDemo } from "../../../../lib/demo";
import type { NextRequest } from "next/server";

type Context = { params: Promise<{ path: string[] }> };

const signedOut = { error: "Your sign-in session has ended. Log in again.", code: "signed_out" };
// One message for every API rejection cause, so configuration and directory details are not revealed.
const accountRejected = { error: "You are signed in, but the workspace API did not accept your account. " +
  "Ask an administrator to check the API's Auth0 settings and your workspace directory entry.", code: "account_rejected" };
const demoRejected = { error: "The demo API did not accept this persona. It must run as the public demo " +
  "(PUBLIC_DEMO=true, or pnpm dev locally).", code: "demo_rejected" };
// A demo persona is a fixture user ID such as "maya", never a token or free text.
const PERSONA = /^[a-z][a-z0-9-]{0,31}$/;
const JSON_NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

function crossOrigin(request: NextRequest): boolean {
  if (["GET", "HEAD"].includes(request.method)) return false;
  const origin = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : browserOrigin(request);
  return request.headers.get("origin") !== origin;
}

// Only API paths are forwarded, with a bounded body.
async function outgoing(request: NextRequest, context: Context): Promise<{ path: string; body?: string } | Response> {
  const { path } = await context.params;
  if (!(path[0] === "v1" || (path.length === 1 && path[0] === "health")) || path.some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  if (body && Buffer.byteLength(body) > 100_000) return Response.json({ error: "Request too large" }, { status: 413 });
  return { path: `/${path.join("/")}${request.nextUrl.search}`, body };
}

// Demo visitors reach only the mock-only demo API, with the persona they picked and no credentials.
async function forwardDemo(request: NextRequest, context: Context) {
  if (crossOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const persona = request.headers.get("x-demo-user") ?? "";
  if (!PERSONA.test(persona)) return Response.json({ error: "Choose who you are viewing as." }, { status: 400 });
  const outbound = await outgoing(request, context);
  if (outbound instanceof Response) return outbound;
  try {
    const response = await fetch(new URL(outbound.path, demoApiUrl()!), { method: request.method, redirect: "error",
      cache: "no-store", headers: { "x-demo-user": persona, "content-type": "application/json" }, body: outbound.body,
      signal: AbortSignal.timeout(60_000) });
    if (response.status === 401) {
      await response.body?.cancel();
      return Response.json(demoRejected, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return new Response(response.body, { status: response.status, headers: JSON_NO_STORE });
  } catch {
    return Response.json({ error: "The demo API is not reachable; check DEMO_API_URL." }, { status: 502 });
  }
}

async function forward(request: NextRequest, context: Context) {
  let session = null;
  try { session = await auth0.getSession(); } catch { session = null; }
  // A signed-in session wins over the demo cookie.
  if (!session && wantsDemo(request)) return forwardDemo(request, context);
  if (!session) return Response.json(signedOut, { status: 401 });
  if (crossOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!process.env.AUTH0_AUDIENCE || !process.env.AUTH0_ORG_ID) {
    return Response.json({ error: "Workspace API audience and organization are not configured" }, { status: 503 });
  }
  const outbound = await outgoing(request, context);
  if (outbound instanceof Response) return outbound;
  try {
    const { token } = await auth0.getAccessToken();
    const response = await fetch(new URL(outbound.path, process.env.BRAIN_API_URL ?? "http://127.0.0.1:3000"), {
      method: request.method, redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: outbound.body,
      signal: AbortSignal.timeout(60_000) });
    if (response.status === 401) {
      await response.body?.cancel();
      return Response.json(accountRejected, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return new Response(response.body, { status: response.status, headers: JSON_NO_STORE });
  } catch {
    return Response.json({ error: "Workspace request failed; sign in again or check API availability" }, { status: 502 });
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
