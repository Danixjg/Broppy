import { expect, it, vi } from "vitest";
import { SourceOAuth } from "./source-oauth.js";
import type { Persistence } from "./persistence.js";
import type { User } from "@brain/types";
const user: User = { id: "maya", auth0Sub: "auth0|real", orgId: "org_a", active: true, name: "Maya", email: "maya@example.test", groups: [], role: "admin",
  platformIdentities: { drive: "maya@example.test", slack: "maya@example.test", jira: "maya@example.test", confluence: "maya@example.test" } };
it("binds single-use OAuth state to an active org admin and stores tokens only in Vault", async () => {
  const request = vi.fn(async () => undefined);
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("token") ? Response.json({ access_token: "private-token", expires_in: 3600, refresh_token: "private-refresh" }) : Response.json({ email: user.email }));
  const oauth = new SourceOAuth({ drive: { clientId: "client", clientSecret: "secret", scopes: ["openid", "email"] } }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
  const url = new URL(oauth.begin("drive", user));
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const state = url.searchParams.get("state")!;
  expect(await oauth.complete("drive", state, "code", async () => user)).toEqual(user);
  expect(request).toHaveBeenCalledWith("rpc/store_source_token", "POST", expect.objectContaining({ organization: "org_a", provider: "drive" }));
  expect(await oauth.authorization("drive", "other")).toBeUndefined();
  expect(await oauth.authorization("drive", user.id)).toBe("Bearer private-token");
  await expect(oauth.complete("drive", state, "code", async () => user)).rejects.toThrow("Invalid OAuth state");
  expect(() => oauth.begin("drive", { ...user, orgId: "other" })).toThrow("Forbidden");
  const newState = new URL(oauth.begin("drive", user)).searchParams.get("state")!;
  await expect(oauth.complete("drive", newState, "code", async () => ({ ...user, active: false }))).rejects.toThrow("Forbidden");
});

it("lets any active user connect their own account, keeps it separate from the org connection, and purges it with the source", async () => {
  const store = new Map<string, any>();
  const request = vi.fn(async (path: string, _method: string, data: any) => {
    if (path === "rpc/store_user_source_token") store.set(`${data.person}/${data.provider}`, data.token);
    if (path === "rpc/read_user_source_token") return store.get(`${data.person}/${data.provider}`) ?? null;
    if (path === "rpc/remove_user_source_tokens") for (const key of [...store.keys()]) if (key.endsWith(`/${data.provider}`) && (!data.person || key.startsWith(`${data.person}/`))) store.delete(key);
    if (path === "rpc/list_user_source_connections") return [...store.keys()].filter(key => key.startsWith(`${data.person}/`)).map(key => ({ source: key.split("/")[1] }));
    return undefined;
  });
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("token") ? Response.json({ access_token: "ravi-token", expires_in: 3600 }) : Response.json({ email: "ravi@example.test" }));
  const oauth = new SourceOAuth({ jira: { clientId: "client", clientSecret: "secret", scopes: ["read:me"] } }, "https://api.example.test", { orgId: "org_a", request } as unknown as Persistence, fetcher);
  const ravi: User = { ...user, id: "ravi", auth0Sub: "auth0|ravi", email: "ravi@example.test", role: "member", platformIdentities: { ...user.platformIdentities!, jira: "ravi@example.test" } };
  expect(() => oauth.begin("jira", ravi)).toThrow("Forbidden");
  const url = new URL(oauth.begin("jira", ravi, "user"));
  expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/v1/connections/jira/callback");
  const state = url.searchParams.get("state")!;
  // A user flow cannot be completed through the admin callback, and the identity must match the signed-in person.
  await expect(oauth.complete("jira", state, "code", async () => ravi)).rejects.toThrow("Invalid OAuth state");
  const second = new URL(oauth.begin("jira", ravi, "user")).searchParams.get("state")!;
  await expect(oauth.complete("jira", second, "code", async () => ({ ...ravi, platformIdentities: { ...ravi.platformIdentities!, jira: "other@example.test" } }), "user")).rejects.toThrow("could not be matched");
  const third = new URL(oauth.begin("jira", ravi, "user")).searchParams.get("state")!;
  await oauth.complete("jira", third, "code", async () => ravi, "user");
  expect(request).toHaveBeenCalledWith("rpc/store_user_source_token", "POST", expect.objectContaining({ person: "ravi", provider: "jira" }));
  expect(request).not.toHaveBeenCalledWith("rpc/store_source_token", expect.anything(), expect.anything());
  expect(await oauth.authorizationFor("ravi", "jira")).toBe("Bearer ravi-token");
  expect(await oauth.authorizationFor("maya", "jira")).toBeUndefined();
  expect(await oauth.authorization("jira", "ravi")).toBe("Bearer ravi-token");
  expect(await oauth.authorization("jira")).toBeUndefined();
  expect(await oauth.connectedSources("ravi")).toEqual(["jira"]);
  await oauth.remove("jira");
  expect(await oauth.authorizationFor("ravi", "jira")).toBeUndefined();
});
