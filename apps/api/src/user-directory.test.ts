import { expect, it, vi } from "vitest";
import { UserDirectory } from "./user-directory.js";
it("loads real Auth0 subjects and scopes the directory by organisation", async () => {
  const row = { auth0_sub: "auth0|real", org_id: "org_a", active: true, user_id: "ravi", name: "Ravi",
    email: "ravi@example.test", role: "member", groups: ["payments"], contractor: false,
    platform_identities: { slack: "ravi@example.test" } };
  const transport = vi.fn(async () => Response.json([row]));
  const directory = new UserDirectory({ url: "https://project.example.test/", secretKey: "secret", fetch: transport }, "org_a");
  expect(await directory.bySub("auth0|real")).toMatchObject({ id: "ravi", orgId: "org_a", active: true });
  expect(await directory.bySub("unknown")).toBeUndefined();
  expect(transport.mock.calls.length).toBe(2);
  expect(String((transport.mock.calls[0] as unknown[])[0])).toContain("auth0_sub=eq.auth0%7Creal");
  expect(String((transport.mock.calls[0] as unknown[])[0])).toContain("limit=1");
});
