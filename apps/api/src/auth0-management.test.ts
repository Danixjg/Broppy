import { describe, expect, it, vi } from "vitest";
import { Auth0Management, ManagementError } from "./auth0-management.js";

const issuer = "https://tenant.example.auth0.com/";

function setup(respond: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input as string | URL);
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.pathname === "/oauth/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    return respond(url, init);
  });
  const management = new Auth0Management({ issuer, orgId: "org_home", appClientId: "web", clientId: "m2m", clientSecret: "secret", fetch: fetcher as typeof fetch });
  return { management, calls };
}

describe("Auth0 management for several companies", () => {
  it("creates an organization with the sign-in database turned on", async () => {
    const { management, calls } = setup(() => new Response(JSON.stringify({ id: "org_new", name: "acme", display_name: "Acme" }), { status: 201 }));
    expect(await management.createOrganization({ name: "acme", displayName: "Acme", connectionId: "con_db" })).toEqual({ id: "org_new", name: "acme", displayName: "Acme" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { name: "acme", display_name: "Acme", enabled_connections: [{ connection_id: "con_db", assign_membership_on_login: false }] } });
  });

  it("reports a name that is taken with its status", async () => {
    const { management } = setup(() => new Response(JSON.stringify({ message: "exists" }), { status: 409 }));
    await expect(management.createOrganization({ name: "acme", displayName: "Acme", connectionId: "c" })).rejects.toMatchObject({ status: 409 });
  });

  it("reads the organization it was made for, with its sign-in address", async () => {
    const { management, calls } = setup(url => url.pathname.endsWith("/organizations/org_b")
      ? new Response(JSON.stringify({ id: "org_b", name: "acme-7k2qmx", display_name: "Acme" }), { status: 200 }) : new Response("{}", { status: 404 }));
    expect(await management.forOrg("org_b").organization()).toEqual({ id: "org_b", name: "acme-7k2qmx", displayName: "Acme" });
    expect(calls.at(-1)).toMatchObject({ method: "GET" });
  });

  it("finds an organization by name and returns nothing for an unknown one", async () => {
    const { management } = setup(url => url.pathname.endsWith("/acme") ? new Response(JSON.stringify({ id: "org_1", name: "acme" }), { status: 200 }) : new Response("{}", { status: 404 }));
    expect(await management.findOrganization("acme")).toEqual({ id: "org_1", name: "acme", displayName: "acme" });
    expect(await management.findOrganization("nope")).toBeUndefined();
  });

  it("invites into the organization it was made for, with one shared access token", async () => {
    const { management, calls } = setup(() => new Response("{}", { status: 201 }));
    await management.invite("a@home.test", "Maya");
    await management.forOrg("org_acme").invite("d@acme.test", "Broppy");
    await management.forOrg("org/odd").revokeInvitations("d@acme.test").catch(() => undefined);
    const invites = calls.filter(call => call.url.pathname.endsWith("/invitations") && call.method === "POST");
    expect(invites.map(call => call.url.pathname)).toEqual(["/api/v2/organizations/org_home/invitations", "/api/v2/organizations/org_acme/invitations"]);
    expect(calls.filter(call => call.url.pathname === "/oauth/token")).toHaveLength(1);
    expect(calls.some(call => call.url.pathname.includes("org%2Fodd"))).toBe(true);
  });

  it("is an error type callers can recognise", () => {
    expect(new ManagementError("x", 404).status).toBe(404);
  });
});
