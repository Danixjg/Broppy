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
