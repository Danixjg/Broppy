import { describe, expect, it, vi } from "vitest";
import { TenantRegistry } from "./tenants.js";

const make = (known: (orgId: string) => boolean = () => true, max = 25) => {
  let clock = 0;
  const builds: string[] = []; const dropped: string[] = [];
  const registry = new TenantRegistry<{ id: string }>({
    homeOrgId: "org_home", home: { id: "org_home" }, max, now: () => clock,
    isKnown: vi.fn(async orgId => known(orgId)),
    build: async orgId => { builds.push(orgId); await Promise.resolve(); return { id: orgId }; },
    drop: tenant => dropped.push(tenant.id)
  });
  return { registry, builds, dropped, advance: (ms: number) => { clock += ms; } };
};

describe("one workspace per company", () => {
  it("serves the home company without asking, and builds another company once however many ask at the same time", async () => {
    const { registry, builds } = make();
    expect((await registry.get("org_home"))?.id).toBe("org_home");
    const [a, b] = await Promise.all([registry.get("org_a"), registry.get("org_a")]);
    expect(a).toBe(b);
    expect(builds).toEqual(["org_a"]);
    expect(await registry.get("org_a")).toBe(a);
    expect(builds).toEqual(["org_a"]);
  });

  it("builds nothing for a company that is not listed, and asks again shortly after", async () => {
    let listed = false;
    const { registry, builds, advance } = make(() => listed);
    expect(await registry.get("org_new")).toBeUndefined();
    expect(await registry.get(undefined)).toBeUndefined();
    listed = true;
    expect(await registry.get("org_new")).toBeUndefined();
    advance(20_000);
    expect((await registry.get("org_new"))?.id).toBe("org_new");
    expect(builds).toEqual(["org_new"]);
  });

  it("stops serving and drops a company once it is no longer listed", async () => {
    let listed = true;
    const { registry, dropped, advance } = make(() => listed);
    await registry.get("org_a");
    listed = false; advance(61_000);
    expect(await registry.get("org_a")).toBeUndefined();
    expect(dropped).toEqual(["org_a"]);
  });

  it("drops the longest-unused company beyond the limit and never the home company", async () => {
    const { registry, dropped, advance } = make(() => true, 2);
    await registry.get("org_a"); advance(1); await registry.get("org_b"); advance(70_000);
    await registry.get("org_a"); advance(1); await registry.get("org_c");
    expect(dropped).toEqual(["org_b"]);
    expect(registry.all().map(item => item.id)).toEqual(["org_home", "org_a", "org_c"]);
  });

  it("keeps a company used in the last minute even when over the limit", async () => {
    const { registry, dropped } = make(() => true, 1);
    await registry.get("org_a"); await registry.get("org_b"); await registry.get("org_c");
    expect(dropped).toEqual([]);
    expect(registry.all()).toHaveLength(4);
  });

  it("builds again after a failed build", async () => {
    let fail = true;
    const registry = new TenantRegistry<{ id: string }>({ homeOrgId: "h", home: { id: "h" }, isKnown: async () => true,
      build: async orgId => { if (fail) throw new Error("db down"); return { id: orgId }; } });
    await expect(registry.get("org_a")).rejects.toThrow("db down");
    fail = false;
    expect((await registry.get("org_a"))?.id).toBe("org_a");
  });
});
