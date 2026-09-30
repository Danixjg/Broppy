import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { User } from "@brain/types";
import type { UserDirectory } from "./user-directory.js";

interface Auth0Options {
  issuer: string;
  audience: string;
  directory: Pick<UserDirectory, "bySub">;
  orgId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Auth0TokenValidator {
  private readonly jwks;
  constructor(private readonly options: Auth0Options) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search ||
      issuer.hash || issuer.pathname !== "/" || options.issuer !== issuer.href || !options.audience || !options.orgId) {
      throw new Error("Invalid Auth0 configuration");
    }
    this.jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer), {
      ...(options.fetch ? { [customFetch]: options.fetch } : {})
    });
  }
  async validate(authorization: string | undefined): Promise<User> {
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    if (!match) throw new Error("Unauthorized");
    try {
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.options.issuer, audience: this.options.audience, algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "org_id"],
        currentDate: new Date((this.options.now ?? Date.now)())
      });
      if (payload.org_id !== this.options.orgId) throw new Error("Unauthorized");
      const user = await this.options.directory.bySub(payload.sub!);
      if (!user || user.active !== true || user.orgId !== payload.org_id) throw new Error("Unauthorized");
      return user;
    } catch { throw new Error("Unauthorized"); }
  }
}
export function createAuth0TokenValidatorFromEnv(directory: Pick<UserDirectory, "bySub">): Auth0TokenValidator {
  return new Auth0TokenValidator({ issuer: process.env.AUTH0_ISSUER ?? "", audience: process.env.AUTH0_AUDIENCE ?? "",
    orgId: process.env.AUTH0_ORG_ID ?? "", directory });
}
