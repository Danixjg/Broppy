import { nativeAllows } from "@brain/connectors";
import type { AccessDecision, SourceDocument, SourcePermission, Tier, User } from "@brain/types";
export { RemoteFgaAdapter } from "./remote.js";
export type { RemoteFgaConfig } from "./remote.js";

const tierOrder: Record<Tier, number> = {
  open: 0,
  internal: 1,
  restricted: 2
};

export function tierAllows(user: User, tier: Tier): boolean {
  if (user.contractor) return tier !== "restricted";
  if (tier === "open") return true;
  if (tier === "internal") return !user.groups.includes("interns");
  return user.groups.includes("security") ||
    user.groups.includes("fraud-ops") ||
    user.groups.includes("compliance");
}

/** Access to one restricted document for someone the tier would keep out. It always names who approved it and why,
 * and it ends. It never widens source permissions, only the tier check. */
export interface RestrictedGrant { userId: string; owner: string; reason: string; expiresAt: string }

/** `blocked` holds people an admin has explicitly shut out of a document. A block wins over every allow. */
type Grant = { permissions: SourcePermission; tier: Tier; blocked?: string[]; exceptions?: RestrictedGrant[] };

export const MAX_RESTRICTED_GRANT_MS = 90 * 24 * 60 * 60 * 1000;

export class FgaAdapter {
  snapshot() { return [...this.grants.entries()]; }
  restore(grants: Array<[string, Grant]>) { this.grants = new Map(grants); }
  private grants = new Map<string, Grant>();

  upsert(doc: Pick<SourceDocument, "docId" | "permissions" | "tier">): void {
    const existing = this.grants.get(doc.docId);
    const tier = existing && tierOrder[existing.tier] > tierOrder[doc.tier]
      ? existing.tier
      : doc.tier;
    // A source sync replaces permissions, never an admin's blocks or approved exceptions.
    this.grants.set(doc.docId, {
      permissions: structuredClone(doc.permissions),
      tier,
      ...(existing?.blocked ? { blocked: existing.blocked } : {}),
      ...(existing?.exceptions ? { exceptions: existing.exceptions } : {})
    });
  }

  block(docId: string, userId: string): void {
    const grant = this.grants.get(docId);
    if (!grant) throw new Error("Unknown document");
    if (!grant.blocked?.includes(userId)) this.grants.set(docId, { ...grant, blocked: [...(grant.blocked ?? []), userId] });
  }

  unblock(docId: string, userId: string): void {
    const grant = this.grants.get(docId);
    if (!grant) throw new Error("Unknown document");
    this.grants.set(docId, { ...grant, blocked: (grant.blocked ?? []).filter(id => id !== userId) });
  }

  grantRestricted(docId: string, grant: RestrictedGrant, now = new Date()): void {
    const current = this.grants.get(docId);
    if (!current) throw new Error("Unknown document");
    if (current.tier !== "restricted") throw new Error("Only restricted documents take a restricted grant");
    const expires = Date.parse(grant.expiresAt);
    if (!grant.owner || !grant.reason.trim() || !Number.isFinite(expires) || expires <= now.getTime() ||
      expires - now.getTime() > MAX_RESTRICTED_GRANT_MS) throw new Error("Invalid restricted grant");
    const others = (current.exceptions ?? []).filter(item => item.userId !== grant.userId);
    this.grants.set(docId, { ...current, exceptions: [...others, { ...grant, expiresAt: new Date(expires).toISOString() }] });
  }

  /** Drops expired restricted grants and returns them. Expiry is also enforced on every check, so a late sweep never extends access. */
  sweepExpired(now = new Date()): Array<RestrictedGrant & { docId: string }> {
    const expired: Array<RestrictedGrant & { docId: string }> = [];
    for (const [docId, grant] of this.grants) {
      const live = (grant.exceptions ?? []).filter(item => Date.parse(item.expiresAt) > now.getTime());
      for (const item of grant.exceptions ?? []) if (!live.includes(item)) expired.push({ docId, ...item });
      if (live.length !== (grant.exceptions ?? []).length) this.grants.set(docId, { ...grant, exceptions: live });
    }
    return expired;
  }

  exceptions(docId: string): RestrictedGrant[] {
    return structuredClone(this.grants.get(docId)?.exceptions ?? []);
  }

  remove(docId: string): void {
    this.grants.delete(docId);
  }

  narrowTier(docId: string, tier: Tier): void {
    const grant = this.grants.get(docId);
    if (!grant) throw new Error("Unknown document");
    if (tierOrder[tier] < tierOrder[grant.tier]) {
      throw new Error("Admin tier may only narrow access");
    }
    this.grants.set(docId, { ...grant, tier });
  }

  check(user: User, docId: string, now = new Date()): AccessDecision {
    const grant = this.grants.get(docId);
    if (!grant || !nativeAllows(user, grant.permissions)) {
      return { docId, allowed: false, reason: "fga" };
    }
    if (grant.blocked?.includes(user.id)) return { docId, allowed: false, reason: "blocked" };
    if (!tierAllows(user, grant.tier)) {
      const approved = grant.tier === "restricted" && grant.exceptions?.some(item =>
        item.userId === user.id && Date.parse(item.expiresAt) > now.getTime());
      if (!approved) return { docId, allowed: false, reason: "tier" };
    }
    return { docId, allowed: true, reason: "fga" };
  }

  batchCheck(user: User, docIds: string[], now = new Date()): AccessDecision[] {
    return [...new Set(docIds)].map(id => this.check(user, id, now));
  }

  effectiveTier(docId: string): Tier | undefined {
    return this.grants.get(docId)?.tier;
  }
}
