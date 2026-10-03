import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import handler, { createApiServer, startupMessage } from "./server.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start() {
  process.env.ALLOW_DEMO_AUTH = "true";
  const api = await createApiServer({ startOrchestrator: false });
  openServers.push(api.server);
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, user: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "x-demo-user": user, "content-type": "application/json", ...init.headers }
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...api, request };
}

describe("API authorization and trace", () => {
  it("requires an explicit demo-auth switch when Auth0 is absent", async () => {
    const previous = process.env.ALLOW_DEMO_AUTH;
    delete process.env.ALLOW_DEMO_AUTH;
    try {
      await expect(createApiServer({ startOrchestrator: false })).rejects.toThrow("Auth0 configuration required");
    } finally {
      if (previous === undefined) delete process.env.ALLOW_DEMO_AUTH;
      else process.env.ALLOW_DEMO_AUTH = previous;
    }
  });

  it("returns 401 for an invalid bearer token even when a demo identity header is present", async () => {
    const { request } = await start();
    const result = await request("/v1/me", "maya", { headers: { authorization: "Bearer malformed" } });
    expect(result).toEqual({ status: 401, body: { error: "Unauthorized" } });
  });

  it("returns only live authorized workspace content", async () => {
    const { request } = await start();
    const alex = await request("/v1/workspace", "alex");
    const ravi = await request("/v1/workspace", "ravi");
    expect(alex.status).toBe(200);
    expect(alex.body.documents.map((doc: { docId: string }) => doc.docId)).toEqual(["drive:steering-deck", "drive:chargeback-guide"]);
    expect(JSON.stringify(alex.body)).not.toContain("fraud-ops-private");
    const cutover = await request("/v1/query", "alex", {
      method: "POST", body: JSON.stringify({ question: "Summarize cutover decisions for a new intern." })
    });
    expect(cutover.body.citations.map((item: { docId: string }) => item.docId)).toEqual(["drive:steering-deck"]);
    const catchUp = await request("/v1/query", "alex", {
      method: "POST", body: JSON.stringify({ question: "Summarize cutover decisions and the chargeback workflow for a new intern." })
    });
    expect(catchUp.body.citations.map((item: { docId: string }) => item.docId).sort())
      .toEqual(["drive:chargeback-guide", "drive:steering-deck"]);
    expect(ravi.body.documents.some((doc: { docId: string }) => doc.docId === "jira:PAY-101")).toBe(true);
    expect(ravi.body.documents.find((doc: { docId: string }) => doc.docId === "jira:PAY-101").content)
      .toContain("PAY-101");
  });

  it("keeps a query trace private to its actor and compliance", async () => {
    const { request } = await start();
    const query = await request("/v1/query", "ravi", {
      method: "POST",
      body: JSON.stringify({ question: "PAY-101 cutover" })
    });
    expect(query.status).toBe(200);
    expect(query.body.traceId).toMatch(/^[a-f0-9-]{36}$/);
    const path = `/v1/trace?traceId=${query.body.traceId}`;
    expect((await request(path, "alex")).status).toBe(404);
    const trace = await request(path, "ravi");
    expect(trace.body.entries.map((entry: { type: string }) => entry.type)).toContain("context_sent");
    expect((await request(path, "nur")).status).toBe(200);
  });

  it("shows the same actor trace for absent and denied no-result queries", async () => {
    const { request } = await start();
    const denied = await request("/v1/query", "alex", {
      method: "POST", body: JSON.stringify({ question: "fraud-ops-private" })
    });
    const absent = await request("/v1/query", "alex", {
      method: "POST", body: JSON.stringify({ question: "absent-xyzzyp" })
    });
    expect(denied.body.text).toBe(absent.body.text);
    const deniedTrace = await request(`/v1/trace?traceId=${denied.body.traceId}`, "alex");
    const absentTrace = await request(`/v1/trace?traceId=${absent.body.traceId}`, "alex");
    const shape = (entries: Array<{ sequence: number; type: string; data: unknown }>) =>
      entries.map(({ sequence, type, data }) => ({ sequence, type, data }));
    expect(shape(deniedTrace.body.entries)).toEqual(shape(absentTrace.body.entries));
    expect(JSON.stringify(deniedTrace.body)).not.toContain("docRef");
    expect((await request(`/v1/trace?traceId=${denied.body.traceId}`, "nur")).body.entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "access_decision" })]));
  });

  it("records refused requests and audit searches in the audit log", async () => {
    const { request, brain } = await start();
    expect((await request("/v1/audit", "ravi")).status).toBe(403);
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({
      type: "request_denied", actor: "ravi", data: { method: "GET", path: "/v1/audit" } }));
    const search = await request("/v1/audit/search?q=" + encodeURIComponent("what did ravi do"), "nur");
    expect(search.status).toBe(200);
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "audit_searched", actor: "nur" }));
  });

  it("restricts audit verification to compliance", async () => {
    const { request } = await start();
    expect((await request("/v1/audit", "ravi")).status).toBe(403);
    const seal = await request("/v1/audit/seal", "nur", { method: "POST", body: "{}" });
    expect(seal.body.batch.root).toMatch(/^[a-f0-9]{64}$/);
    const verify = await request("/v1/audit/verify", "nur", {
      method: "POST",
      body: JSON.stringify({ sequence: 1 })
    });
    expect(verify.body.verified).toBe(true);
    expect((await request("/v1/audit/verify", "ravi", {
      method: "POST",
      body: JSON.stringify({ sequence: 1 })
    })).status).toBe(403);
  });

  it("exposes only an admin-visible source permission for native editing", async () => {
    const { request } = await start();
    expect((await request("/v1/me", "maya")).body).toEqual({
      id: "maya", name: "Maya", role: "admin", groups: ["payments"]
    });
    expect((await request("/v1/admin/permissions?docId=jira:PAY-101", "alex")).status).toBe(403);
    expect((await request("/v1/admin/permissions?docId=slack:fraud-private", "maya")).status).toBe(404);
    const current = await request("/v1/admin/permissions?docId=jira:PAY-101", "maya");
    expect(current.status).toBe(200);
    expect(current.body.permissions.native.source).toBe("jira");
    const narrowed = structuredClone(current.body.permissions);
    narrowed.native.issueViewers = narrowed.native.issueViewers.filter((email: string) => email !== "ravi@aspire.example");
    expect((await request("/v1/admin/permissions", "maya", {
      method: "POST", body: JSON.stringify({ docId: "jira:PAY-101", permissions: narrowed })
    })).status).toBe(200);
    expect((await request("/v1/workspace", "ravi")).body.documents.some(
      (doc: { docId: string }) => doc.docId === "jira:PAY-101"
    )).toBe(false);
    narrowed.native.issueViewers.push("outsider@aspire.example");
    expect((await request("/v1/admin/permissions", "maya", {
      method: "POST", body: JSON.stringify({ docId: "jira:PAY-101", permissions: narrowed })
    })).status).toBe(400);
  });

  it("searches denied access events in natural language", async () => {
    const { request } = await start();
    await request("/v1/query", "alex", {
      method: "POST",
      body: JSON.stringify({ question: "SEC-44 failover" })
    });
    const result = await request("/v1/audit/search?q=show%20denied%20access", "nur");
    expect(result.status).toBe(200);
    expect(result.body.entries.length).toBeGreaterThan(0);
    expect(result.body.entries.every((entry: { data: { allowed: boolean } }) => entry.data.allowed === false)).toBe(true);
    expect((await request("/v1/audit/search?q=denied", "alex")).status).toBe(403);
  });

  it("applies a channel removal to the next query and explains new-hire access", async () => {
    const { request } = await start();
    const before = await request("/v1/query", "ravi", {
      method: "POST", body: JSON.stringify({ question: "Private fraud review" })
    });
    expect(before.body.citations.some((item: { docId: string }) => item.docId === "slack:fraud-private")).toBe(true);
    expect((await request("/v1/admin/channel-member", "maya", {
      method: "POST", body: JSON.stringify({ docId: "slack:fraud-private", userId: "ravi" })
    })).status).toBe(200);
    const after = await request("/v1/query", "ravi", {
      method: "POST", body: JSON.stringify({ question: "Private fraud review" })
    });
    expect(after.body.citations).toEqual([]);
    expect(after.body.text).toBe("No accessible information was found for this query.");
    const preview = await request("/v1/admin/preview?user=alex", "maya");
    expect(preview.status).toBe(200);
    expect(preview.body.documents.map((doc: { docId: string }) => doc.docId)).toEqual(["drive:steering-deck", "drive:chargeback-guide"]);
    expect(preview.body.reasons["drive:steering-deck"]).toContain("Group: interns");
  });
});

it("restricts connector settings and starts a background Company A import", async () => {
  const { request, brain } = await start();
  expect((await request("/v1/admin/connections", "ravi")).status).toBe(403);
  expect((await request("/v1/admin/onboard", "maya", { method: "POST" })).status).toBe(202);
  await brain.syncAll();
  const progress = await request("/v1/admin/import-jobs", "maya");
  expect(progress.body.jobs).toHaveLength(4);
  expect(progress.body.jobs.every((job: { status: string }) => job.status === "complete")).toBe(true);
  expect((await request("/v1/admin/connections/drive", "maya", { method: "DELETE" })).status).toBe(200);
  expect((await request("/v1/workspace", "alex")).body.documents).toEqual([]);
});

describe("Public demo mode", () => {
  const keys = ["NODE_ENV", "PUBLIC_DEMO", "ALLOW_DEMO_AUTH", "AUTH0_ISSUER", "SUPABASE_URL"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => { saved = Object.fromEntries(keys.map(key => [key, process.env[key]])); });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("accepts demo personas in a production build only as a mock-only public demo", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_DEMO_AUTH;
    await expect(createApiServer({ startOrchestrator: false })).rejects.toThrow("Auth0 configuration required");
    process.env.PUBLIC_DEMO = "true";
    const api = await createApiServer({ startOrchestrator: false });
    openServers.push(api.server);
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    const address = api.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/me`, { headers: { "x-demo-user": "maya" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "maya", role: "admin" });
  });

  it("refuses to run a public demo next to real identity or data settings", async () => {
    process.env.PUBLIC_DEMO = "true";
    process.env.AUTH0_ISSUER = "https://tenant.example.auth0.com/";
    await expect(createApiServer({ startOrchestrator: false })).rejects.toThrow("PUBLIC_DEMO serves mock data only; remove AUTH0_ISSUER");
    delete process.env.AUTH0_ISSUER;
    process.env.SUPABASE_URL = "https://project.supabase.co";
    await expect(createApiServer({ startOrchestrator: false })).rejects.toThrow("remove SUPABASE_URL");
  });
});

describe("serverless entry", () => {
  it("serves requests through the default export", async () => {
    process.env.ALLOW_DEMO_AUTH = "true";
    const host = createServer((request, response) => void handler(request, response));
    openServers.push(host);
    await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
  });
});

describe("startup message", () => {
  it("says the API is ready, where, and how it signs people in", () => {
    expect(startupMessage("127.0.0.1", 3000, { AUTH0_ISSUER: "https://tenant.example/" }))
      .toBe("API ready at http://127.0.0.1:3000 with Auth0 sign-in. Leave this window open; Ctrl+C stops it.");
    expect(startupMessage("127.0.0.1", 3000, { ALLOW_DEMO_AUTH: "true" }))
      .toBe("API ready at http://127.0.0.1:3000 in demo mode (x-demo-user). Leave this window open; Ctrl+C stops it.");
    expect(startupMessage("0.0.0.0", 8080, { PUBLIC_DEMO: "true" }))
      .toBe("API ready at http://0.0.0.0:8080 as the public demo, on mock data only. Leave this window open; Ctrl+C stops it.");
  });
});
