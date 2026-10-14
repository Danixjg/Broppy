import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { User } from "@brain/types";
import { companyServiceToken, ServiceActor } from "./service-actor.js";

const SECRET = "x".repeat(32);
const maya: User = { id: "maya", name: "Maya", email: "m@x.test", auth0Sub: "auth0|m", active: true, groups: [], role: "member", platformIdentities: { slack: "m@x.test" } as User["platformIdentities"] };
const directory = { bySlackIdentity: async (id: string) => id === "m@x.test" ? maya : id === "gone@x.test" ? { ...maya, active: false } : undefined };
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe("ServiceActor", () => {
  const actor = new ServiceActor(SECRET, directory);
  it("acts as the user the directory maps the Slack email to", async () => {
    expect(await actor.resolve(req({ "x-broppy-service": SECRET, "x-act-as-slack-email": "m@x.test" }))).toEqual(maya);
  });
  it("refuses a wrong secret, an unmapped or inactive user, and a malformed email", async () => {
    expect(await actor.resolve(req({ "x-broppy-service": "y".repeat(32), "x-act-as-slack-email": "m@x.test" }))).toBeUndefined();
    expect(await actor.resolve(req({ "x-broppy-service": SECRET, "x-act-as-slack-email": "nobody@x.test" }))).toBeUndefined();
    expect(await actor.resolve(req({ "x-broppy-service": SECRET, "x-act-as-slack-email": "gone@x.test" }))).toBeUndefined();
    expect(await actor.resolve(req({ "x-broppy-service": SECRET, "x-act-as-slack-email": "maya" }))).toBeUndefined();
    expect(await actor.resolve(req({ "x-broppy-service": SECRET }))).toBeUndefined();
  });
  it("flags any request that asks to be the service, even with a wrong secret", () => {
    expect(actor.present(req({ "x-broppy-service": "" }))).toBe(true);
    expect(actor.present(req({}))).toBe(false);
  });
  it("rejects a short secret", () => {
    expect(() => new ServiceActor("short", directory)).toThrow("at least 32");
  });
  it("accepts another company's own derived secret, and looks the person up in that company only", async () => {
    const lee: User = { ...maya, id: "lee", orgId: "org_acme1", platformIdentities: { slack: "lee@acme.test" } as User["platformIdentities"] };
    const asked: string[] = [];
    const companies = new ServiceActor(SECRET, directory, "org_home1", org => {
      asked.push(org);
      return { bySlackIdentity: async (id: string) => org === "org_acme1" && id === "lee@acme.test" ? lee : undefined };
    });
    const acme = companyServiceToken(SECRET, "org_acme1");
    expect(acme).not.toBe(companyServiceToken(SECRET, "org_other1"));
    expect(await companies.resolve(req({ "x-broppy-service": acme, "x-broppy-org": "org_acme1", "x-act-as-slack-email": "lee@acme.test" }))).toEqual(lee);
    // The plain secret, another company's secret, a malformed company and the home company with a derived secret are all refused.
    expect(await companies.resolve(req({ "x-broppy-service": SECRET, "x-broppy-org": "org_acme1", "x-act-as-slack-email": "lee@acme.test" }))).toBeUndefined();
    expect(await companies.resolve(req({ "x-broppy-service": companyServiceToken(SECRET, "org_other1"), "x-broppy-org": "org_acme1", "x-act-as-slack-email": "lee@acme.test" }))).toBeUndefined();
    expect(await companies.resolve(req({ "x-broppy-service": acme, "x-broppy-org": "acme", "x-act-as-slack-email": "lee@acme.test" }))).toBeUndefined();
    expect(await companies.resolve(req({ "x-broppy-service": acme, "x-broppy-org": "org_home1", "x-act-as-slack-email": "m@x.test" }))).toBeUndefined();
    // The home company keeps working with the plain secret, with or without naming itself.
    expect(await companies.resolve(req({ "x-broppy-service": SECRET, "x-broppy-org": "org_home1", "x-act-as-slack-email": "m@x.test" }))).toEqual(maya);
    expect(asked).toEqual(["org_acme1"]);
  });
  it("refuses a person the company's directory returns from another company", async () => {
    const stray = new ServiceActor(SECRET, directory, "org_home1", () => ({ bySlackIdentity: async () => ({ ...maya, orgId: "org_other1" }) }));
    expect(await stray.resolve(req({ "x-broppy-service": companyServiceToken(SECRET, "org_acme1"), "x-broppy-org": "org_acme1", "x-act-as-slack-email": "m@x.test" }))).toBeUndefined();
  });
});
