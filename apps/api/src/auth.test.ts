import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "@brain/types";
import { Auth0TokenValidator } from "./auth.js";

const issuer = "https://tenant.auth0.com/";
const audience = "https://brain.example/api";
const now = 1_800_000_000;
const user: User = {
  id: "ravi", name: "Ravi", email: "ravi@example.test", auth0Sub: "auth0|ravi",
  groups: [], role: "member"
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" };

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", ...header })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: user.auth0Sub, exp: now + 60, ...claims
  })).toString("base64url");
  const data = `${encodedHeader}.${encodedPayload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}

function setup(jwks: unknown = { keys: [jwk] }, users: User[] = [user]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
  const validator = new Auth0TokenValidator({ issuer, audience, users, now: () => now * 1000, fetch: fetcher as typeof fetch });
  return { fetcher, validator };
}

describe("Auth0TokenValidator", () => {
  it("verifies RS256 against tenant JWKS and maps only a known subject", async () => {
    const { validator, fetcher } = setup();
    expect(await validator.validate(`Bearer ${token({ aud: [audience, `${issuer}userinfo`] })}`)).toBe(user);
    expect(fetcher).toHaveBeenCalledWith(`${issuer}.well-known/jwks.json`, { redirect: "error" });
  });

  it("rejects malformed, unsigned, and tampered tokens before accepting identity", async () => {
    const { validator } = setup();
    const valid = token();
    const parts = valid.split(".");
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({
      iss: issuer, aud: audience, sub: user.auth0Sub, exp: now + 1000
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
      { exp: undefined }, { nbf: now + 1 }, { sub: "auth0|unknown" }
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
    const validator = new Auth0TokenValidator({ issuer, audience, users: [user], fetch: fetcher as typeof fetch });
    await expect(validator.validate(`Bearer ${token()}`)).rejects.toThrow("Unauthorized");
  });

  it("requires an HTTPS tenant issuer and configured audience", () => {
    expect(() => new Auth0TokenValidator({ issuer: "http://tenant.auth0.com/", audience, users: [] })).toThrow();
    expect(() => new Auth0TokenValidator({ issuer, audience: "", users: [] })).toThrow();
  });
});
