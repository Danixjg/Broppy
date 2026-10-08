import { describe, expect, it, vi } from "vitest";
import { ManagementError } from "./auth0-management.js";
import { companyAddress, Limiter, Signup, SignupError } from "./signup.js";

function setup(overrides: { create?: () => Promise<{ id: string; name: string; displayName: string }>; invite?: () => Promise<void>; inUse?: boolean; code?: string; open?: boolean } = {}) {
  let counter = 0;
  const invite = vi.fn(overrides.invite ?? (async () => {}));
  const management = {
    createOrganization: vi.fn(overrides.create ?? (async (input: { name: string; displayName: string }) => ({ id: `org_${++counter}`, name: input.name, displayName: input.displayName }))),
    deleteOrganization: vi.fn(async () => {}),
    findOrganization: vi.fn(async (name: string) => name === "acme" ? { id: "org_1", name: "acme", displayName: "Acme" } : undefined),
    forOrg: vi.fn(() => ({ invite }))
  };
  const companies = { emailInUse: vi.fn(async () => overrides.inUse === true), register: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    isKnown: vi.fn(async (id: string) => id === "org_1") };
  const add = vi.fn(async () => ({}));
  const created = vi.fn();
  const signup = new Signup(management as any, companies as any, () => ({ add }) as any,
    { connectionId: "con_1", accessCode: overrides.code, open: overrides.open, onCreated: created });
  return { signup, management, companies, add, invite, created };
}

describe("a company signing itself up", () => {
  it("builds the address from the company name", () => {
    expect(companyAddress("Acme & Sons, Inc.")).toBe("acme-and-sons-inc");
    expect(companyAddress("  Café  Müller ")).toBe("cafe-muller");
    expect(companyAddress("!!")).toBe("");
  });

  it("creates the organization, lists the company, adds the first admin and invites them", async () => {
    const { signup, management, companies, add, invite, created } = setup();
    await expect(signup.create({ company: "Acme", name: "Dana", email: " Dana@Acme.test " })).resolves.toEqual({ sent: true });
    expect(management.createOrganization).toHaveBeenCalledWith({ name: "acme", displayName: "Acme", connectionId: "con_1" });
    expect(companies.register).toHaveBeenCalledWith({ orgId: "org_1", name: "Acme", createdBy: "dana@acme.test" });
    expect(add).toHaveBeenCalledWith({ id: "dana", name: "Dana", email: "dana@acme.test", role: "admin", groups: [] });
    expect(invite).toHaveBeenCalledWith("dana@acme.test", "Broppy");
    expect(created).toHaveBeenCalledWith("org_1");
  });

  it("refuses a name that is taken, so one address is one company", async () => {
    const taken = setup({ create: async () => { throw new ManagementError("exists", 409); } });
    await expect(taken.signup.create({ company: "Acme", name: "D", email: "d@acme.test" })).rejects.toMatchObject({ status: 409 });
    expect(taken.management.createOrganization).toHaveBeenCalledTimes(1);
    expect(taken.add).not.toHaveBeenCalled();
  });

  it("creates nothing and answers the same for an email already on a company's list", async () => {
    const { signup, management } = setup({ inUse: true });
    await expect(signup.create({ company: "Acme", name: "Dana", email: "dana@acme.test" })).resolves.toEqual({ sent: true });
    expect(management.createOrganization).not.toHaveBeenCalled();
  });

  it("undoes everything when the invitation cannot be sent", async () => {
    const { signup, management, companies, add } = setup({ invite: async () => { throw new ManagementError("no", 500); } });
    await expect(signup.create({ company: "Acme", name: "Dana", email: "dana@acme.test" })).rejects.toBeInstanceOf(SignupError);
    // The first admin is added only once the invitation is out, so nothing is left in the directory to block a retry.
    expect(add).not.toHaveBeenCalled();
    expect(companies.remove).toHaveBeenCalledWith("org_1");
    expect(management.deleteOrganization).toHaveBeenCalledWith("org_1");
  });

  it("makes one company when the same email asks twice at once", async () => {
    const { signup, management } = setup();
    await Promise.all([signup.create({ company: "Acme", name: "D", email: "d@acme.test" }), signup.create({ company: "Acme", name: "D", email: "d@acme.test" })]);
    expect(management.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("checks the form", async () => {
    const { signup } = setup();
    for (const input of [{ company: "", name: "D", email: "d@acme.test" }, { company: "!!", name: "D", email: "d@acme.test" },
      { company: "Acme", name: "", email: "d@acme.test" }, { company: "Acme", name: "D", email: "nope" }, { company: "Acme", name: "D", email: "a@b.test, c@d.test" }]) {
      await expect(signup.create(input)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("asks for the access code when one is set, and refuses when sign-ups are closed", async () => {
    const guarded = setup({ code: "launch-2026" });
    await expect(guarded.signup.create({ company: "Acme", name: "D", email: "d@acme.test", code: "wrong" })).rejects.toMatchObject({ status: 403 });
    await expect(guarded.signup.create({ company: "Acme", name: "D", email: "d@acme.test" })).rejects.toMatchObject({ status: 403 });
    await expect(guarded.signup.create({ company: "Acme", name: "D", email: "d@acme.test", code: "launch-2026" })).resolves.toEqual({ sent: true });
    await expect(setup({ open: false }).signup.create({ company: "Acme", name: "D", email: "d@acme.test" })).rejects.toMatchObject({ status: 403 });
  });

  it("limits how often one email, and everyone together, can ask", async () => {
    const { signup } = setup();
    for (let i = 0; i < 3; i++) await signup.create({ company: `Co ${i}`, name: "D", email: "d@acme.test" });
    await expect(signup.create({ company: "Co 4", name: "D", email: "d@acme.test" })).rejects.toMatchObject({ status: 429 });
    // Many different emails don't make the limiter forget the company-wide count.
    const flood = setup();
    for (let i = 0; i < 20; i++) await flood.signup.create({ company: `Co ${i}`, name: "D", email: `p${i}@x.test` });
    for (let i = 0; i < 6000; i++) await flood.signup.create({ company: "Zed", name: "D", email: `q${i}@x.test` }).catch(() => undefined);
    await expect(flood.signup.create({ company: "Late", name: "D", email: "late@x.test" })).rejects.toMatchObject({ status: 429 });
  });

  it("finds only a company that signed up here", async () => {
    const { signup, management } = setup();
    expect(await signup.find("Acme")).toEqual({ organization: "org_1", name: "Acme" });
    expect(management.findOrganization).toHaveBeenCalledWith("acme");
    expect(await signup.find("nobody")).toBeUndefined();
    expect(await signup.find("!")).toBeUndefined();
    management.findOrganization.mockResolvedValueOnce({ id: "org_2", name: "other", displayName: "Other" });
    expect(await signup.find("other")).toBeUndefined();
  });
});

describe("limiter", () => {
  it("lets events through until the limit and again once the window passes", () => {
    let now = 0; const limiter = new Limiter(() => now);
    expect([1, 2, 3].map(() => limiter.allow("k", 2, 1000))).toEqual([true, true, false]);
    expect(limiter.allow("other", 2, 1000)).toBe(true);
    now = 1001;
    expect(limiter.allow("k", 2, 1000)).toBe(true);
  });
});
