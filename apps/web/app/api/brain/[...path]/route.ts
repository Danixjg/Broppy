import { auth0 } from "../../../../lib/auth0";
import { signupMode } from "../../../../lib/company";
import { browserOrigin, demoApiUrl, wantsDemo } from "../../../../lib/demo";
import type { NextRequest } from "next/server";

type Context = { params: Promise<{ path: string[] }> };

const signedOut = { error: "Your sign-in session has ended. Log in again.", code: "signed_out" };
// One message for every API rejection cause, so configuration and directory details are not revealed.
// Written for the person using Broppy; the technical cause is logged on the server, not shown.
const tokenUnavailable = { error: "Your sign-in needs refreshing. Log out and log in again.", code: "token_unavailable" };
const apiNotConfigured = { error: "Broppy isn't available on this site just now. Please try again later.", code: "api_not_configured" };
const accountRejected = { error: "Broppy couldn't confirm your sign-in for this company. Log out and sign in again; if it keeps happening, ask your company's admin to check your email is on its People list.", code: "account_rejected" };
const busy = { error: "Broppy is starting up or busy. Try again in a moment.", code: "api_busy" };
const slow = { error: "That's taking longer than usual. Try again in a moment.", code: "api_timeout" };
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

// A demo API on a protected Vercel preview needs the project's automation bypass secret.
function demoHeaders(request: NextRequest, persona: string): Record<string, string> {
  const headers: Record<string, string> = { "x-demo-user": persona, "content-type": "application/json" };
  if (process.env.DEMO_API_BYPASS) headers["x-vercel-protection-bypass"] = process.env.DEMO_API_BYPASS;
  writeHeaders(request, headers);
  return headers;
}

function writeHeaders(request: NextRequest, headers: Record<string, string>): Record<string, string> {
  const ifMatch = request.headers.get("if-match");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (ifMatch) headers["if-match"] = ifMatch;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return headers;
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
      cache: "no-store", headers: demoHeaders(request, persona), body: outbound.body,
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
  // The company is part of the signed-in session (its token names it), so only the audience has to be set here.
  if (!process.env.AUTH0_AUDIENCE || (!process.env.AUTH0_ORG_ID && signupMode() === "off")) {
    return Response.json({ error: "Workspace API audience and organization are not configured" }, { status: 503 });
  }
  const outbound = await outgoing(request, context);
  if (outbound instanceof Response) return outbound;
  // On Vercel there is no API on localhost, so a missing BRAIN_API_URL is a configuration error, not an unreachable API.
  if (!process.env.BRAIN_API_URL && process.env.VERCEL) {
    console.error("brain proxy: BRAIN_API_URL is not set on this deployment");
    return Response.json(apiNotConfigured, { status: 503, headers: { "cache-control": "no-store" } });
  }
  let token: string;
  try { ({ token } = await auth0.getAccessToken()); } catch (error) {
    console.error("brain proxy: no access token for the API", error instanceof Error ? error.name : "unknown");
    return Response.json(tokenUnavailable, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const response = await fetch(new URL(outbound.path, process.env.BRAIN_API_URL ?? "http://127.0.0.1:3000"), {
      method: request.method, redirect: "error", cache: "no-store",
      headers: writeHeaders(request, { authorization: `Bearer ${token}`, "content-type": "application/json" }), body: outbound.body,
      signal: AbortSignal.timeout(60_000) });
    if (response.status === 401) {
      // The API's own reason (a company not on the list, an expired token) is logged there; the person gets one plain message.
      await response.body?.cancel();
      return Response.json(accountRejected, { status: 401, headers: { "cache-control": "no-store" } });
    }
    // The host's own error page (a cold start or time limit) is HTML, not the API's JSON: answer in words instead.
    if (response.status >= 500 && !response.headers.get("content-type")?.includes("json")) {
      await response.body?.cancel();
      console.error("brain proxy: API answered", response.status, "without JSON");
      return Response.json(response.status === 504 ? slow : busy, { status: response.status, headers: { "cache-control": "no-store" } });
    }
    return new Response(response.body, { status: response.status, headers: JSON_NO_STORE });
  } catch (error) {
    // The name and cause code say whether this was a timeout, a refused connection or a redirect, without revealing the URL.
    console.error("brain proxy: API request failed", error instanceof Error ? error.name : "unknown", (error as { cause?: { code?: string } })?.cause?.code ?? "");
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json(timedOut ? slow : { ...busy, code: "api_unreachable" }, { status: timedOut ? 504 : 502, headers: { "cache-control": "no-store" } });
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
