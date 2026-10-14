import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "@brain/types";
import { AccessDenied, Auth0TokenValidator, WorkspaceUnavailable } from "./auth.js";

const issuer = "https://tenant.auth0.com/";
const audience = "https://brain.example/api";
const now = 1_800_000_000;
const user: User = {
  id: "ravi", name: "Ravi", email: "ravi@example.test", auth0Sub: "auth0|ravi",
  groups: [], role: "member", orgId: "org_company_a", active: true
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" };

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", ...header })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: user.auth0Sub, org_id: "org_company_a", exp: now + 60, ...claims
  })).toString("base64url");
  const data = `${encodedHeader}.${encodedPayload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}

function stubDirectory(users: User[]) {
  return {
    bySub: async (sub: string) => users.find(user => user.auth0Sub === sub),
    byEmail: async (email: string) => users.find(user => user.email === email.toLowerCase()),
    // Mirrors the database rule: only an active entry with no subject yet can be claimed.
    claim: async (email: string, sub: string) => {
      const entry = users.find(user => user.email === email.toLowerCase() && !user.auth0Sub && user.active === true);
      if (entry) entry.auth0Sub = sub;
      return entry;
    }
  };
}

function setup(jwks: unknown = { keys: [jwk] }, users: User[] = [user]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
  const validator = new Auth0TokenValidator({ issuer, audience, orgId: "org_company_a", directory: stubDirectory(users), now: () => now * 1000, fetch: fetcher as typeof fetch });
  return { fetcher, validator };
}

describe("Auth0TokenValidator", () => {
  it("verifies RS256 against tenant JWKS and maps only a known subject", async () => {
    const { validator, fetcher } = setup();
    expect(await validator.validate(`Bearer ${token({ aud: [audience, `${issuer}userinfo`] })}`)).toBe(user);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await validator.validate(`Bearer ${token()}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, unsigned, and tampered tokens before accepting identity", async () => {
    const { validator } = setup();
    const valid = token();
    const parts = valid.split(".");
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({
      iss: issuer, aud: audience, sub: user.auth0Sub, org_id: "org_company_a", exp: now + 1000
    })).toString("base64url")}.${parts[2]}`;
    for (const header of [undefined, valid, "Basic abc", "Bearer nonsense", `Bearer ${tampered}`,
      `Bearer ${token({}, { alg: "none" })}`]) {
      await expect(validator.validate(header)).rejects.toThrow("Unauthorized");
    }
  });

  it("rejects wrong issuer, audience, time claims, and unknown subjects", async () => {
    const { validator } = setup();
    for (const claims of [
      { iss: "https://other.auth0.com/" }, { aud: "other" }, { exp: now },
      { exp: undefined }, { org_id: "wrong" }, { org_id: undefined }, { nbf: now + 1 }, { sub: "auth0|unknown" }
    ]) {
      await expect(validator.validate(`Bearer ${token(claims)}`)).rejects.toThrow("Unauthorized");
    }
  });

  it("fails closed when JWKS is missing, mismatched, or unavailable", async () => {
    for (const jwks of [{ keys: [] }, { keys: [{ ...jwk, kid: "other" }] },
      { keys: [{ ...jwk, use: "enc" }] }, { keys: [jwk, jwk] }, {}]) {
      await expect(setup(jwks).validator.validate(`Bearer ${token()}`)).rejects.toThrow("Unauthorized");
    }
    const fetcher = vi.fn(async () => { throw new Error("network details"); });
    const validator = new Auth0TokenValidator({ issuer, audience, orgId: "org_company_a", directory: stubDirectory([user]), fetch: fetcher as typeof fetch });
    await expect(validator.validate(`Bearer ${token()}`)).rejects.toThrow("Unauthorized");
  });

  it("requires an HTTPS tenant issuer and configured audience", () => {
    expect(() => new Auth0TokenValidator({ issuer: "http://tenant.auth0.com/", audience, orgId: "org_company_a", directory: stubDirectory([]) })).toThrow();
    expect(() => new Auth0TokenValidator({ issuer, audience: "", orgId: "org_company_a", directory: stubDirectory([]) })).toThrow();
  });
});

it("rejects directory organisation mismatch, and tells a removed person they were removed", async () => {
  await expect(setup(undefined, [{ ...user, orgId: "other" }]).validator.validate(`Bearer ${token()}`)).rejects.toThrow("Unauthorized");
  await expect(setup(undefined, [{ ...user, active: false }]).validator.validate(`Bearer ${token()}`)).rejects.toMatchObject({ code: "removed" });
});

describe("first sign-in of an admin-added person", () => {
  const invited = (): User => ({ id: "priya", name: "Priya", email: "priya@company.test", auth0Sub: "", groups: [], role: "member", orgId: "org_company_a", active: true });
  const priya = (claims: Record<string, unknown> = {}) => `Bearer ${token({ sub: "auth0|priya", ...claims })}`;
  function withUserinfo(profile: Record<string, unknown> | number, users: User[], onFirstSignIn?: (user: User) => Promise<void>) {
    const userinfo = vi.fn(async () => typeof profile === "number" ? new Response("{}", { status: profile }) : Response.json(profile));
    const fetcher = vi.fn(async (input: URL | RequestInfo) => String(input).endsWith("/userinfo") ? userinfo() : Response.json({ keys: [jwk] }));
    const validator = new Auth0TokenValidator({ issuer, audience, orgId: "org_company_a", directory: stubDirectory(users), now: () => now * 1000, fetch: fetcher as typeof fetch, onFirstSignIn });
    return { validator, userinfo };
  }

  it("links the entry for their verified email to their Auth0 subject, once", async () => {
    const users = [user, invited()];
    const { validator, userinfo } = withUserinfo({ email: "Priya@Company.test", email_verified: true }, users);
    expect(await validator.validate(priya())).toMatchObject({ id: "priya", auth0Sub: "auth0|priya" });
    expect(users[1].auth0Sub).toBe("auth0|priya");
    expect(await validator.validate(priya())).toMatchObject({ id: "priya" });
    expect(userinfo).toHaveBeenCalledTimes(1);
  });

  it("runs the first-sign-in step once, and a failure in it never blocks the sign-in", async () => {
    const seen = vi.fn(async (_person: User) => { throw new Error("source down"); });
    const { validator } = withUserinfo({ email: "priya@company.test", email_verified: true }, [user, invited()], seen);
    expect(await validator.validate(priya())).toMatchObject({ id: "priya", auth0Sub: "auth0|priya" });
    await validator.validate(priya());
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({ id: "priya", auth0Sub: "auth0|priya" });
  });

  it("turns away an email the admin did not add, and remembers the refusal briefly", async () => {
    const { validator, userinfo } = withUserinfo({ email: "stranger@company.test", email_verified: true }, [user, invited()]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(validator.validate(priya())).rejects.toMatchObject({ code: "not_added" });
    }
    expect(userinfo).toHaveBeenCalledTimes(1);
  });

  it("does not let an unverified email claim an entry", async () => {
    const users = [invited()];
    const { validator } = withUserinfo({ email: "priya@company.test", email_verified: false }, users);
    await expect(validator.validate(priya())).rejects.toMatchObject({ code: "email_unverified" });
    expect(users[0].auth0Sub).toBe("");
  });

  it("does not let a second Auth0 account take an entry that is already linked", async () => {
    const { validator } = withUserinfo({ email: "ravi@example.test", email_verified: true }, [user]);
    await expect(validator.validate(priya())).rejects.toMatchObject({ code: "email_in_use" });
  });

  it("does not claim a removed entry", async () => {
    const { validator } = withUserinfo({ email: "priya@company.test", email_verified: true }, [{ ...invited(), active: false }]);
    await expect(validator.validate(priya())).rejects.toMatchObject({ code: "removed" });
  });

  it("fails closed, without a reason, when Auth0 gives no profile", async () => {
    for (const profile of [500, { email_verified: true }]) {
      const rejection = withUserinfo(profile, [invited()]).validator.validate(priya());
      await expect(rejection).rejects.toThrow("Unauthorized");
      await expect(rejection).rejects.not.toBeInstanceOf(AccessDenied);
    }
  });
});

describe("Auth0TokenValidator with several companies", () => {
  const other: User = { ...user, id: "dana", auth0Sub: "auth0|dana", email: "dana@acme.test", orgId: "org_acme" };
  function several() {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    const directories: Record<string, ReturnType<typeof stubDirectory>> = { org_company_a: stubDirectory([user]), org_acme: stubDirectory([other]) };
    return new Auth0TokenValidator({ issuer, audience, directoryFor: async orgId => directories[orgId], now: () => now * 1000, fetch: fetcher as typeof fetch });
  }

  it("looks each person up in the company named by their token, and nowhere else", async () => {
    const validator = several();
    expect(await validator.validate(`Bearer ${token({ sub: "auth0|dana", org_id: "org_acme" })}`)).toBe(other);
    expect(await validator.validate(`Bearer ${token()}`)).toBe(user);
    // Dana's subject under the other company's name, or a company that is not listed, finds no one.
    await expect(validator.validate(`Bearer ${token({ sub: "auth0|dana", org_id: "org_company_a" })}`)).rejects.toThrow();
    await expect(validator.validate(`Bearer ${token({ org_id: "org_unlisted" })}`)).rejects.toThrow("Unauthorized");
  });

  it("says the workspace couldn't load, rather than refusing the person, when loading it fails", async () => {
    const flaky = new Auth0TokenValidator({ issuer, audience, directoryFor: async () => { throw new Error("Supabase organizations failed (504)"); },
      now: () => now * 1000, fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch });
    await expect(flaky.validate(`Bearer ${token({ sub: "auth0|dana", org_id: "org_acme" })}`)).rejects.toBeInstanceOf(WorkspaceUnavailable);
    // A bad token is still a refusal.
    await expect(flaky.validate("Bearer not-a-token")).rejects.toThrow("Unauthorized");
  });

  it("refuses a directory entry that belongs to a different company than the token", async () => {
    const wrong = new Auth0TokenValidator({ issuer, audience, directoryFor: async () => stubDirectory([{ ...other, orgId: "org_other" }]),
      now: () => now * 1000, fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch });
    await expect(wrong.validate(`Bearer ${token({ sub: "auth0|dana", org_id: "org_acme" })}`)).rejects.toThrow("Unauthorized");
  });
});
