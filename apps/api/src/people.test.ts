import { describe, expect, it, vi } from "vitest";
import type { User } from "@brain/types";
import { Auth0Management } from "./auth0-management.js";
import { People, PeopleError } from "./people.js";
import { DirectoryConflict, UserDirectory } from "./user-directory.js";

const admin: User = { id: "maya", name: "Maya", email: "maya@company.test", auth0Sub: "auth0|maya", groups: [], role: "admin", orgId: "org_a", active: true };

type FakeDirectory = { list(): Promise<User[]>; stored: User[] };
function fakeDirectory(initial: User[] = [admin]): UserDirectory & FakeDirectory {
  const rows = initial.map(row => ({ ...row }));
  return {
    stored: rows,
    list: async () => rows.map(row => ({ ...row })),
    byEmail: async (email: string) => rows.find(row => row.email === email.trim().toLowerCase()),
    add: vi.fn(async (person: { id: string; name: string; email: string; role: User["role"]; groups: string[] }) => {
      if (rows.some(row => row.id === person.id)) throw new DirectoryConflict();
      const row: User = { ...person, auth0Sub: "", orgId: "org_a", active: true };
      rows.push(row); return row;
    }),
    update: async (id: string, patch: Partial<User>) => { const row = rows.find(item => item.id === id); if (row) Object.assign(row, patch); return row; }
  } as unknown as UserDirectory & FakeDirectory;
}

function fakeManagement(overrides: Partial<Record<"invite" | "revokeInvitations" | "addMember" | "removeMember", () => Promise<void>>> = {}) {
  const base = { invite: async () => {}, revokeInvitations: async () => {}, addMember: async () => {}, removeMember: async () => {}, ...overrides };
  return Object.fromEntries(Object.entries(base).map(([name, fn]) => [name, vi.fn(fn)])) as unknown as Auth0Management &
    Record<"invite" | "revokeInvitations" | "addMember" | "removeMember", ReturnType<typeof vi.fn>>;
}

describe("admin adds people", () => {
  it("adds a work email as an invited member and sends the Auth0 invitation", async () => {
    const management = fakeManagement(); const directory = fakeDirectory();
    const result = await new People(directory, management).add(admin, { email: "  Priya.Nair@Company.test ", groups: ["payments"] });
    expect(result).toMatchObject({ auth0: "invited", person: { id: "priya-nair", email: "priya.nair@company.test", name: "priya.nair", role: "member", groups: ["payments"], status: "invited" } });
    expect(management.invite).toHaveBeenCalledWith("priya.nair@company.test", "Maya");
  });

  it("refuses bad emails, bad roles and an email that is already on the list", async () => {
    const people = new People(fakeDirectory(), fakeManagement());
    for (const email of ["", "not-an-email", "a@b", "x y@company.test", "a@company.test, b@company.test"]) {
      await expect(people.add(admin, { email })).rejects.toMatchObject({ status: 400 });
    }
    await expect(people.add(admin, { email: "p@company.test", role: "root" })).rejects.toMatchObject({ status: 400 });
    await expect(people.add(admin, { email: "MAYA@company.test" })).rejects.toMatchObject({ status: 409 });
  });

  it("gives a namesake a different ID", async () => {
    const directory = fakeDirectory([admin, { ...admin, id: "priya", email: "priya@other.test", auth0Sub: "auth0|p" }]);
    const result = await new People(directory, fakeManagement()).add(admin, { email: "priya@company.test" });
    expect(result.person.id).toBe("priya-2");
  });

  it("keeps the entry and says so when Auth0 cannot send the invitation, then resends on request", async () => {
    const management = fakeManagement({ invite: async () => { throw new Error("Auth0 refused the request (403): insufficient_scope"); } });
    const directory = fakeDirectory(); const people = new People(directory, management);
    const added = await people.add(admin, { email: "priya@company.test" });
    expect(added).toMatchObject({ auth0: "failed", auth0Error: expect.stringContaining("insufficient_scope"), person: { status: "invited" } });
    expect(directory.stored.some(row => row.email === "priya@company.test" && row.active)).toBe(true);
    management.invite.mockResolvedValueOnce(undefined);
    expect(await people.invite(admin, "priya")).toMatchObject({ auth0: "invited" });
    expect(management.revokeInvitations).toHaveBeenCalledWith("priya@company.test");
  });

  it("still records the person when Auth0 invitations are not set up", async () => {
    const people = new People(fakeDirectory());
    expect(people.canInvite).toBe(false);
    expect(await people.add(admin, { email: "priya@company.test" })).toMatchObject({ auth0: "not_configured", person: { status: "invited" } });
  });

  it("does not resend to someone who already signed in", async () => {
    await expect(new People(fakeDirectory(), fakeManagement()).invite(admin, "maya")).rejects.toMatchObject({ status: 409 });
  });
});

describe("admin removes people", () => {
  const priya: User = { ...admin, id: "priya", name: "Priya", email: "priya@company.test", auth0Sub: "auth0|priya", role: "member" };

  it("ends access in the directory first, then in Auth0", async () => {
    const management = fakeManagement(); const directory = fakeDirectory([admin, priya]);
    const result = await new People(directory, management).remove(admin, "priya");
    expect(result).toMatchObject({ auth0: "withdrawn", person: { status: "removed" } });
    expect(directory.stored.find(row => row.id === "priya")?.active).toBe(false);
    expect(management.revokeInvitations).toHaveBeenCalledWith("priya@company.test");
    expect(management.removeMember).toHaveBeenCalledWith("auth0|priya");
  });

  it("keeps access removed even when Auth0 fails", async () => {
    const directory = fakeDirectory([admin, priya]);
    const management = fakeManagement({ removeMember: async () => { throw new Error("Auth0 refused the request (403)"); } });
    expect(await new People(directory, management).remove(admin, "priya")).toMatchObject({ auth0: "failed", person: { status: "removed" } });
    expect(directory.stored.find(row => row.id === "priya")?.active).toBe(false);
  });

  it("will not remove yourself or the last admin, and an unknown person is not found", async () => {
    const people = new People(fakeDirectory([admin, priya]), fakeManagement());
    await expect(people.remove(admin, "maya")).rejects.toMatchObject({ status: 409 });
    await expect(people.remove({ ...priya, role: "admin" }, "maya")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("at least one admin") });
    await expect(people.remove(admin, "nobody")).rejects.toBeInstanceOf(PeopleError);
  });

  it("adding a removed email again restores them without a new invitation", async () => {
    const management = fakeManagement(); const directory = fakeDirectory([admin, { ...priya, active: false }]);
    const result = await new People(directory, management).add(admin, { email: "priya@company.test", role: "compliance" });
    expect(result).toMatchObject({ auth0: "restored", person: { id: "priya", role: "compliance", status: "active" } });
    expect(management.addMember).toHaveBeenCalledWith("auth0|priya");
    expect(management.invite).not.toHaveBeenCalled();
  });
});

describe("Auth0Management", () => {
  const issuer = "https://tenant.auth0.com/";
  function setup(respond: (url: URL, init?: RequestInit) => Response) {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => { const url = new URL(String(input)); calls.push({ url, init }); return respond(url, init); });
    return { calls, management: new Auth0Management({ issuer, orgId: "org_abc", appClientId: "web-app", clientId: "m2m", clientSecret: "secret", fetch: fetcher as typeof fetch, now: () => 0 }) };
  }
  const token = () => Response.json({ access_token: "mgmt-token", expires_in: 86400 });

  it("invites an email to the organization for the web application and reuses its token", async () => {
    const { calls, management } = setup(url => url.pathname === "/oauth/token" ? token() : new Response("{}", { status: 201 }));
    await management.invite("priya@company.test", "Maya");
    await management.invite("raj@company.test", "Maya");
    expect(calls.filter(call => call.url.pathname === "/oauth/token")).toHaveLength(1);
    const invitation = calls.find(call => call.url.pathname === "/api/v2/organizations/org_abc/invitations")!;
    expect(invitation.init?.method).toBe("POST");
    expect(new Headers(invitation.init?.headers).get("authorization")).toBe("Bearer mgmt-token");
    expect(JSON.parse(String(invitation.init?.body))).toMatchObject({ client_id: "web-app", invitee: { email: "priya@company.test" }, inviter: { name: "Maya" }, send_invitation_email: true });
  });

  it("revokes only the invitations for that email", async () => {
    const { calls, management } = setup((url, init) => url.pathname === "/oauth/token" ? token()
      : init?.method === "DELETE" ? new Response(null, { status: 204 })
        : Response.json([{ id: "inv_1", invitee: { email: "Priya@company.test" } }, { id: "inv_2", invitee: { email: "raj@company.test" } }]));
    await management.revokeInvitations("priya@company.test");
    expect(calls.filter(call => call.init?.method === "DELETE").map(call => call.url.pathname)).toEqual(["/api/v2/organizations/org_abc/invitations/inv_1"]);
  });

  it("removes a member by Auth0 ID, and explains a refusal without echoing secrets", async () => {
    const { calls, management } = setup(url => url.pathname === "/oauth/token" ? token() : new Response(JSON.stringify({ error: "Forbidden", message: "Insufficient scope" }), { status: 403 }));
    await expect(management.removeMember("auth0|priya")).rejects.toThrow("Auth0 refused the request (403): Forbidden: Insufficient scope");
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ members: ["auth0|priya"] });
  });

  it("needs all of its settings or none", () => {
    expect(Auth0Management.fromEnv({})).toBeUndefined();
    expect(() => Auth0Management.fromEnv({ AUTH0_MANAGEMENT_CLIENT_ID: "x" })).toThrow("AUTH0_MANAGEMENT_CLIENT_SECRET");
  });
});
