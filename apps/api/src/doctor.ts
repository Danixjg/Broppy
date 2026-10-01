import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadMockCorpus } from "@brain/connectors";
import type { User } from "@brain/types";
import { UserDirectory } from "./user-directory.js";

// Checks the local SSO setup from .env.local: settings, the Auth0 tenant, the Supabase directory and the running
// services. It only reads, and no report line contains a secret value.

export interface Check {
  section: string;
  status: "pass" | "fail" | "skip";
  message: string;
  fix?: string;
}

export interface DoctorDeps {
  fetch: typeof fetch;
  readFile: (path: string) => Buffer;
}

type Env = Record<string, string | undefined>;

const REQUIRED = ["APP_BASE_URL", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET",
  "BRAIN_API_URL", "AUTH0_AUDIENCE", "AUTH0_ORG_ID", "AUTH0_ISSUER", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "AUDIT_SIGNING_KEY_FILE"];
// Migration 003 only adds columns, which the directory read covers; 005 only adds functions.
const TABLES: Array<[string, string]> = [["source_documents", "001"], ["audit_entries", "001"],
  ["workspace_users", "002"], ["organizations", "004"], ["brain_state", "004"]];
const GENERATE_KEY = "Generate one with: openssl genpkey -algorithm ed25519 -out audit-signing-key.pem";

function report(section: string) {
  const checks: Check[] = [];
  const add = (status: Check["status"]) => (message: string, fix?: string) => {
    checks.push({ section, status, message, ...(fix ? { fix } : {}) });
  };
  return { checks, pass: add("pass"), fail: add("fail"), skip: add("skip") };
}

function parseUrl(value: string | undefined): URL | undefined {
  try { return value ? new URL(value.trim()) : undefined; } catch { return undefined; }
}

function origin(value: string | undefined): string | undefined {
  const url = parseUrl(value);
  return url && ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
}

const timeout = () => AbortSignal.timeout(10_000);

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" ? `${message}: ${code}` : message;
}

// The useful sentence from an Auth0 error page or JSON error body.
async function pageText(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const json = JSON.parse(body) as { error?: unknown; error_description?: unknown; message?: unknown };
    const parts = [json.error, json.error_description ?? json.message].filter(part => typeof part === "string");
    if (parts.length) return parts.join(": ");
  } catch { /* not JSON */ }
  const text = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const known = /(callback url mismatch|invalid_request|unauthorized_client|access_denied|unknown client|service not found)[^]{0,220}/i
    .exec(text);
  return (known?.[0] ?? text).slice(0, 240) || `HTTP ${response.status}`;
}

function auth0Fix(detail: string, callback: string): string {
  if (/callback|redirect_uri/i.test(detail)) return `Add ${callback} to Allowed Callback URLs (AUTH0.md section 2).`;
  if (/unknown client|client_id/i.test(detail)) return "Check AUTH0_CLIENT_ID against the application in the Auth0 dashboard.";
  if (/service not found|audience/i.test(detail)) {
    return "Create an API whose identifier equals AUTH0_AUDIENCE, or correct AUTH0_AUDIENCE (AUTH0.md section 2).";
  }
  if (/organization/i.test(detail)) {
    return "Check AUTH0_ORG_ID, allow organization logins on the application's Organizations tab, and enable the " +
      "database connection for the organization (AUTH0.md section 2).";
  }
  return "Compare the application with the dashboard checklist in AUTH0.md section 2.";
}

function settingsChecks(env: Env, deps: DoctorDeps): Check[] {
  const { checks, pass, fail } = report("Settings");
  const missing = REQUIRED.filter(name => !env[name]?.trim());
  if (missing.length) {
    fail(`Missing from .env.local: ${missing.join(", ")}`,
      "Copy .env.example to .env.local at the repository root and fill these in (AUTH0.md section 1).");
  } else pass("Every required setting is present");

  if (env.APP_BASE_URL) {
    const url = parseUrl(env.APP_BASE_URL);
    if (!url || !origin(env.APP_BASE_URL) || url.pathname !== "/" || url.search || url.hash) {
      fail("APP_BASE_URL must be an origin such as http://127.0.0.1:3001");
    } else if (url.hostname === "localhost") {
      fail("APP_BASE_URL uses localhost",
        "Use http://127.0.0.1:3001 and always open that address: sign-in cookies belong to one host name.");
    } else pass(`APP_BASE_URL is ${url.origin}`);
  }
  if (env.AUTH0_DOMAIN && !/^[a-z0-9.-]+$/i.test(env.AUTH0_DOMAIN)) {
    fail("AUTH0_DOMAIN must be a host name only, without https:// or a path");
  }
  if (env.AUTH0_SECRET) {
    if (/^[0-9a-f]{64}$/i.test(env.AUTH0_SECRET)) pass("AUTH0_SECRET is 64 hexadecimal characters");
    else fail("AUTH0_SECRET must be 64 hexadecimal characters", "Generate one with: openssl rand -hex 32");
  }
  if (env.AUTH0_ISSUER && env.AUTH0_DOMAIN) {
    const expected = `https://${env.AUTH0_DOMAIN}/`;
    if (env.AUTH0_ISSUER === expected) pass(`AUTH0_ISSUER is ${expected}`);
    else fail(`AUTH0_ISSUER must be exactly ${expected}`, "Include https:// and the trailing slash.");
  }
  if (env.AUTH0_ORG_ID) {
    if (env.AUTH0_ORG_ID.startsWith("org_")) pass(`AUTH0_ORG_ID is ${env.AUTH0_ORG_ID}`);
    else fail("AUTH0_ORG_ID must be the organization's ID (it starts with org_), not its name");
  }
  if (env.BRAIN_API_URL && !origin(env.BRAIN_API_URL)) fail("BRAIN_API_URL must be a URL such as http://127.0.0.1:3000");
  if (env.SUPABASE_URL) {
    const url = parseUrl(env.SUPABASE_URL);
    if (url?.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash) pass(`SUPABASE_URL is ${url.origin}`);
    else fail("SUPABASE_URL must be the project's HTTPS origin, for example https://abcd.supabase.co");
  }
  if (env.AUDIT_SIGNING_KEY_FILE) {
    try {
      const type = createPrivateKey(deps.readFile(env.AUDIT_SIGNING_KEY_FILE)).asymmetricKeyType;
      if (type === "ed25519") pass("AUDIT_SIGNING_KEY_FILE holds an Ed25519 private key");
      else fail(`AUDIT_SIGNING_KEY_FILE holds a ${type} key, not Ed25519`, GENERATE_KEY);
    } catch (error) {
      fail(`AUDIT_SIGNING_KEY_FILE cannot be read as a private key (${reason(error)})`,
        `The path is relative to the repository root. ${GENERATE_KEY}`);
    }
  }
  return checks;
}

async function auth0Checks(env: Env, deps: DoctorDeps): Promise<Check[]> {
  const { checks, pass, fail, skip } = report("Auth0 tenant");
  const base = origin(env.APP_BASE_URL);
  const clientId = env.AUTH0_CLIENT_ID;
  if (!env.AUTH0_DOMAIN || !clientId || !base) {
    skip("Needs AUTH0_DOMAIN, AUTH0_CLIENT_ID and APP_BASE_URL");
    return checks;
  }
  const tenant = `https://${env.AUTH0_DOMAIN}`;
  const callback = `${base}/auth/callback`;

  let issuer: unknown;
  try {
    const response = await deps.fetch(`${tenant}/.well-known/openid-configuration`, { signal: timeout() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    issuer = ((await response.json()) as { issuer?: unknown }).issuer;
  } catch (error) {
    fail(`Cannot reach the tenant at ${tenant} (${reason(error)})`,
      "Check AUTH0_DOMAIN and your network. This is also why /auth/login would return 500.");
    return checks;
  }
  pass(`The tenant ${env.AUTH0_DOMAIN} is reachable`);
  if (env.AUTH0_ISSUER && issuer !== env.AUTH0_ISSUER) {
    fail(`The tenant's issuer is ${String(issuer)}, but AUTH0_ISSUER is ${env.AUTH0_ISSUER}`,
      "Set AUTH0_ISSUER to the tenant's issuer exactly.");
  }

  try {
    const jwks = await (await deps.fetch(`${tenant}/.well-known/jwks.json`, { signal: timeout() })).json() as
      { keys?: Array<{ kty?: unknown }> };
    if ((jwks.keys ?? []).some(key => key.kty === "RSA")) pass("The tenant publishes RSA signing keys for access tokens");
    else fail("The tenant publishes no RSA signing keys", "The API accepts RS256 access tokens only.");
  } catch (error) {
    fail(`Cannot read the tenant's signing keys (${reason(error)})`);
  }

  // A made-up code is refused either way. Auth0 checks the client credentials first, so "invalid_grant" means the ID
  // and secret were accepted. This leaves one failed-exchange entry in the tenant's logs and issues no token.
  if (env.AUTH0_CLIENT_SECRET) {
    try {
      const response = await deps.fetch(`${tenant}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId,
          client_secret: env.AUTH0_CLIENT_SECRET, code: "sso-doctor-check", redirect_uri: callback }),
        signal: timeout()
      });
      const result = await response.json().catch(() => ({})) as { error?: unknown; error_description?: unknown };
      if (result.error === "invalid_grant") pass("Auth0 accepts AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET");
      else {
        const detail = [result.error, result.error_description].filter(part => typeof part === "string").join(": ");
        fail(`Auth0 did not accept the client credentials (${detail || `HTTP ${response.status}`})`,
          "Copy the client ID and secret from the application's settings. It must be a Regular Web Application " +
          "using Client Secret Post (AUTH0.md section 2).");
      }
    } catch (error) {
      fail(`Cannot check the client credentials (${reason(error)})`);
    }
  }

  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: callback,
    scope: "openid profile email offline_access", state: "sso-doctor-check" });
  if (env.AUTH0_AUDIENCE) params.set("audience", env.AUTH0_AUDIENCE);
  if (env.AUTH0_ORG_ID) params.set("organization", env.AUTH0_ORG_ID);
  try {
    const response = await deps.fetch(`${tenant}/authorize?${params}`, { redirect: "manual", signal: timeout() });
    const location = response.headers.get("location");
    const target = location ? new URL(location, tenant) : undefined;
    const error = target?.searchParams.get("error");
    if (target && target.origin === new URL(tenant).origin && !error) {
      pass("Auth0 accepts the sign-in request (client, callback URL, audience and organization)");
    } else {
      const detail = error ? [error, target?.searchParams.get("error_description")].filter(Boolean).join(": ") :
        target ? `it redirected to ${target.origin}${target.pathname}` : await pageText(response);
      fail(`Auth0 rejects the sign-in request: ${detail}`, auth0Fix(detail, callback));
    }
  } catch (error) {
    fail(`Cannot check the sign-in request (${reason(error)})`);
  }

  // The SDK sends APP_BASE_URL, exactly as written, as the logout return address.
  const returnTo = env.APP_BASE_URL!.trim();
  try {
    const response = await deps.fetch(`${tenant}/v2/logout?${new URLSearchParams({ client_id: clientId, returnTo })}`,
      { redirect: "manual", signal: timeout() });
    const location = response.headers.get("location");
    if (location?.startsWith(returnTo)) pass(`Logout returns to ${returnTo}`);
    else {
      fail(`Auth0 will not return to ${returnTo} after logout: ${location ? `it redirected to ${location}` : await pageText(response)}`,
        `Add ${returnTo} exactly as written to Allowed Logout URLs (AUTH0.md section 2).`);
    }
  } catch (error) {
    fail(`Cannot check the logout address (${reason(error)})`);
  }
  return checks;
}

async function supabaseChecks(env: Env, deps: DoctorDeps): Promise<Check[]> {
  const { checks, pass, fail, skip } = report("Supabase");
  const key = env.SUPABASE_SECRET_KEY;
  const orgId = env.AUTH0_ORG_ID;
  if (!env.SUPABASE_URL || !key || !orgId) {
    skip("Needs SUPABASE_URL, SUPABASE_SECRET_KEY and AUTH0_ORG_ID");
    return checks;
  }
  let directory: UserDirectory;
  try {
    directory = new UserDirectory({ url: env.SUPABASE_URL, secretKey: key, fetch: deps.fetch }, orgId);
  } catch (error) {
    fail(reason(error), "Use the project's origin, for example https://abcd.supabase.co, with no path.");
    return checks;
  }

  const project = new URL(env.SUPABASE_URL).origin;
  const missing: string[] = [];
  for (const [table, migration] of TABLES) {
    let status: number;
    try {
      status = (await deps.fetch(`${project}/rest/v1/${table}?select=*&limit=0`,
        { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: timeout() })).status;
    } catch (error) {
      fail(`Cannot reach Supabase at ${project} (${reason(error)})`);
      return checks;
    }
    if (status === 401 || status === 403) {
      fail("Supabase rejected SUPABASE_SECRET_KEY", "Use the project's secret key, not the publishable key.");
      return checks;
    }
    if (status === 404) missing.push(`${table} (migration ${migration})`);
    else if (status >= 400) missing.push(`${table} (HTTP ${status})`);
  }
  if (missing.length) {
    fail(`Missing tables: ${missing.join(", ")}`, "Apply migrations 001 to 005 in order (AUTH0.md section 3).");
  } else pass("The expected tables exist (migrations 001, 002 and 004)");

  let users: User[];
  try {
    users = await directory.list();
  } catch (error) {
    fail(`Cannot read the workspace directory (${reason(error)})`, /\(400\)/.test(reason(error))
      ? "Apply migration 003, which adds the Auth0 columns to workspace_users."
      : "Check that migrations 002 and 003 are applied and the rows are complete.");
    return checks;
  }
  if (!users.length) {
    fail(`The directory has no users for organization ${orgId}`,
      "Run the seed script with this AUTH0_ORG_ID (AUTH0.md section 3).");
    return checks;
  }
  pass(`The directory has ${users.length} users for organization ${orgId}`);
  const problems: string[] = [];
  for (const fixture of loadMockCorpus().users) {
    const user = users.find(item => item.id === fixture.id);
    if (!user) problems.push(`${fixture.id} is missing`);
    else if (user.active !== true) problems.push(`${fixture.id} is inactive`);
    else if (user.auth0Sub === fixture.auth0Sub) problems.push(`${fixture.id} still has the placeholder subject ${fixture.auth0Sub}`);
  }
  if (problems.length) {
    fail(`Demo users not ready: ${problems.join("; ")}`,
      "Run the seed script (AUTH0.md section 3). It creates the Auth0 users, adds them to the organization and " +
      "stores their real Auth0 IDs.");
  } else pass("All six demo users are present, active and have real Auth0 subjects");
  return checks;
}

async function serviceChecks(env: Env, deps: DoctorDeps): Promise<Check[]> {
  const { checks, pass, fail, skip } = report("Running services");
  const api = origin(env.BRAIN_API_URL);
  if (api) {
    try {
      const health = await deps.fetch(`${api}/health`, { signal: timeout() });
      if (!health.ok) throw new Error(`HTTP ${health.status}`);
      // In demo mode the API accepts this header; in Auth0 mode it rejects it like any other caller.
      const me = await deps.fetch(`${api}/v1/me`, { headers: { "x-demo-user": "ravi" }, signal: timeout() });
      if (me.status === 401) pass(`The API at ${api} is running in Auth0 mode`);
      else if (me.ok) {
        fail(`The API at ${api} is running in demo mode, so it rejects every signed-in request`,
          "Stop it and start it with pnpm dev:sso (AUTH0.md section 4).");
      } else fail(`The API at ${api} answered an identity check with HTTP ${me.status}`);
    } catch (error) {
      skip(`The API is not reachable at ${api} (${reason(error)}). Start it with pnpm dev:sso and run this check again.`);
    }
  }
  const web = origin(env.APP_BASE_URL);
  if (web) {
    try {
      const response = await deps.fetch(`${web}/`, { redirect: "manual", signal: timeout() });
      const text = await response.text();
      if (/SSO setup is incomplete/i.test(text)) {
        fail("The web host is running without its Auth0 settings",
          "Restart pnpm --dir apps/web dev after filling in .env.local at the repository root.");
      } else if (response.ok) pass(`The web host at ${web} is running with SSO configured`);
      else fail(`The web host at ${web} answered HTTP ${response.status}`);
    } catch (error) {
      skip(`The web host is not reachable at ${web} (${reason(error)}). Start it with pnpm --dir apps/web dev.`);
    }
  }
  return checks;
}

export async function runDoctor(env: Env, deps: DoctorDeps): Promise<Check[]> {
  return [...settingsChecks(env, deps), ...await auth0Checks(env, deps), ...await supabaseChecks(env, deps),
    ...await serviceChecks(env, deps)];
}

const LABEL: Record<Check["status"], string> = { pass: "[ok]  ", fail: "[FAIL]", skip: "[skip]" };

export function formatReport(checks: Check[], appBaseUrl = "http://127.0.0.1:3001"): string {
  const lines = ["SSO setup check: reads .env.local, changes nothing, prints no secrets.", ""];
  for (const section of [...new Set(checks.map(check => check.section))]) {
    lines.push(section);
    for (const check of checks.filter(item => item.section === section)) {
      lines.push(`  ${LABEL[check.status]} ${check.message}`);
      if (check.fix) lines.push(`         Fix: ${check.fix}`);
    }
    lines.push("");
  }
  const failures = checks.filter(check => check.status === "fail").length;
  lines.push(failures
    ? `${failures} problem${failures === 1 ? "" : "s"} found. Fix them in order, then run pnpm doctor:sso again.`
    : `No problems found. Next, sign in at ${appBaseUrl} as a seeded user and open /api/brain/v1/me (AUTH0.md section 5).`);
  return lines.join("\n");
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isMainModule()) {
  const checks = await runDoctor(process.env, { fetch, readFile: path => readFileSync(path) });
  console.log(formatReport(checks, origin(process.env.APP_BASE_URL)));
  process.exitCode = checks.some(check => check.status === "fail") ? 1 : 0;
}
