import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServer } from "./server.js";

/**
 * The whole API with several companies, against a pretend Supabase (it filters rows exactly as the requests ask, so a
 * query that forgot to name its company would leak here) and a pretend Auth0.
 */
const issuer = "https://tenant.example.auth0.com/";
const audience = "https://brain.example/api";
const supabase = "https://project.supabase.co";
const HOME = "org_home1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" };
function token(sub: string, orgId: string): string {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub, org_id: orgId, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

type Row = Record<string, any>;
let snapshotWrites = 0;
const tables: Record<string, Row[]> = { workspace_users: [], organizations: [], brain_state: [], audit_entries: [], merkle_batches: [] };
const auth0Orgs: Array<{ id: string; name: string; display_name: string }> = [];
const invitations: Array<{ org: string; email: string }> = [];
const emails: Record<string, { email: string; verified: boolean }> = {};
let orgCounter = 0;
let failInvites = false;

const json = (data: unknown, status = 200) => new Response(data === undefined ? "" : JSON.stringify(data), { status });
function filterRows(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows;
  for (const [key, value] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const [op, ...rest] = value.split(".");
    const wanted = rest.join(".");
    out = out.filter(row => {
      const actual = key.includes("->>") ? row[key.split("->>")[0]]?.[key.split("->>")[1]] : row[key];
      if (op === "eq") return String(actual) === wanted;
      if (op === "ilike") return String(actual).toLowerCase() === wanted.replace(/\\(.)/g, "$1").toLowerCase();
      if (op === "not" && wanted === "is.null") return actual !== null && actual !== undefined;
      if (op === "is" && wanted === "null") return actual === null || actual === undefined;
      return true;
    });
  }
  const limit = params.get("limit"); const offset = Number(params.get("offset") ?? 0);
  return out.slice(offset, limit ? offset + Number(limit) : undefined);
}

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  if (url.href === `${issuer}.well-known/jwks.json`) return json({ keys: [jwk] });
  if (url.href === `${issuer}userinfo`) {
    const bearer = String((init.headers as Record<string, string>).authorization).slice(7);
    const sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).sub;
    const info = emails[sub];
    return info ? json({ email: info.email, email_verified: info.verified }) : json({}, 401);
  }
  if (url.href === `${issuer}oauth/token`) return json({ access_token: "management", expires_in: 3600 });
  if (url.origin + "/" === issuer && url.pathname.startsWith("/api/v2/organizations")) {
    const path = url.pathname.replace("/api/v2/organizations", "");
    if (method === "POST" && path === "") {
      if (auth0Orgs.some(item => item.name === body.name)) return json({ message: "exists" }, 409);
      const created = { id: `org_new${++orgCounter}`, name: body.name, display_name: body.display_name };
      auth0Orgs.push(created); return json(created, 201);
    }
    if (method === "GET" && path.startsWith("/name/")) {
      const found = auth0Orgs.find(item => item.name === decodeURIComponent(path.slice(6)));
      return found ? json(found) : json({ message: "none" }, 404);
    }
    if (method === "GET" && /^\/org_\w+$/.test(path)) {
      const found = auth0Orgs.find(item => item.id === path.slice(1));
      return found ? json(found) : json({ message: "none" }, 404);
    }
    if (method === "DELETE") { const at = auth0Orgs.findIndex(item => item.id === path.slice(1)); if (at >= 0) auth0Orgs.splice(at, 1); return json(undefined, 204); }
    const invite = /^\/([^/]+)\/invitations$/.exec(path);
    if (invite && method === "GET") return json(invitations.filter(item => item.org === invite[1]).map((item, index) => ({ id: `inv${index}`, invitee: { email: item.email } })));
    if (invite && method === "POST" && failInvites) return json({ message: "boom" }, 500);
    if (invite && method === "POST") { invitations.push({ org: invite[1], email: body.invitee.email }); return json({ id: "inv" }, 201); }
    return json({}, 404);
  }
  if (url.origin === supabase) {
    const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname);
    if (rpc) {
      if (rpc[1] === "save_brain_state") {
        snapshotWrites += 1;
        const rows = tables.brain_state; const at = rows.findIndex(row => row.org_id === body.organization);
        const row = { org_id: body.organization, snapshot: body.snapshot }; if (at >= 0) rows[at] = row; else rows.push(row);
      }
      return json(null);
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table || !(table in tables)) return json([]);
    if (method === "GET") return json(filterRows(tables[table], url.searchParams));
    if (method === "POST") {
      if (table === "workspace_users" && tables[table].some(row => row.org_id === body.org_id && (row.user_id === body.user_id || row.email === body.email))) return json({}, 409);
      const row = { auth0_sub: null, ...body }; tables[table].push(row); return json([row], 201);
    }
    if (method === "PATCH") {
      const matched = filterRows(tables[table], url.searchParams); for (const row of matched) Object.assign(row, body); return json(matched);
    }
    if (method === "DELETE") {
      const doomed = new Set(filterRows(tables[table], url.searchParams)); tables[table] = tables[table].filter(row => !doomed.has(row)); return json(undefined, 204);
    }
  }
  return json({}, 404);
}

let api: ApiServer; let base: string;
const saved: Record<string, string | undefined> = {};
const settings: Record<string, string> = {
  AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience, AUTH0_ORG_ID: HOME, SUPABASE_URL: supabase, SUPABASE_SECRET_KEY: "service-key",
  AUDIT_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  AUTH0_MANAGEMENT_CLIENT_ID: "m2m", AUTH0_MANAGEMENT_CLIENT_SECRET: "m2m-secret", AUTH0_CLIENT_ID: "web-app",
  AUTH0_SIGNUP_CONNECTION_ID: "con_db", SELF_SIGNUP: "on", API_ORIGIN: "https://api.example.test", WEB_ORIGIN: "https://app.example.test",
  SOURCE_OAUTH_JSON: JSON.stringify({ jira: { clientId: "c", clientSecret: "s", scopes: ["read:jira-work"] } })
};

async function call(method: string, path: string, who?: { sub: string; org: string }, data?: unknown) {
  const response = await fetch(`${base}${path}`, { method, redirect: "manual",
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who.sub, who.org)}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, location: response.headers.get("location") };
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(settings)) { saved[name] = process.env[name]; process.env[name] = value; }
  tables.workspace_users.push({ org_id: HOME, user_id: "ravi", name: "Ravi", email: "ravi@home.test", auth0_sub: "auth0|ravi", role: "admin", active: true,
    groups: [], contractor: false, platform_identities: { slack: "ravi@home.test" } });
  emails["auth0|ravi"] = { email: "ravi@home.test", verified: true };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return href.startsWith(base ?? "http://127.0.0.1:0/") ? real(input, init) : fakeFetch(input, init);
  });
  api = await createApiServer({ startOrchestrator: false });
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => api.server.close(resolve));
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

const home = { sub: "auth0|ravi", org: HOME };

describe("several companies in one API", () => {
  it("lets the home company keep working as before", async () => {
    const me = await call("GET", "/v1/me", home);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: "ravi", role: "admin" });
  });

  it("does not rewrite the whole workspace snapshot to the database after a question", async () => {
    const before = snapshotWrites;
    const asked = await call("POST", "/v1/query", { sub: "auth0|ravi", org: HOME }, { question: "What is the status of the launch?" });
    expect(asked.status).toBe(200);
    expect(snapshotWrites).toBe(before);
  });

  it("turns away an organization that has not signed up, even with a valid sign-in", async () => {
    emails["auth0|stranger"] = { email: "stranger@other.test", verified: true };
    expect((await call("GET", "/v1/me", { sub: "auth0|stranger", org: "org_unknown" })).status).toBe(401);
  });

  it("creates a company, its organization and an invited first admin from the sign-up form", async () => {
    const result = await call("POST", "/v1/signup", undefined, { company: "Acme & Sons", name: "Dana Lee", email: "Dana@Acme.test" });
    expect(result.status).toBe(202);
    expect(auth0Orgs).toEqual([{ id: "org_new1", name: expect.stringMatching(/^acme-and-sons-[a-z2-9]{6}$/), display_name: "Acme & Sons" }]);
    expect(invitations).toEqual([{ org: "org_new1", email: "dana@acme.test" }]);
    expect(tables.organizations).toEqual([expect.objectContaining({ org_id: "org_new1", name: "Acme & Sons", status: "active", created_by_email: "dana@acme.test" })]);
    expect(tables.workspace_users.filter(row => row.org_id === "org_new1")).toEqual([expect.objectContaining({ user_id: "dana", role: "admin", auth0_sub: null })]);
  });

  it("answers the same and creates nothing for an email that has already signed in to a company", async () => {
    const before = [auth0Orgs.length, invitations.length];
    emails["auth0|dana"] = { email: "dana@acme.test", verified: true };
    await call("GET", "/v1/me", { sub: "auth0|dana", org: "org_new1" });
    const again = await call("POST", "/v1/signup", undefined, { company: "Another Co", name: "Dana", email: "Dana@Acme.test" });
    const homeEmail = await call("POST", "/v1/signup", undefined, { company: "Third Co", name: "Ravi", email: "ravi@home.test" });
    expect([again.status, homeEmail.status]).toEqual([202, 202]);
    expect([auth0Orgs.length, invitations.length]).toEqual(before);
  });

  it("makes the invited email the admin only at a verified sign-in, and only in its own company", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    // Someone who registered with Dana's email but never proved they own it gets nothing.
    emails["auth0|mallory"] = { email: "dana@acme.test", verified: false };
    expect((await call("GET", "/v1/me", { sub: "auth0|mallory", org: "org_new1" })).body).toMatchObject({ code: "email_unverified" });
    emails["auth0|dana"] = { email: "dana@acme.test", verified: true };
    const me = await call("GET", "/v1/me", dana);
    expect(me).toMatchObject({ status: 200, body: { id: "dana", role: "admin" } });
    // The same person's token for the home organization is not a member there.
    expect((await call("GET", "/v1/me", { sub: "auth0|dana", org: HOME })).status).toBe(403);
  });

  it("keeps each company's people apart", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    const added = await call("POST", "/v1/admin/people", dana, { email: "lee@acme.test", name: "Lee" });
    expect(added.status).toBe(201);
    const acme = await call("GET", "/v1/admin/people", dana);
    expect(acme.body.people.map((person: Row) => person.email).sort()).toEqual(["dana@acme.test", "lee@acme.test"]);
    const homePeople = await call("GET", "/v1/admin/people", home);
    expect(homePeople.body.people.map((person: Row) => person.email)).toEqual(["ravi@home.test"]);
    expect(invitations.at(-1)).toEqual({ org: "org_new1", email: "lee@acme.test" });
    // Neither company's admin can act on the other's people.
    expect((await call("DELETE", "/v1/admin/people/ravi", dana)).status).toBe(404);
    expect((await call("DELETE", "/v1/admin/people/lee", home)).status).toBe(404);
  });

  it("gives each company its own workspace and audit trail", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    const acme = await call("GET", "/v1/workspace", dana);
    expect(acme.status).toBe(200);
    expect(JSON.stringify(acme.body)).not.toMatch(/ravi|home\.test/);
    const audit = await call("GET", "/v1/admin/connections", dana);
    expect(audit.status).toBe(200);
    expect(audit.body.connections.every((connection: Row) => connection.status === "Not connected")).toBe(true);
  });

  it("returns an approval for another company's state to the page with a failure, never to that company", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    const begun = await call("POST", "/v1/admin/connections/jira/authorize", dana, { via: "setup" });
    expect(begun.status).toBe(200);
    const state = new URL(begun.body.url).searchParams.get("state")!;
    expect(state).toMatch(/~org_new1\.setup$/);
    // The same stored state presented as the home company's, or as an unknown company's, finds nothing.
    const bare = state.replace("~org_new1", "");
    for (const forged of [bare, state.replace("org_new1", "org_other")]) {
      const back = await call("GET", `/v1/admin/connections/jira/callback?code=x&state=${encodeURIComponent(forged)}`);
      expect(back.status).toBe(302);
      expect(back.location).toContain("connect_failed=jira");
    }
  });

  it("serves the company address lookup for sign-in", async () => {
    const address = auth0Orgs[0].name;
    expect((await call("GET", `/v1/companies/find?name=${address.toUpperCase()}`)).body).toEqual({ organization: "org_new1", name: "Acme & Sons" });
    // The name alone is not an address.
    expect((await call("GET", "/v1/companies/find?name=Acme%20%26%20Sons")).status).toBe(404);
    expect((await call("GET", "/v1/companies/find?name=nobody")).status).toBe(404);
    // An organization that exists in Auth0 but never signed up here is not offered.
    auth0Orgs.push({ id: "org_other9", name: "unrelated", display_name: "Unrelated" });
    expect((await call("GET", "/v1/companies/find?name=unrelated")).status).toBe(404);
  });

  it("shows a company's admin its sign-in address, and only its admin", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    expect((await call("GET", "/v1/admin/company", dana)).body).toEqual({ address: auth0Orgs[0].name, name: "Acme & Sons" });
    // Someone the admin never added gets nothing, whatever organization their sign-in names.
    emails["auth0|outsider"] = { email: "outsider@acme.test", verified: true };
    expect((await call("GET", "/v1/admin/company", { sub: "auth0|outsider", org: "org_new1" })).status).toBe(403);
  });

  it("lets a second company take the same name, at its own address, without touching the first", async () => {
    const second = await call("POST", "/v1/signup", undefined, { company: "Acme & Sons", name: "Eve", email: "eve@elsewhere.test" });
    expect(second.status).toBe(202);
    const both = auth0Orgs.filter(item => item.display_name === "Acme & Sons");
    expect(both).toHaveLength(2);
    expect(both[0].name).not.toBe(both[1].name);
    const eve = tables.organizations.find(row => row.created_by_email === "eve@elsewhere.test")!;
    expect(eve.org_id).not.toBe("org_new1");
    expect(tables.workspace_users.filter(row => row.org_id === "org_new1").map(row => row.email)).not.toContain("eve@elsewhere.test");
  });

  it("does not let a stranger use someone's email to stop them signing their own company up", async () => {
    // Lee was only invited to Acme and has never signed in, so Lee's own sign-up goes ahead.
    const result = await call("POST", "/v1/signup", undefined, { company: "Lee Studio", name: "Lee", email: "lee@acme.test" });
    expect(result.status).toBe(202);
    expect(auth0Orgs.some(item => item.display_name === "Lee Studio")).toBe(true);
  });

  it("leaves no company behind when the invitation cannot be sent, and lets the person try again", async () => {
    const before = [auth0Orgs.length, tables.organizations.length];
    failInvites = true;
    const failed = await call("POST", "/v1/signup", undefined, { company: "Flaky Co", name: "Fay", email: "fay@flaky.test" });
    failInvites = false;
    expect(failed.status).toBe(502);
    expect([auth0Orgs.length, tables.organizations.length]).toEqual(before);
    expect(tables.workspace_users.some(row => row.email === "fay@flaky.test")).toBe(false);
    expect((await call("POST", "/v1/signup", undefined, { company: "Flaky Co", name: "Fay", email: "fay@flaky.test" })).status).toBe(202);
    expect(auth0Orgs.some(item => item.display_name === "Flaky Co")).toBe(true);
  });

  it("keeps a company's own AI model to the providers' fixed addresses", async () => {
    const dana = { sub: "auth0|dana", org: "org_new1" };
    const custom = await call("PUT", "/v1/admin/model", dana, { provider: "openai_compatible", model: "m", apiKey: "k", baseUrl: "https://models.example.com/v1" });
    expect([custom.status, custom.body.error]).toEqual([400, expect.stringContaining("custom model address")]);
    const anthropicWithAddress = await call("PUT", "/v1/admin/model", dana, { provider: "anthropic", model: "m", apiKey: "k", baseUrl: "https://models.example.com/v1" });
    expect(anthropicWithAddress.status).toBe(400);
  });
});
