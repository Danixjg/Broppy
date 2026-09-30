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
