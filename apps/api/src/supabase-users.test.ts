import { describe, expect, it, vi } from "vitest";
import { SupabaseUsers } from "./supabase-users.js";

const row = {
  auth_user_id: "2f52c8ce-43da-4332-b22b-2809bdd74222",
  user_id: "ravi", name: "Ravi", email: "ravi@example.test", role: "member",
  groups: ["payments"], contractor: false,
  platform_identities: { slack: "ravi@example.test" }
};

describe("Supabase workspace identities", () => {
  it("loads server-only profile rows and authenticates a bearer token against Auth", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => String(input).includes("workspace_users")
      ? Response.json([row]) : Response.json({ id: row.auth_user_id }));
    const users = new SupabaseUsers({ url: "https://project.example.test/",
      secretKey: "server-secret", publishableKey: "public-key", fetch: transport as typeof fetch });
    const profiles = await users.list();
    expect(profiles[0]).toMatchObject({ id: "ravi", groups: ["payments"], supabaseAuthId: row.auth_user_id });
    expect(await users.validate("Bearer valid-token", profiles)).toEqual(profiles[0]);
    expect(transport.mock.calls[1][0]).toBe("https://project.example.test/auth/v1/user");
  });

  it("rejects missing profiles and unknown or invalid tokens", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => String(input).includes("workspace_users")
      ? Response.json([row]) : Response.json({ id: "not-provisioned" }));
    const users = new SupabaseUsers({ url: "https://project.example.test/",
      secretKey: "server-secret", publishableKey: "public-key", fetch: transport as typeof fetch });
    const profiles = await users.list();
    await expect(users.validate("Bearer unknown", profiles)).rejects.toThrow("Unauthorized");
    await expect(users.validate("not a token", profiles)).rejects.toThrow("Unauthorized");
  });
});
