import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { formatReport, runDoctor, type Check } from "./doctor.js";

const TENANT = "https://tenant.example.auth0.com";
const SUPABASE = "https://project.supabase.co";
const API = "http://127.0.0.1:3000";
const WEB = "http://127.0.0.1:3001";
const SECRETS = {
  AUTH0_CLIENT_SECRET: "client-secret-value",
  AUTH0_SECRET: "0123456789abcdef".repeat(4),
  SUPABASE_SECRET_KEY: "supabase-secret-value"
};
const ENV = {
  APP_BASE_URL: WEB,
  AUTH0_DOMAIN: "tenant.example.auth0.com",
  AUTH0_CLIENT_ID: "client-id",
  AUTH0_AUDIENCE: "https://api.example",
  AUTH0_ORG_ID: "org_abc123",
  BRAIN_API_URL: API,
  AUTH0_ISSUER: `${TENANT}/`,
  SUPABASE_URL: SUPABASE,
  AUDIT_SIGNING_KEY_FILE: "audit-signing-key.pem",
  ...SECRETS
};
const ED25519 = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
const USERS = ["ravi", "maya", "alex", "david", "nur", "wei"];

function row(id: string, overrides: Record<string, unknown> = {}) {
  return { user_id: id, auth0_sub: `auth0|6512${id}`, org_id: "org_abc123", active: true, name: id,
    email: `${id}@aspire.example`, role: "member", groups: [], contractor: false, platform_identities: {}, ...overrides };
}

const page = (html: string, status = 400) => new Response(`<html><body>${html}</body></html>`, { status });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

// A healthy tenant, project and pair of running services; each test breaks one part.
function services(override: (url: URL) => Response | undefined = () => undefined) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    const custom = override(url);
    if (custom) return custom;
    if (url.origin === TENANT) {
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer: `${TENANT}/` });
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [{ kty: "RSA", alg: "RS256" }] });
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "invalid_grant", error_description: "Invalid authorization code" }, { status: 403 });
      }
      if (url.pathname === "/authorize") return redirect("/u/login?state=hKFo2SB");
      if (url.pathname === "/v2/logout") return redirect(url.searchParams.get("returnTo")!);
    }
    if (url.origin === SUPABASE) {
      return url.searchParams.has("org_id") ? Response.json(USERS.map(id => row(id))) : Response.json([]);
    }
    if (url.origin === API) {
      return url.pathname === "/health" ? Response.json({ ok: true }) : Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (url.origin === WEB) return new Response("<main><a href=\"/auth/login\">Sign in with SSO</a></main>");
    throw new Error(`Unexpected request to ${url.origin}`);
  });
}

const deps = (fetcher: typeof fetch) => ({ fetch: fetcher, readFile: () => Buffer.from(ED25519) });
const failures = (checks: Check[]) => checks.filter(check => check.status === "fail");
const messages = (checks: Check[]) => failures(checks).map(check => `${check.message} | ${check.fix ?? ""}`).join("\n");

describe("SSO doctor", () => {
  it("passes a healthy setup, never prints a secret and sends each secret only to its own service", async () => {
    const fetcher = services();
    const checks = await runDoctor(ENV, deps(fetcher));
    expect(failures(checks)).toEqual([]);
    expect(checks.filter(check => check.status === "skip")).toEqual([]);
    const report = formatReport(checks, WEB);
    expect(report).toContain("No problems found");
    for (const secret of Object.values(SECRETS)) expect(report).not.toContain(secret);
    for (const [input, init] of fetcher.mock.calls) {
      const sent = JSON.stringify([String(input), init ?? {}]);
      const origin = new URL(String(input)).origin;
      if (sent.includes(SECRETS.AUTH0_CLIENT_SECRET)) expect(origin).toBe(TENANT);
      if (sent.includes(SECRETS.SUPABASE_SECRET_KEY)) expect(origin).toBe(SUPABASE);
      expect(sent).not.toContain(SECRETS.AUTH0_SECRET);
    }
  });

  it("explains settings mistakes", async () => {
    const checks = await runDoctor({ ...ENV, APP_BASE_URL: "http://localhost:3001", AUTH0_ISSUER: TENANT,
      AUTH0_SECRET: "too-short", AUTH0_ORG_ID: "Company A", SUPABASE_URL: "" }, deps(services()));
    const text = messages(checks);
    expect(text).toContain("Missing from .env.local: SUPABASE_URL");
    expect(text).toContain("APP_BASE_URL uses localhost");
    expect(text).toContain(`AUTH0_ISSUER must be exactly ${TENANT}/`);
    expect(text).toContain("AUTH0_SECRET must be 64 hexadecimal characters");
    expect(text).toContain("AUTH0_ORG_ID must be the organization's ID");
    expect(checks.find(check => check.section === "Supabase")?.status).toBe("skip");
  });

  it("reports a missing or unusable audit signing key", async () => {
    const missing = await runDoctor(ENV, { fetch: services(), readFile: () => { throw new Error("ENOENT: no such file"); } });
    expect(messages(missing)).toContain("AUDIT_SIGNING_KEY_FILE cannot be read as a private key");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    const wrongType = await runDoctor(ENV, { fetch: services(), readFile: () => Buffer.from(rsa) });
    expect(messages(wrongType)).toContain("holds a rsa key, not Ed25519");
  });

  it("reports what the Auth0 tenant rejects, with the matching fix", async () => {
    const checks = await runDoctor(ENV, deps(services(url => {
      if (url.pathname === "/oauth/token") return Response.json({ error: "access_denied", error_description: "Unauthorized" }, { status: 401 });
      if (url.pathname === "/authorize") {
        return page("<h1>Oops!, something went wrong</h1><p>Callback URL mismatch. The provided redirect_uri is not in the list of allowed callback URLs.</p>");
      }
      if (url.pathname === "/v2/logout") {
        return page("invalid_request: The &quot;returnTo&quot; querystring parameter &quot;http://127.0.0.1:3001&quot; is not defined as a valid URL in &quot;Allowed Logout URLs&quot;.");
      }
      return undefined;
    })));
    const text = messages(checks);
    expect(text).toContain("did not accept the client credentials (access_denied: Unauthorized)");
    expect(text).toContain("Callback URL mismatch");
    expect(text).toContain(`Add ${WEB}/auth/callback to Allowed Callback URLs`);
    expect(text).toContain(`Auth0 will not return to ${WEB} after logout`);
    expect(text).toContain(`Add ${WEB} exactly as written to Allowed Logout URLs`);
  });

  it("reports sign-in errors that Auth0 sends back to the callback", async () => {
    const audience = await runDoctor(ENV, deps(services(url => url.pathname === "/authorize"
      ? redirect(`${WEB}/auth/callback?error=access_denied&error_description=Service%20not%20found%3A%20https%3A%2F%2Fapi.example&state=x`)
      : undefined)));
    expect(messages(audience)).toContain("Service not found: https://api.example");
    expect(messages(audience)).toContain("identifier equals AUTH0_AUDIENCE");
    const organization = await runDoctor(ENV, deps(services(url => url.pathname === "/authorize"
      ? redirect(`${WEB}/auth/callback?error=invalid_request&error_description=parameter%20organization%20is%20invalid`)
      : undefined)));
    expect(messages(organization)).toContain("Organizations tab");
  });

  it("stops the tenant checks when the tenant cannot be reached", async () => {
    const checks = await runDoctor(ENV, deps(services(url => {
      if (url.origin === TENANT) throw new TypeError("fetch failed");
      return undefined;
    })));
    const tenant = checks.filter(check => check.section === "Auth0 tenant");
    expect(tenant).toHaveLength(1);
    expect(tenant[0].message).toContain(`Cannot reach the tenant at ${TENANT}`);
  });

  it("finds missing migrations and demo users that are not ready", async () => {
    const checks = await runDoctor(ENV, deps(services(url => {
      if (url.origin !== SUPABASE) return undefined;
      if (url.pathname === "/rest/v1/brain_state") return Response.json({ code: "PGRST205" }, { status: 404 });
      if (url.searchParams.has("org_id")) {
        return Response.json(USERS.filter(id => id !== "wei").map(id =>
          id === "alex" ? row(id, { active: false }) : id === "ravi" ? row(id, { auth0_sub: "auth0|ravi" }) : row(id)));
      }
      return undefined;
    })));
    const text = messages(checks);
    expect(text).toContain("Missing tables: brain_state (migration 004)");
    expect(text).toContain("wei is missing");
    expect(text).toContain("alex is inactive");
    expect(text).toContain("ravi still has the placeholder subject auth0|ravi");
  });

  it("reports a rejected Supabase key and an empty directory", async () => {
    const rejected = await runDoctor(ENV, deps(services(url =>
      url.origin === SUPABASE ? Response.json({ message: "Invalid API key" }, { status: 401 }) : undefined)));
    expect(messages(rejected)).toContain("Supabase rejected SUPABASE_SECRET_KEY");
    const empty = await runDoctor(ENV, deps(services(url => url.origin === SUPABASE ? Response.json([]) : undefined)));
    expect(messages(empty)).toContain("The directory has no users for organization org_abc123");
  });

  it("spots an API left in demo mode and a web host started without its settings", async () => {
    const checks = await runDoctor(ENV, deps(services(url => {
      if (url.origin === API && url.pathname === "/v1/me") return Response.json({ id: "ravi" });
      if (url.origin === WEB) return new Response("<main>SSO setup is incomplete.</main>");
      return undefined;
    })));
    const text = messages(checks);
    expect(text).toContain("running in demo mode");
    expect(text).toContain("pnpm dev:sso");
    expect(text).toContain("The web host is running without its Auth0 settings");
  });

  it("skips services that are not running instead of failing", async () => {
    const checks = await runDoctor(ENV, deps(services(url => {
      if (url.origin === API || url.origin === WEB) throw new TypeError("fetch failed");
      return undefined;
    })));
    expect(failures(checks)).toEqual([]);
    expect(checks.filter(check => check.status === "skip").map(check => check.message).join("\n"))
      .toMatch(/API is not reachable[\s\S]*web host is not reachable/);
  });
});
