import { describe, expect, it, vi } from "vitest";
import { SourceOAuth } from "./source-oauth.js";
import type { Persistence } from "./persistence.js";
import type { User } from "@brain/types";
/** Stands in for the Supabase OAuth state functions, shared by every "instance" built on it. */
function flows(inner?: (path: string, method: string, data: any) => Promise<unknown>) {
  const rows = new Map<string, any>();
  return vi.fn(async (path: string, method: string, data: any) => {
    if (path === "rpc/begin_oauth_flow") { rows.set(data.state_hash, data); return undefined; }
    if (path === "rpc/consume_oauth_flow") { const row = rows.get(data.state_hash); rows.delete(data.state_hash); return row ?? null; }
    return inner ? inner(path, method, data) : undefined;
  });
}
const user: User = { id: "maya", auth0Sub: "auth0|real", orgId: "org_a", active: true, name: "Maya", email: "maya@example.test", groups: [], role: "admin",
  platformIdentities: { drive: "maya@example.test", slack: "maya@example.test", jira: "maya@example.test", confluence: "maya@example.test" } };
it("binds single-use OAuth state to an active org admin and stores tokens only in Vault", async () => {
  const request = flows();
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("token") ? Response.json({ access_token: "private-token", expires_in: 3600, refresh_token: "private-refresh" }) : Response.json({ email: user.email }));
  const oauth = new SourceOAuth({ drive: { clientId: "client", clientSecret: "secret", scopes: ["openid", "email"] } }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
  const url = new URL(await oauth.begin("drive", user));
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const state = url.searchParams.get("state")!;
  expect(await oauth.complete("drive", state, "code", async () => user)).toEqual(user);
  expect(request).toHaveBeenCalledWith("rpc/store_source_token", "POST", expect.objectContaining({ organization: "org_a", provider: "drive" }));
  expect(await oauth.authorization("drive")).toBe("Bearer private-token");
  await expect(oauth.complete("drive", state, "code", async () => user)).rejects.toThrow("Invalid OAuth state");
  await expect(oauth.begin("drive", { ...user, orgId: "other" })).rejects.toThrow("Forbidden");
  const newState = new URL(await oauth.begin("drive", user)).searchParams.get("state")!;
  await expect(oauth.complete("drive", newState, "code", async () => ({ ...user, active: false }))).rejects.toThrow("Forbidden");
});

it("lets only the admin connect, serves everyone from that one connection, and clears leftover personal connections", async () => {
  const store = new Map<string, any>();
  const request = flows(async (path: string, _method: string, data: any) => {
    if (path === "rpc/store_source_token") store.set(`org/${data.provider}`, data.token);
    if (path === "rpc/read_source_token") return store.get(`org/${data.provider}`) ?? null;
    if (path === "rpc/remove_source_token") store.delete(`org/${data.provider}`);
    return undefined;
  });
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("accessible-resources") ? Response.json([{ id: "cloud-1", url: "https://acme.atlassian.net" }]) :
    String(url).includes("token") ? Response.json({ access_token: "admin-token", expires_in: 3600 }) : Response.json({ email: user.email }));
  const oauth = new SourceOAuth({ jira: { clientId: "client", clientSecret: "secret", scopes: ["read:me"] } }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
  const ravi: User = { ...user, id: "ravi", auth0Sub: "auth0|ravi", email: "ravi@example.test", role: "member" };
  await expect(oauth.begin("jira", ravi)).rejects.toThrow("Forbidden");
  const url = new URL(await oauth.begin("jira", user));
  expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/v1/admin/connections/jira/callback");
  await oauth.complete("jira", url.searchParams.get("state")!, "code", async () => user);
  expect(request).toHaveBeenCalledWith("rpc/remove_user_source_tokens", "POST", expect.objectContaining({ person: null, provider: "jira" }));
  expect(await oauth.authorization("jira")).toBe("Bearer admin-token");
  await oauth.remove("jira");
  expect(await oauth.authorization("jira")).toBeUndefined();
});

it("stores the admin's Slack grant from the combined install as the shared connection, and refuses anyone else", async () => {
  const store = new Map<string, any>();
  const request = flows(async (path: string, _method: string, data: any) => {
    if (path === "rpc/store_source_token") store.set(`org/${data.provider}`, data.token);
    if (path === "rpc/read_source_token") return store.get(`org/${data.provider}`) ?? null;
    return undefined;
  });
  const oauth = new SourceOAuth({ slack: { clientId: "client", clientSecret: "secret", scopes: ["channels:read"] } }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence);
  await expect(oauth.storeGrant("slack", { ...user, role: "member" }, { access_token: "xoxp-1" })).rejects.toThrow("Forbidden");
  await oauth.storeGrant("slack", user, { access_token: "xoxp-1", scope: "channels:read,users:read" });
  expect(await oauth.authorization("slack")).toBe("Bearer xoxp-1");
  expect(store.get("org/slack")).toMatchObject({ userId: "maya", scopes: ["channels:read", "users:read"] });
});

it("finds the Atlassian site at sign-in, stores it with the org token", async () => {
  const store = new Map<string, any>();
  const request = flows(async (path: string, _method: string, data: any) => {
    if (path === "rpc/store_source_token") store.set(`org/${data.provider}`, data.token);
    if (path === "rpc/read_source_token") return store.get(`org/${data.provider}`) ?? null;
    return undefined;
  });
  let sites: unknown[] = [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }];
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("accessible-resources")) return Response.json(sites);
    if (target.includes("oauth/token")) return Response.json({ access_token: "atl-token", expires_in: 3600 });
    return Response.json({ email: user.email });
  });
  const config = { jira: { clientId: "client", clientSecret: "secret", scopes: ["read:jira-work"] } };
  const oauth = new SourceOAuth(config, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
  expect(await oauth.orgSite("jira")).toBeUndefined();
  const state = new URL(await oauth.begin("jira", user)).searchParams.get("state")!;
  await oauth.complete("jira", state, "code", async () => user);
  expect(await oauth.orgSite("jira")).toEqual({ baseUrl: "https://acme.atlassian.net", cloudId: "cloud-1" });
  expect(store.get("org/jira").site).toEqual({ baseUrl: "https://acme.atlassian.net", cloudId: "cloud-1" });

  sites = [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }, { id: "cloud-9", url: "https://other.atlassian.net", name: "Other" }];
  // Several sites and no pinned site: the admin must choose in configuration.
  const fresh = new SourceOAuth(config, "https://api.example.test", { orgId: "org_a", request: flows() } as unknown as Persistence, fetcher);
  const next = new URL(await fresh.begin("jira", user)).searchParams.get("state")!;
  await expect(fresh.complete("jira", next, "code", async () => user)).rejects.toThrow("Several Atlassian sites");
  const pinned = new SourceOAuth({ jira: { ...config.jira, cloudId: "cloud-9" } }, "https://api.example.test", { orgId: "org_a", request: flows() } as unknown as Persistence, fetcher);
  await pinned.complete("jira", new URL(await pinned.begin("jira", user)).searchParams.get("state")!, "code", async () => user);
  expect(await pinned.orgSite("jira")).toEqual({ baseUrl: "https://other.atlassian.net", cloudId: "cloud-9" });
  // Another company's account can't reach the configured site: it connects the one site it can reach.
  sites = [{ id: "cloud-2", url: "https://beta.atlassian.net", name: "Beta" }];
  const another = new SourceOAuth({ jira: { ...config.jira, cloudId: "cloud-9" } }, "https://api.example.test", { orgId: "org_a", request: flows() } as unknown as Persistence, fetcher);
  await another.complete("jira", new URL(await another.begin("jira", user)).searchParams.get("state")!, "code", async () => user);
  expect(await another.orgSite("jira")).toEqual({ baseUrl: "https://beta.atlassian.net", cloudId: "cloud-2" });
});

it("keeps sign-in state in shared storage so a callback can reach a different instance, and uses a token another instance already refreshed", async () => {
  const store = new Map<string, any>();
  const shared = flows(async (path, _method, data) => {
    if (path === "rpc/store_source_token") store.set("org", data.token);
    if (path === "rpc/read_source_token") return store.get("org") ?? null;
    return undefined;
  });
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("token") ? Response.json({ access_token: "first", refresh_token: "r1", expires_in: 3600, scope: "openid email" }) : Response.json({ email: user.email }));
  const persistence = { orgId: "org_a", request: shared } as unknown as Persistence;
  const config = { drive: { clientId: "client", clientSecret: "secret", scopes: ["openid", "email"] } };
  const one = new SourceOAuth(config, "https://api.example.test", persistence, fetcher), two = new SourceOAuth(config, "https://api.example.test", persistence, fetcher);
  const state = new URL(await one.begin("drive", user)).searchParams.get("state")!;
  // The state is never stored in the clear, and the other instance can finish the flow exactly once.
  expect(JSON.stringify(shared.mock.calls)).not.toContain(state);
  await two.complete("drive", state, "code", async () => user);
  await expect(one.complete("drive", state, "code", async () => user)).rejects.toThrow("Invalid OAuth state");
  expect(store.get("org").scopes).toEqual(["openid", "email"]);

  // Instance one reads an expired token; by the time it would refresh, instance two has stored a rotated one, so no refresh request is made.
  const rotated = { ...store.get("org"), access_token: "rotated", refresh_token: "r2", expires_at: Date.now() + 3_600_000 };
  const expired = { ...store.get("org"), access_token: "expired", expires_at: Date.now() - 1000 };
  let reads = 0;
  const stale = new SourceOAuth(config, "https://api.example.test", { orgId: "org_a", request: flows(async path => path === "rpc/read_source_token" ? (reads++ === 0 ? expired : rotated) : undefined) } as unknown as Persistence, fetcher);
  const calls = fetcher.mock.calls.length;
  expect(await stale.authorization("drive")).toBe("Bearer rotated");
  expect(fetcher.mock.calls.length).toBe(calls);
});

describe("one Atlassian approval for Jira and Confluence", () => {
  const atlassianUser: User = { ...user, platformIdentities: { ...user.platformIdentities, jira: user.email, confluence: user.email } as User["platformIdentities"] };
  function setup(options: { confluenceClient?: string; granted?: string; sites?: Array<{ id: string; url: string }> } = {}) {
    const store = new Map<string, any>();
    const request = flows(async (path: string, _method: string, data: any) => {
      if (path === "rpc/store_source_token") store.set(data.provider, data.token);
      if (path === "rpc/read_source_token") return store.get(data.provider) ?? null;
      return undefined;
    });
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("accessible-resources")
      ? Response.json(options.sites ?? [{ id: "cloud-1", url: "https://acme.atlassian.net" }])
      : String(url).includes("token") ? Response.json({ access_token: "shared", expires_in: 3600, scope: options.granted ?? "read:jira-work read:confluence-content.all read:me" })
      : Response.json({ email: user.email }));
    const oauth = new SourceOAuth({
      jira: { clientId: "atlassian-app", clientSecret: "s", scopes: ["read:jira-work", "read:me"] },
      confluence: { clientId: options.confluenceClient ?? "atlassian-app", clientSecret: "s", scopes: ["read:confluence-content.all", "read:me"] }
    }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
    return { oauth, store };
  }

  it("asks for both products' permissions and connects both when the same app is used", async () => {
    const { oauth, store } = setup();
    const url = new URL(await oauth.begin("jira", atlassianUser));
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["read:confluence-content.all", "read:jira-work", "read:me"]);
    const result = await oauth.completeAll("jira", url.searchParams.get("state")!, "code", async () => atlassianUser);
    expect(result.sources).toEqual(["jira", "confluence"]);
    expect(store.get("confluence")).toMatchObject({ access_token: "shared", site: { cloudId: "cloud-1" } });
    expect(await oauth.authorization("confluence")).toBe("Bearer shared");
  });

  it("connects only the one asked for with separate apps, or when the approval lacks the other's permissions", async () => {
    const separate = setup({ confluenceClient: "another-app" });
    const url = new URL(await separate.oauth.begin("jira", atlassianUser));
    expect(url.searchParams.get("scope")).toBe("read:jira-work read:me");
    expect((await separate.oauth.completeAll("jira", url.searchParams.get("state")!, "code", async () => atlassianUser)).sources).toEqual(["jira"]);
    const partial = setup({ granted: "read:jira-work read:me" });
    const again = new URL(await partial.oauth.begin("jira", atlassianUser));
    expect((await partial.oauth.completeAll("jira", again.searchParams.get("state")!, "code", async () => atlassianUser)).sources).toEqual(["jira"]);
    expect(partial.store.has("confluence")).toBe(false);
  });
});
