import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const sdk = vi.hoisted(() => ({ getSession: vi.fn(), middleware: vi.fn() }));
vi.mock("./auth0", () => ({ auth0: sdk, authConfigured: false }));
import { GET as session } from "../app/api/session/route";
import { GET as enter } from "../app/demo/route";
import { GET as leave } from "../app/demo/exit/route";
import { proxy } from "../proxy";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

const visit = (path: string, demoCookie = false) =>
  new NextRequest(`https://broppy.example${path}`, { headers: demoCookie ? { cookie: "brain_demo=1" } : {} });

it("enters the demo only where it is offered, with an HttpOnly mode cookie", async () => {
  expect(enter(visit("/demo")).headers.get("location")).toBe("https://broppy.example/");
  vi.stubEnv("DEMO_API_URL", "https://demo-api.example");
  const entered = enter(visit("/demo"));
  expect(entered.headers.get("location")).toBe("https://broppy.example/workspace/index.html");
  const cookie = entered.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("brain_demo=1");
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=lax/i);
  const left = leave(visit("/demo/exit", true));
  expect(left.headers.get("location")).toBe("https://broppy.example/");
  expect(left.headers.get("set-cookie")).toMatch(/brain_demo=;/);
});

it("reports demo mode to the workspace, but a signed-in session comes first", async () => {
  vi.stubEnv("DEMO_API_URL", "https://demo-api.example");
  sdk.getSession.mockResolvedValue(null);
  expect(await (await session(visit("/api/session", true))).json()).toEqual({ demo: true });
  sdk.getSession.mockResolvedValue({ user: { name: "Ravi", email: "ravi@aspire.example" } });
  expect(await (await session(visit("/api/session", true))).json()).toEqual({ user: { name: "Ravi", email: "ravi@aspire.example" } });
  sdk.getSession.mockResolvedValue(null);
  expect((await session(visit("/api/session"))).status).toBe(401);
});

it("serves the start page and demo visitors without SSO settings, and nothing else", async () => {
  vi.stubEnv("DEMO_API_URL", "https://demo-api.example");
  const passes = (response: Response) => !response.headers.get("location") && response.status === 200;
  expect(passes(await proxy(visit("/workspace/index.html", true)))).toBe(true);
  expect(passes(await proxy(visit("/api/brain/v1/me", true)))).toBe(true);
  expect(passes(await proxy(visit("/")))).toBe(true);
  expect(passes(await proxy(visit("/demo")))).toBe(true);
  expect((await proxy(visit("/workspace/index.html"))).headers.get("location")).toBe("https://broppy.example/");
  expect((await proxy(visit("/api/brain/v1/me"))).status).toBe(503);
  vi.stubEnv("DEMO_API_URL", "");
  expect((await proxy(visit("/workspace/index.html", true))).headers.get("location")).toBe("https://broppy.example/");
  expect(sdk.middleware).not.toHaveBeenCalled();
});

it("redirects on the host the browser used, not Next's internal one", () => {
  vi.stubEnv("DEMO_API_URL", "https://demo-api.example");
  const request = new NextRequest("http://localhost:3001/demo", { headers: { host: "127.0.0.1:3001" } });
  expect(enter(request).headers.get("location")).toBe("http://127.0.0.1:3001/workspace/index.html");
  const vercel = new NextRequest("http://localhost:3000/demo",
    { headers: { host: "internal", "x-forwarded-host": "broppy-one.vercel.app", "x-forwarded-proto": "https" } });
  expect(enter(vercel).headers.get("location")).toBe("https://broppy-one.vercel.app/workspace/index.html");
});
