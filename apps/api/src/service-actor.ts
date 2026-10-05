import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { User } from "@brain/types";
import type { UserDirectory } from "./user-directory.js";

const SERVICE = "x-broppy-service";
const ACT_AS = "x-act-as-slack-email";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Lets the Slack app ask questions as a person. Slack signs requests with a Slack user ID but gives no Auth0 token, so
 * the app presents a shared secret and the email Slack holds for that user; the directory's Slack identity (platform_identities.slack) says which Broppy user it belongs to. The result is
 * that user's own record, so every permission check runs exactly as if they had asked. An email the directory doesn't
 * map to exactly one active user gets nothing. server.ts allows this identity on POST /v1/query only.
 */
export class ServiceActor {
  private readonly secret: Buffer;
  constructor(secret: string, private readonly directory: Pick<UserDirectory, "bySlackIdentity">) {
    if (secret.length < 32) throw new Error("SLACK_SERVICE_TOKEN must be at least 32 characters");
    this.secret = digest(secret);
  }

  static fromEnv(directory: UserDirectory | undefined): ServiceActor | undefined {
    const secret = process.env.SLACK_SERVICE_TOKEN;
    if (!secret) return undefined;
    if (!directory) throw new Error("SLACK_SERVICE_TOKEN requires the Supabase user directory");
    return new ServiceActor(secret, directory);
  }

  /** True when the request asks to be treated as the service, whether or not the secret is right. */
  present(request: IncomingMessage): boolean {
    return request.headers[SERVICE] !== undefined;
  }

  async resolve(request: IncomingMessage): Promise<User | undefined> {
    const token = request.headers[SERVICE];
    const email = request.headers[ACT_AS];
    if (typeof token !== "string" || typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) return undefined;
    if (!timingSafeEqual(digest(token), this.secret)) return undefined;
    const user = await this.directory.bySlackIdentity(email);
    return user?.active === true ? user : undefined;
  }
}
