import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { User } from "@brain/types";
import type { UserDirectory } from "./user-directory.js";

const SERVICE = "x-broppy-service";
const ACT_AS = "x-act-as-slack-email";
const ORG = "x-broppy-org";

/**
 * The service secret for one company's Slack installation, derived from SLACK_SERVICE_TOKEN. Each installation is given
 * only its own company's secret, so a secret read from one company's installation can't act as anyone in another.
 */
export const companyServiceToken = (secret: string, orgId: string): string =>
  createHmac("sha256", secret).update(`broppy-slack-service:${orgId}`).digest("base64url");

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Lets the Slack app ask questions as a person. Slack signs requests with a Slack user ID but gives no Auth0 token, so
 * the app presents a shared secret and the email Slack holds for that user; the directory's Slack identity (platform_identities.slack) says which Broppy user it belongs to. The result is
 * that user's own record, so every permission check runs exactly as if they had asked. An email the directory doesn't
 * map to exactly one active user gets nothing. server.ts allows this identity on POST /v1/query only.
 */
export class ServiceActor {
  private readonly secret: Buffer;
  constructor(private readonly rawSecret: string, private readonly directory: Pick<UserDirectory, "bySlackIdentity">,
    private readonly homeOrgId = "", private readonly directoryFor?: (orgId: string) => Pick<UserDirectory, "bySlackIdentity">) {
    if (rawSecret.length < 32) throw new Error("SLACK_SERVICE_TOKEN must be at least 32 characters");
    this.secret = digest(rawSecret);
  }

  static fromEnv(directory: UserDirectory | undefined): ServiceActor | undefined {
    const secret = process.env.SLACK_SERVICE_TOKEN;
    if (!secret) return undefined;
    if (!directory) throw new Error("SLACK_SERVICE_TOKEN requires the Supabase user directory");
    return new ServiceActor(secret, directory, process.env.AUTH0_ORG_ID ?? "", orgId => directory.forOrg(orgId));
  }

  /** True when the request asks to be treated as the service, whether or not the secret is right. */
  present(request: IncomingMessage): boolean {
    return request.headers[SERVICE] !== undefined;
  }

  /**
   * The person the Slack app is acting as. Without a company, or naming the home company, it is the home company's
   * secret and directory, as before. Another company must present the secret derived for that company, and the person
   * is looked up in that company's directory only.
   */
  async resolve(request: IncomingMessage): Promise<User | undefined> {
    const token = request.headers[SERVICE];
    const email = request.headers[ACT_AS];
    const org = request.headers[ORG];
    if (typeof token !== "string" || typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) return undefined;
    if (org !== undefined && (typeof org !== "string" || !/^org_[A-Za-z0-9]{1,64}$/.test(org))) return undefined;
    const home = org === undefined || org === this.homeOrgId;
    if (!home && !this.directoryFor) return undefined;
    const expected = home ? this.secret : digest(companyServiceToken(this.rawSecret, org!));
    if (!timingSafeEqual(digest(token), expected)) return undefined;
    const user = await (home ? this.directory : this.directoryFor!(org!)).bySlackIdentity(email);
    if (user?.active !== true) return undefined;
    // The directory is scoped to the company already; this holds even if a lookup were ever widened.
    if (!home && user.orgId !== org) return undefined;
    return user;
  }
}
