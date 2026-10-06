import { core, NativePolicy } from "@brain/rust-core";
import type { AccessDecision, SourceDocument, SourcePermission, Tier, User } from "@brain/types";
export { RemoteFgaAdapter } from "./remote.js";
export type { RemoteFgaConfig } from "./remote.js";

export function tierAllows(user: User, tier: Tier): boolean {
  return core<boolean>("policy.tierAllows", { user, tier });
}

/** Access to one restricted document for someone the tier would keep out. It always names who approved it and why,
 * and it ends. It never widens source permissions, only the tier check. */
export interface RestrictedGrant { userId: string; owner: string; reason: string; expiresAt: string }

type Grant = { permissions: SourcePermission; tier: Tier; blocked?: string[]; exceptions?: RestrictedGrant[] };

export const MAX_RESTRICTED_GRANT_MS = 90 * 24 * 60 * 60 * 1000;

export class FgaAdapter {
  private readonly policy = new NativePolicy();

  snapshot(): Array<[string, Grant]> {
    return this.policy.execute<Array<[string, Grant]>>("snapshot", {});
  }

  restore(grants: Array<[string, Grant]>): void {
    this.policy.execute("restore", { grants });
  }

  upsert(doc: Pick<SourceDocument, "docId" | "permissions" | "tier">): void {
    this.policy.execute("upsert", { doc });
  }

  block(docId: string, userId: string): void {
    this.policy.execute("block", { docId, userId });
  }

  unblock(docId: string, userId: string): void {
    this.policy.execute("unblock", { docId, userId });
  }

  grantRestricted(docId: string, grant: RestrictedGrant, now = new Date()): void {
    this.policy.execute("grantRestricted", { docId, grant, expiresAtMs: Date.parse(grant.expiresAt), now: now.getTime() });
  }

  /** Drops expired restricted grants and returns them. Expiry is also enforced on every check, so a late sweep never extends access. */
  sweepExpired(now = new Date()): Array<RestrictedGrant & { docId: string }> {
    return this.policy.execute<Array<RestrictedGrant & { docId: string }>>("sweepExpired", { now: now.getTime() });
  }

  exceptions(docId: string): RestrictedGrant[] {
    return this.policy.execute<RestrictedGrant[]>("exceptions", { docId });
  }

  remove(docId: string): void {
    this.policy.execute("remove", { docId });
  }

  narrowTier(docId: string, tier: Tier): void {
    this.policy.execute("narrowTier", { docId, tier });
  }

  check(user: User, docId: string, now = new Date()): AccessDecision {
    return this.policy.execute<AccessDecision>("check", { user, docId, now: now.getTime() });
  }

  batchCheck(user: User, docIds: string[], now = new Date()): AccessDecision[] {
    return this.policy.execute<AccessDecision[]>("batchCheck", { user, docIds, now: now.getTime() });
  }

  effectiveTier(docId: string): Tier | undefined {
    return this.policy.execute<Tier | null>("effectiveTier", { docId }) ?? undefined;
  }
}
