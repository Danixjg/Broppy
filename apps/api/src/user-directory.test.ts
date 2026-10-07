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

const row = { auth0_sub: null, org_id: "org_a", active: true, user_id: "priya", name: "Priya", email: "priya@company.test", role: "member", groups: [], contractor: false, platform_identities: { slack: "priya@company.test" } };
const directoryWith = (transport: ReturnType<typeof vi.fn>) => new UserDirectory({ url: "https://project.example.test/", secretKey: "secret", fetch: transport as unknown as typeof fetch }, "org_a");

it("reads a person who has not signed in yet as having no Auth0 subject", async () => {
  expect(await directoryWith(vi.fn(async () => Response.json([row]))).list()).toMatchObject([{ id: "priya", auth0Sub: "", active: true }]);
});

it("adds a person with a lowercase email and the organization, and reports a taken ID", async () => {
  const transport = vi.fn(async () => Response.json([row], { status: 201 }));
  await directoryWith(transport).add({ id: "priya", name: "Priya", email: " Priya@Company.test ", role: "member", groups: [] });
  const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://project.example.test/rest/v1/workspace_users");
  expect(JSON.parse(String(init.body))).toMatchObject({ org_id: "org_a", email: "priya@company.test", active: true, platform_identities: { slack: "priya@company.test" } });
  await expect(directoryWith(vi.fn(async () => new Response("{}", { status: 409 }))).add({ id: "priya", name: "P", email: "p@company.test", role: "member", groups: [] })).rejects.toThrow("Already in the directory");
});

it("claims an entry only while it is active and has no subject", async () => {
  const transport = vi.fn(async () => Response.json([{ ...row, auth0_sub: "auth0|priya" }]));
  expect(await directoryWith(transport).claim("Priya@company.test", "auth0|priya")).toMatchObject({ auth0Sub: "auth0|priya" });
  const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("org_id=eq.org_a&email=eq.priya%40company.test&auth0_sub=is.null&active=eq.true");
  expect(init.method).toBe("PATCH");
  expect(await directoryWith(vi.fn(async () => Response.json([]))).claim("priya@company.test", "auth0|other")).toBeUndefined();
});
