import { describe, expect, it } from "vitest";
import type { SourcePermission, User } from "@brain/types";
import { FgaAdapter } from "./index.js";

const identities = (name: string) => ({ slack: `${name}@example.test`, jira: `${name}@example.test`, confluence: `${name}@example.test`, drive: `${name}@example.test` });
const permissions: SourcePermission = {
  users: ["eve@example.test"], groups: [], public: false,
  native: { source: "jira", projectKey: "SEC", projectViewers: ["eve@example.test"] }
};
const eve: User = { id: "eve", name: "Eve", email: "eve@example.test", role: "member", groups: [], contractor: false,
  platformIdentities: identities("eve"), auth0Sub: "auth0|eve", orgId: "o", active: true };
const now = new Date("2026-10-03T00:00:00Z");
const grant = { userId: "eve", owner: "maya", reason: "Incident review", expiresAt: "2026-10-10T00:00:00Z" };

function fga(tier: "open" | "internal" | "restricted" = "restricted") {
  const adapter = new FgaAdapter();
  adapter.upsert({ docId: "jira:SEC-1", permissions, tier });
  return adapter;
}

describe("explicit blocks", () => {
  it("win over a native allow and an approved restricted grant, and survive a source sync", () => {
    const adapter = fga();
    adapter.grantRestricted("jira:SEC-1", grant, now);
    expect(adapter.check(eve, "jira:SEC-1", now).allowed).toBe(true);
    adapter.block("jira:SEC-1", "eve");
    expect(adapter.check(eve, "jira:SEC-1", now)).toEqual({ docId: "jira:SEC-1", allowed: false, reason: "blocked" });
    adapter.upsert({ docId: "jira:SEC-1", permissions, tier: "restricted" });
    expect(adapter.check(eve, "jira:SEC-1", now).allowed).toBe(false);
    adapter.unblock("jira:SEC-1", "eve");
    expect(adapter.check(eve, "jira:SEC-1", now).allowed).toBe(true);
  });
});

describe("restricted grants", () => {
  it("are denied by tier until granted, then end at their expiry even before a sweep", () => {
    const adapter = fga();
    expect(adapter.check(eve, "jira:SEC-1", now).reason).toBe("tier");
    adapter.grantRestricted("jira:SEC-1", grant, now);
    expect(adapter.check(eve, "jira:SEC-1", new Date("2026-10-09T23:59:59Z")).allowed).toBe(true);
    expect(adapter.check(eve, "jira:SEC-1", new Date("2026-10-10T00:00:01Z")).allowed).toBe(false);
    expect(adapter.sweepExpired(new Date("2026-10-11T00:00:00Z"))).toEqual([expect.objectContaining({ docId: "jira:SEC-1", userId: "eve", owner: "maya" })]);
    expect(adapter.exceptions("jira:SEC-1")).toEqual([]);
  });

  it("need an owner, a reason, a future date within 90 days, and a restricted document", () => {
    const adapter = fga();
    expect(() => adapter.grantRestricted("jira:SEC-1", { ...grant, reason: "  " }, now)).toThrow("Invalid restricted grant");
    expect(() => adapter.grantRestricted("jira:SEC-1", { ...grant, owner: "" }, now)).toThrow("Invalid restricted grant");
    expect(() => adapter.grantRestricted("jira:SEC-1", { ...grant, expiresAt: "2026-10-02T00:00:00Z" }, now)).toThrow("Invalid restricted grant");
    expect(() => adapter.grantRestricted("jira:SEC-1", { ...grant, expiresAt: "2027-06-01T00:00:00Z" }, now)).toThrow("Invalid restricted grant");
    expect(() => fga("internal").grantRestricted("jira:SEC-1", grant, now)).toThrow("restricted");
  });

  it("never widen source permissions", () => {
    const adapter = fga();
    adapter.grantRestricted("jira:SEC-1", grant, now);
    const outsider = { ...eve, id: "zed", email: "zed@example.test", platformIdentities: identities("zed") };
    adapter.grantRestricted("jira:SEC-1", { ...grant, userId: "zed" }, now);
    expect(adapter.check(outsider, "jira:SEC-1", now).allowed).toBe(false);
  });
});
