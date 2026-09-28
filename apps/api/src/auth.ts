import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { User } from "@brain/types";

interface Auth0Options {
  issuer: string;
  audience: string;
  users: readonly User[];
  fetch?: typeof fetch;
  now?: () => number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodePart(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

export class Auth0TokenValidator {
  private readonly jwksUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: Auth0Options) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search ||
      issuer.hash || issuer.pathname !== "/" || options.issuer !== issuer.href || !options.audience) {
      throw new Error("Invalid Auth0 configuration");
    }
    this.jwksUrl = new URL("/.well-known/jwks.json", issuer).href;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async validate(authorization: string | undefined): Promise<User> {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!match) throw new Error("Unauthorized");

    try {
      const [encodedHeader, encodedPayload, encodedSignature] = match[1].split(".");
      const header = decodePart(encodedHeader);
      const payload = decodePart(encodedPayload);
      if (!record(header) || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
        !record(payload) || payload.iss !== this.options.issuer ||
        !(payload.aud === this.options.audience ||
          (Array.isArray(payload.aud) && payload.aud.includes(this.options.audience))) ||
        typeof payload.exp !== "number" || !Number.isInteger(payload.exp) ||
        payload.exp <= Math.floor(this.now() / 1000) ||
        (payload.nbf !== undefined && (typeof payload.nbf !== "number" ||
          !Number.isInteger(payload.nbf) || payload.nbf > Math.floor(this.now() / 1000))) ||
        typeof payload.sub !== "string" || !payload.sub) {
        throw new Error("Unauthorized");
      }

      const response = await this.fetcher(this.jwksUrl, { redirect: "error" });
      if (!response.ok) throw new Error("Unauthorized");
      const jwks: unknown = await response.json();
      if (!record(jwks) || !Array.isArray(jwks.keys)) throw new Error("Unauthorized");
      const keys = jwks.keys.filter((key: unknown) => record(key) && key.kid === header.kid &&
        key.kty === "RSA" && key.use === "sig" && (key.alg === undefined || key.alg === "RS256") &&
        typeof key.n === "string" && typeof key.e === "string");
      if (keys.length !== 1) throw new Error("Unauthorized");
      const publicKey = createPublicKey({ key: keys[0] as JsonWebKey, format: "jwk" });
      const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
      const signature = Buffer.from(encodedSignature, "base64url");
      if (!verify("RSA-SHA256", signed, publicKey, signature)) throw new Error("Unauthorized");

      const user = this.options.users.find(item => item.auth0Sub === payload.sub);
      if (!user) throw new Error("Unauthorized");
      return user;
    } catch {
      throw new Error("Unauthorized");
    }
  }
}

export function createAuth0TokenValidatorFromEnv(users: readonly User[]): Auth0TokenValidator {
  return new Auth0TokenValidator({
    issuer: process.env.AUTH0_ISSUER ?? "",
    audience: process.env.AUTH0_AUDIENCE ?? "",
    users
  });
}
