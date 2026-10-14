import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { User } from "@brain/types";
import type { UserDirectory } from "./user-directory.js";

/**
 * A valid organization sign-in that Broppy will not let in, with a reason the person can act on. The reasons tell nothing
 * about the configuration: only that this account has not been added, was removed, or needs its email verified.
 */
/** The person's sign-in was fine, but their company's workspace couldn't be loaded just now. */
export class WorkspaceUnavailable extends Error {
  constructor(problem?: unknown) {
    super("Workspace unavailable");
    console.error(JSON.stringify({ event: "workspace_unavailable", reason: problem instanceof Error ? problem.message.slice(0, 200) : "unknown" }));
  }
}

/** Why a sign-in was refused, in a word, for the host's log; never the token or who it was. */
const refusal = (reason: string) => console.warn(JSON.stringify({ event: "sign_in_refused", reason }));

export class AccessDenied extends Error {
  constructor(readonly code: "not_added" | "removed" | "email_unverified" | "email_in_use", message: string) { super(message); }
}
const DENIED = {
  not_added: "Your email isn't on your company's Broppy list yet. Ask your Broppy admin to add your work email, then sign in again.",
  removed: "Your access to Broppy was removed. Ask your Broppy admin if this is a mistake.",
  email_unverified: "Verify your email first: open the verification email from Auth0, then sign in again.",
  email_in_use: "Your work email is already linked to a different sign-in. Ask your Broppy admin for help."
} as const;
const deny = (code: keyof typeof DENIED) => new AccessDenied(code, DENIED[code]);
// A refused first sign-in asks Auth0 for the email; remember the answer briefly so retries don't each cost a call.
const REFUSAL_MEMORY_MS = 30_000;

type Directory = Pick<UserDirectory, "bySub" | "byEmail" | "claim">;

interface Auth0Options {
  issuer: string;
  audience: string;
  /** The one company's list of people, when this API serves a single company. */
  directory?: Directory;
  orgId?: string;
  /** Several companies: the list of people for an organization, or nothing when it is not one of ours. */
  directoryFor?: (orgId: string) => Promise<Directory | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Runs once, right after someone's first sign-in links to the entry the admin added. A failure never blocks the sign-in. */
  onFirstSignIn?: (user: User) => Promise<void>;
}

export class Auth0TokenValidator {
  private readonly jwks;
  private readonly refused = new Map<string, { until: number; error: AccessDenied }>();
  constructor(private readonly options: Auth0Options) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search ||
      issuer.hash || issuer.pathname !== "/" || options.issuer !== issuer.href || !options.audience ||
      (!options.directoryFor && !(options.orgId && options.directory))) {
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
      const orgId = payload.org_id;
      if (typeof orgId !== "string") throw new Error("Unauthorized");
      let directory: Directory | undefined;
      // Loading the company's workspace can fail for reasons that have nothing to do with this person (a database
      // timeout, a source that won't answer). That is reported as such, not as a refused sign-in.
      try { directory = await this.directoryFor(orgId); }
      catch (error) { throw new WorkspaceUnavailable(error); }
      if (!directory) { refusal("company_not_listed"); throw new Error("Unauthorized"); }
      const known = await directory.bySub(payload.sub!);
      if (known) {
        if (known.orgId !== orgId) throw new Error("Unauthorized");
        if (known.active !== true) throw deny("removed");
        return known;
      }
      return await this.firstSignIn(payload.sub!, match[1], orgId, directory);
    } catch (error) {
      if (error instanceof AccessDenied || error instanceof WorkspaceUnavailable) throw error;
      // jose names what was wrong with a token (expired, wrong audience, bad signature); nothing from the token is logged.
      if (error && typeof error === "object" && "code" in error && typeof error.code === "string") refusal(error.code);
      throw new Error("Unauthorized");
    }
  }

  /**
   * Someone with a valid organization token who has no directory entry yet: the entry the admin added for their verified
   * email becomes theirs. Anyone else is turned away, so being a member of the organization alone is not enough.
   */
  private async directoryFor(orgId: string): Promise<Directory | undefined> {
    if (this.options.directoryFor) return this.options.directoryFor(orgId);
    return orgId === this.options.orgId ? this.options.directory : undefined;
  }

  private async firstSignIn(sub: string, token: string, orgId: string, directory: Directory): Promise<User> {
    const now = (this.options.now ?? Date.now)();
    // Remembered per company, because one Auth0 account can belong to several.
    const memory = `${orgId}/${sub}`;
    const remembered = this.refused.get(memory);
    if (remembered && remembered.until > now) throw remembered.error;
    const profile = await this.profile(token);
    if (!profile.email) throw new Error("Unauthorized");
    if (!profile.verified) throw this.refuse(memory, now, deny("email_unverified"));
    const claimed = await directory.claim(profile.email, sub);
    if (claimed) {
      if (claimed.orgId !== orgId) throw new Error("Unauthorized");
      this.refused.delete(memory);
      try { await this.options.onFirstSignIn?.(claimed); } catch { /* The hourly pass still brings their access in. */ }
      return claimed;
    }
    const entry = await directory.byEmail(profile.email);
    throw this.refuse(memory, now, deny(!entry ? "not_added" : entry.active !== true ? "removed" : "email_in_use"));
  }

  private refuse(memory: string, now: number, error: AccessDenied): AccessDenied {
    if (this.refused.size > 1000) this.refused.clear();
    this.refused.set(memory, { until: now + REFUSAL_MEMORY_MS, error });
    return error;
  }

  private async profile(token: string): Promise<{ email?: string; verified: boolean }> {
    const response = await (this.options.fetch ?? fetch)(new URL("userinfo", this.options.issuer), {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("Unauthorized");
    const info = await response.json() as { email?: unknown; email_verified?: unknown };
    return { email: typeof info.email === "string" && info.email ? info.email : undefined, verified: info.email_verified === true };
  }
}
export function createAuth0TokenValidatorFromEnv(directoryFor: (orgId: string) => Promise<Directory | undefined>,
  onFirstSignIn?: (user: User) => Promise<void>): Auth0TokenValidator {
  return new Auth0TokenValidator({ issuer: process.env.AUTH0_ISSUER ?? "", audience: process.env.AUTH0_AUDIENCE ?? "", directoryFor, onFirstSignIn });
}
