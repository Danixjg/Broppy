import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { User } from "@brain/types";
import { ServiceActor } from "./service-actor.js";

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
});
