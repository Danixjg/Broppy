import { describe, expect, it, vi } from "vitest";
import { Companies } from "./companies.js";

function setup(rows: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(rows), { status }));
  return { companies: new Companies({ url: "https://p.supabase.co", secretKey: "k", fetch: fetcher as typeof fetch }, "org_home"), fetcher };
}

describe("the list of companies", () => {
  it("always allows the home company and asks the database about the others", async () => {
    const { companies, fetcher } = setup([{ org_id: "org_a", status: "active" }]);
    expect(await companies.isKnown("org_home")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await companies.isKnown("org_a")).toBe(true);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain("org_id=eq.org_a");
  });

  it("turns away a suspended company, an unlisted one and anything that is not an organization ID", async () => {
    expect(await setup([{ org_id: "org_a", status: "suspended" }]).companies.isKnown("org_a")).toBe(false);
    expect(await setup([]).companies.isKnown("org_a")).toBe(false);
    const { companies, fetcher } = setup([{ org_id: "x", status: "active" }]);
    for (const id of ["", "x", "org_", "org_a&org_id=neq.1", "demo-company-a"]) expect(await companies.isKnown(id)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("denies when the database cannot be asked", async () => {
    await expect(setup({}, 500).companies.isKnown("org_a")).rejects.toThrow();
  });

  it("never removes the home company or its people", async () => {
    const { companies, fetcher } = setup([]);
    await expect(companies.remove("org_home")).rejects.toThrow();
    await expect(companies.forgetPeople("org_home")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says whether an email is already on any company's list", async () => {
    expect(await setup([{ user_id: "x" }]).companies.emailInUse("A@B.test")).toBe(true);
    expect(await setup([]).companies.emailInUse("a@b.test")).toBe(false);
  });
});
