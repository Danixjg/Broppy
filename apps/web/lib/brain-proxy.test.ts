import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const sdk = vi.hoisted(() => ({ getSession: vi.fn(), getAccessToken: vi.fn() }));
vi.mock("./auth0", () => ({ auth0: sdk }));
import { GET, POST } from "../app/api/brain/[...path]/route";
const params = { params: Promise.resolve({ path: ["v1", "me"] }) };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
it("rejects missing sessions without contacting the API", async () => {
  sdk.getSession.mockResolvedValue(null);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const response = await GET(new NextRequest("http://127.0.0.1:3001/api/brain/v1/me"), params);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "signed_out" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects cross-origin mutations", async () => {
  sdk.getSession.mockResolvedValue({ user: { sub: "auth0|test" } });
  vi.stubEnv("APP_BASE_URL", "http://127.0.0.1:3001");
  const response = await POST(new NextRequest("http://127.0.0.1:3001/api/brain/v1/me", { method: "POST", headers: { origin: "https://other.example" } }), params);
  expect(response.status).toBe(403); expect(sdk.getAccessToken).not.toHaveBeenCalled();
});
it("uses only the SDK token and never forwards caller identity headers", async () => {
  sdk.getSession.mockResolvedValue({ user: { sub: "auth0|test" } });
  sdk.getAccessToken.mockResolvedValue({ token: "sdk-test-token" });
  vi.stubEnv("AUTH0_AUDIENCE", "https://api.example"); vi.stubEnv("AUTH0_ORG_ID", "org_test");
  vi.stubEnv("BRAIN_API_URL", "http://127.0.0.1:3000");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "test" })); vi.stubGlobal("fetch", fetcher);
  const response = await GET(new NextRequest("http://127.0.0.1:3001/api/brain/v1/me", { headers: { authorization: "Bearer caller-token", "x-demo-user": "maya" } }), params);
  expect(await response.json()).toEqual({ id: "test" });
  const options = fetcher.mock.calls[0][1] as RequestInit;
  expect(options.headers).toEqual({ authorization: "Bearer sdk-test-token", "content-type": "application/json" });
  expect(response.headers.get("authorization")).toBeNull();
});
function signedInApi(upstream: Response) {
  sdk.getSession.mockResolvedValue({ user: { sub: "auth0|test" } });
  sdk.getAccessToken.mockResolvedValue({ token: "sdk-test-token" });
  vi.stubEnv("AUTH0_AUDIENCE", "https://api.example"); vi.stubEnv("AUTH0_ORG_ID", "org_test");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => upstream));
}
it("reports an API rejection of a live session without echoing the API body", async () => {
  signedInApi(Response.json({ error: "Unauthorized", detail: "directory lookup failed" }, { status: 401 }));
  const response = await GET(new NextRequest("http://127.0.0.1:3001/api/brain/v1/me"), params);
  expect(response.status).toBe(401);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ code: "account_rejected" });
  expect(text).not.toContain("directory lookup failed");
});
it("passes other API errors through unchanged", async () => {
  signedInApi(Response.json({ error: "Forbidden" }, { status: 403 }));
  const response = await GET(new NextRequest("http://127.0.0.1:3001/api/brain/v1/me"), params);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Forbidden" });
});
const demoParams = { params: Promise.resolve({ path: ["v1", "workspace"] }) };
function demoRequest(options: { method?: string; persona?: string; cookie?: boolean; origin?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie !== false) headers.cookie = "brain_demo=1";
  if (options.persona !== undefined) headers["x-demo-user"] = options.persona;
  if (options.origin) headers.origin = options.origin;
  return new NextRequest("http://127.0.0.1:3001/api/brain/v1/workspace", { method: options.method ?? "GET", headers, body: options.body });
}
it("sends a demo visitor's persona only to the demo API, with no session or token", async () => {
  sdk.getSession.mockResolvedValue(null);
  vi.stubEnv("DEMO_API_URL", "http://127.0.0.1:3002"); vi.stubEnv("BRAIN_API_URL", "http://127.0.0.1:3000");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ documents: [] })); vi.stubGlobal("fetch", fetcher);
  const response = await GET(demoRequest({ persona: "maya" }), demoParams);
  expect(response.status).toBe(200);
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:3002/v1/workspace");
  expect(options?.headers).toEqual({ "x-demo-user": "maya", "content-type": "application/json" });
  expect(sdk.getAccessToken).not.toHaveBeenCalled();
});
it("refuses demo requests without a valid persona, the demo cookie or a demo API", async () => {
  sdk.getSession.mockResolvedValue(null);
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("DEMO_API_URL", "http://127.0.0.1:3002");
  expect((await GET(demoRequest({ persona: "Maya; admin" }), demoParams)).status).toBe(400);
  expect(await (await GET(demoRequest({ persona: "maya", cookie: false }), demoParams)).json()).toMatchObject({ code: "signed_out" });
  vi.stubEnv("DEMO_API_URL", "");
  expect(await (await GET(demoRequest({ persona: "maya" }), demoParams)).json()).toMatchObject({ code: "signed_out" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("keeps a signed-in session on the SSO API even with the demo cookie", async () => {
  sdk.getSession.mockResolvedValue({ user: { sub: "auth0|test" } });
  sdk.getAccessToken.mockResolvedValue({ token: "sdk-test-token" });
  vi.stubEnv("AUTH0_AUDIENCE", "https://api.example"); vi.stubEnv("AUTH0_ORG_ID", "org_test");
  vi.stubEnv("DEMO_API_URL", "http://127.0.0.1:3002"); vi.stubEnv("BRAIN_API_URL", "http://127.0.0.1:3000");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ documents: [] })); vi.stubGlobal("fetch", fetcher);
  await GET(demoRequest({ persona: "maya" }), demoParams);
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:3000/v1/workspace");
  expect(options?.headers).toEqual({ authorization: "Bearer sdk-test-token", "content-type": "application/json" });
});
it("blocks cross-origin demo writes and explains a demo API that refuses personas", async () => {
  sdk.getSession.mockResolvedValue(null);
  vi.stubEnv("DEMO_API_URL", "http://127.0.0.1:3002");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: "Unauthorized" }, { status: 401 })); vi.stubGlobal("fetch", fetcher);
  const write = await POST(demoRequest({ method: "POST", persona: "maya", origin: "https://other.example", body: "{}" }), demoParams);
  expect(write.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  const rejected = await GET(demoRequest({ persona: "zoe" }), demoParams);
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toMatchObject({ code: "demo_rejected" });
});
it("accepts a same-origin demo write when Next's internal URL names another host", async () => {
  sdk.getSession.mockResolvedValue(null);
  vi.stubEnv("DEMO_API_URL", "http://127.0.0.1:3002");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ text: "ok" })); vi.stubGlobal("fetch", fetcher);
  const request = new NextRequest("http://localhost:3001/api/brain/v1/query", { method: "POST", body: "{}",
    headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001", cookie: "brain_demo=1", "x-demo-user": "wei" } });
  expect((await POST(request, { params: Promise.resolve({ path: ["v1", "query"] }) })).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
