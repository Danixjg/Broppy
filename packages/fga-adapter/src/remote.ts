import { nativeAllows } from "@brain/connectors";
import type { AccessDecision, SourceDocument, Tier, User } from "@brain/types";
import { tierAllows } from "./index.js";

type DocumentGrant = Pick<SourceDocument, "docId" | "permissions" | "tier">;
type Tuple = { user: string; relation: "direct_reader" | "group_reader"; object: string };

export interface RemoteFgaConfig {
  url: string;
  storeId: string;
  modelId: string;
  token?: string;
  fetch?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function tupleId(tuple: Tuple): string {
  return `${tuple.user}\u0000${tuple.relation}\u0000${tuple.object}`;
}

function desiredTuples(doc: DocumentGrant): Tuple[] {
  const object = `document:${doc.docId}`;
  return [
    ...[...new Set(doc.permissions.users.map(email => email.trim()).filter(Boolean))]
      .map(email => ({ user: `user:${email}`, relation: "direct_reader" as const, object })),
    ...[...new Set(doc.permissions.groups.map(group => group.trim()).filter(Boolean))]
      .map(group => ({ user: `group:${group}#member`, relation: "group_reader" as const, object }))
  ];
}

/** HTTP adapter for the document model in infra/fga/model.fga. */
export class RemoteFgaAdapter {
  private readonly baseUrl: string;
  private readonly storeId: string;
  private readonly modelId: string;
  private readonly token?: string;
  private readonly transport: typeof fetch;
  private readonly grants = new Map<string, DocumentGrant>();

  constructor(config: RemoteFgaConfig) {
    const url = new URL(required(config.url, "FGA_API_URL"));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("FGA_API_URL must be HTTP(S)");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.storeId = required(config.storeId, "FGA_STORE_ID");
    this.modelId = required(config.modelId, "FGA_MODEL_ID");
    this.token = config.token;
    this.transport = config.fetch ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RemoteFgaAdapter {
    return new RemoteFgaAdapter({
      url: required(env.FGA_API_URL, "FGA_API_URL"),
      storeId: required(env.FGA_STORE_ID, "FGA_STORE_ID"),
      modelId: required(env.FGA_MODEL_ID, "FGA_MODEL_ID"),
      token: env.FGA_API_TOKEN
    });
  }

  private async post(path: string, body: object): Promise<unknown> {
    const response = await this.transport(`${this.baseUrl}/stores/${encodeURIComponent(this.storeId)}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`OpenFGA ${path} failed (${response.status})`);
    return response.json();
  }

  private async storedTuples(docId: string): Promise<Tuple[]> {
    const object = `document:${docId}`;
    const tuples: Tuple[] = [];
    let continuationToken = "";
    const seenTokens = new Set<string>();
    do {
      const page = await this.post("read", {
        tuple_key: { object },
        consistency: "HIGHER_CONSISTENCY",
        ...(continuationToken ? { continuation_token: continuationToken } : {})
      });
      if (!record(page) || !Array.isArray(page.tuples) ||
        (page.continuation_token !== undefined && typeof page.continuation_token !== "string")) {
        throw new Error("Invalid OpenFGA read response");
      }
      for (const entry of page.tuples) {
        const key = record(entry) ? entry.key : undefined;
        if (!record(key) || typeof key.user !== "string" || typeof key.relation !== "string" ||
          key.object !== object) throw new Error("Invalid OpenFGA tuple");
        if (key.relation === "direct_reader" || key.relation === "group_reader") {
          tuples.push({ user: key.user, relation: key.relation, object });
        }
      }
      continuationToken = (page.continuation_token as string | undefined) ?? "";
      if (continuationToken && seenTokens.has(continuationToken)) throw new Error("Repeated OpenFGA read page");
      seenTokens.add(continuationToken);
    } while (continuationToken);
    return tuples;
  }

  private async reconcile(docId: string, desired: Tuple[]): Promise<void> {
    const current = await this.storedTuples(docId);
    const have = new Set(current.map(tupleId));
    const want = new Set(desired.map(tupleId));
    const deletes = current.filter(tuple => !want.has(tupleId(tuple)));
    const writes = desired.filter(tuple => !have.has(tupleId(tuple)));
    // OpenFGA permits at most 100 tuple changes per write request.
    while (deletes.length || writes.length) {
      const batchDeletes = deletes.splice(0, 100);
      const batchWrites = writes.splice(0, 100 - batchDeletes.length);
      await this.post("write", {
        authorization_model_id: this.modelId,
        ...(batchDeletes.length ? { deletes: { tuple_keys: batchDeletes } } : {}),
        ...(batchWrites.length ? { writes: { tuple_keys: batchWrites } } : {})
      });
    }
  }

  /** Reconcile direct and group document grants; keep local source and tier policy. */
  async syncDocument(doc: DocumentGrant): Promise<void> {
    const prior = this.grants.get(doc.docId);
    this.grants.delete(doc.docId);
    const tierOrder: Record<Tier, number> = { open: 0, internal: 1, restricted: 2 };
    const tier = prior && tierOrder[prior.tier] > tierOrder[doc.tier] ? prior.tier : doc.tier;
    await this.reconcile(doc.docId, desiredTuples(doc));
    this.grants.set(doc.docId, { docId: doc.docId, permissions: structuredClone(doc.permissions), tier });
  }

  async removeDocument(docId: string): Promise<void> {
    this.grants.delete(docId);
    await this.reconcile(docId, []);
  }

  narrowTier(docId: string, tier: Tier): void {
    const grant = this.grants.get(docId);
    if (!grant) throw new Error("Unknown document");
    const order: Record<Tier, number> = { open: 0, internal: 1, restricted: 2 };
    if (order[tier] < order[grant.tier]) throw new Error("Admin tier may only narrow access");
    this.grants.set(docId, { ...grant, tier });
  }

  effectiveTier(docId: string): Tier | undefined {
    return this.grants.get(docId)?.tier;
  }

  /** Returns one decision per unique document ID, in input order. Remote errors deny. */
  async batchCheck(user: User, docIds: string[]): Promise<AccessDecision[]> {
    const ids = [...new Set(docIds)];
    const decisions = new Map<string, AccessDecision>();
    const pending: string[] = [];
    for (const docId of ids) {
      const grant = this.grants.get(docId);
      if (!grant || !nativeAllows(user, grant.permissions) || !user.email) {
        decisions.set(docId, { docId, allowed: false, reason: "fga" });
      } else if (!tierAllows(user, grant.tier)) {
        decisions.set(docId, { docId, allowed: false, reason: "tier" });
      } else {
        pending.push(docId);
      }
    }
    for (let offset = 0; offset < pending.length; offset += 50) {
      const chunk = pending.slice(offset, offset + 50);
      const checks = chunk.map((docId, index) => ({
        tuple_key: { user: `user:${user.email}`, relation: "native_reader", object: `document:${docId}` },
        correlation_id: String(offset + index + 1)
      }));
      try {
        const response = await this.post("batch-check", {
          authorization_model_id: this.modelId,
          consistency: "HIGHER_CONSISTENCY",
          checks: checks.map(check => ({
            ...check,
            contextual_tuples: {
              tuple_keys: [...new Set(user.groups)].map(group => ({
                user: `user:${user.email}`, relation: "member", object: `group:${group}`
              }))
            }
          }))
        });
        if (!record(response) || !record(response.result)) throw new Error("Invalid OpenFGA batch response");
        for (let i = 0; i < chunk.length; i++) {
          const result = response.result[checks[i].correlation_id];
          const allowed = record(result) && result.allowed === true && !result.error;
          decisions.set(chunk[i], { docId: chunk[i], allowed, reason: "fga" });
        }
      } catch {
        for (const docId of chunk) decisions.set(docId, { docId, allowed: false, reason: "fga" });
      }
    }
    return ids.map(docId => decisions.get(docId)!);
  }
}
