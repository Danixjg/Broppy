import { nativeAllows } from "@brain/connectors";
import type { AccessDecision, SourceDocument, SourcePermission, Tier, User } from "@brain/types";

const tierOrder: Record<Tier, number> = {
  open: 0,
  internal: 1,
  restricted: 2
};

export function tierAllows(user: User, tier: Tier): boolean {
  if (user.contractor) return false;
  if (tier === "open") return true;
  if (tier === "internal") return !user.groups.includes("interns");
  return user.groups.includes("security") ||
    user.groups.includes("fraud-ops") ||
    user.groups.includes("compliance");
}

type Grant = { permissions: SourcePermission; tier: Tier };

export class FgaAdapter {
  private grants = new Map<string, Grant>();

  upsert(doc: Pick<SourceDocument, "docId" | "permissions" | "tier">): void {
    const existing = this.grants.get(doc.docId);
    const tier = existing && tierOrder[existing.tier] > tierOrder[doc.tier]
      ? existing.tier
      : doc.tier;
    this.grants.set(doc.docId, {
      permissions: structuredClone(doc.permissions),
      tier
    });
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

  check(user: User, docId: string): AccessDecision {
    const grant = this.grants.get(docId);
    if (!grant || !nativeAllows(user, grant.permissions)) {
      return { docId, allowed: false, reason: "fga" };
    }
    if (!tierAllows(user, grant.tier)) {
      return { docId, allowed: false, reason: "tier" };
    }
    return { docId, allowed: true, reason: "fga" };
  }

  batchCheck(user: User, docIds: string[]): AccessDecision[] {
    return [...new Set(docIds)].map(id => this.check(user, id));
  }

  effectiveTier(docId: string): Tier | undefined {
    return this.grants.get(docId)?.tier;
  }
}
