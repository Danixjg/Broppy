import { createHmac, randomBytes } from "node:crypto";
import { AuditLog } from "@brain/audit";
import { loadMockCorpus, type MockConnector } from "@brain/connectors";
import { FgaAdapter, tierAllows } from "@brain/fga-adapter";
import { groundedOutput, HybridIndex, LocalGroundedLlm, NO_RESULT, type LlmClient } from "@brain/retrieval";
import type {
  Citation,
  ConnectorState,
  QueryAnswer,
  Source,
  SourceDocument,
  SourcePermission,
  SyncRun,
  Tier,
  User
} from "@brain/types";

const sources: Source[] = ["slack", "jira", "confluence", "drive"];
const auditKey = process.env.AUDIT_HMAC_KEY ?? randomBytes(32).toString("hex");
const tierOrder: Record<Tier, number> = {
  open: 0,
  internal: 1,
  restricted: 2
};

export class Brain {
  readonly users: User[];
  readonly connectors: Record<Source, MockConnector>;
  readonly index = new HybridIndex();
  readonly fga = new FgaAdapter();
  readonly audit = new AuditLog();
  readonly states = new Map<Source, ConnectorState>();
  readonly runs = new Map<Source, SyncRun>();
  readonly llm: LlmClient;
  private readonly syncQueues = new Map<Source, Promise<void>>();

  constructor(llm: LlmClient = new LocalGroundedLlm()) {
    const fixture = loadMockCorpus();
    this.users = fixture.users;
    this.connectors = fixture.connectors;
    this.llm = llm;
    for (const source of sources) this.states.set(source, { source, cursor: 0 });
  }

  user(id: string): User | undefined {
    return this.users.find(item => item.id === id);
  }

  async syncAll(): Promise<void> {
    for (const source of sources) await this.sync(source);
  }

  async sync(source: Source): Promise<void> {
    const previous = this.syncQueues.get(source) ?? Promise.resolve();
    const next = previous.then(() => this.syncSource(source));
    this.syncQueues.set(source, next.finally(() => {
      if (this.syncQueues.get(source) === next) this.syncQueues.delete(source);
    }));
    return next;
  }

  private async syncSource(source: Source): Promise<void> {
    const connector = this.connectors[source];
    const state = this.states.get(source);
    if (!state) throw new Error("Unknown source");
    let run = this.runs.get(source);
    if (!run || run.status === "complete") {
      const changed = await connector.listUpdatedSince(state.cursor);
      const liveIds = new Set(await connector.listIds());
      const missing = [...this.index.documents.values()]
        .filter(doc => doc.source === source && !doc.deletedAt && !liveIds.has(doc.docId))
        .map(doc => doc.docId);
      run = {
        source,
        cursorFrom: state.cursor,
        cursorTo: changed.cursor,
        pendingIds: [...new Set([...changed.ids, ...missing])],
        status: "running"
      };
      this.runs.set(source, run);
    }
    this.runs.set(source, { ...run, status: "running" });
    try {
      while (run.pendingIds.length) {
        const id: string = run.pendingIds[0];
        const remaining = run.pendingIds.slice(1);
        const doc = await connector.fetchDocument(id);
        if (!doc) {
          if (this.index.tombstone(id)) {
            this.fga.remove(id);
            this.audit.append("document_deleted", "sync", { docRef: auditRef(id), source });
          }
        } else {
          const result = this.index.upsert(doc);
          this.fga.upsert(doc);
          this.audit.append("document_synced", "sync", {
            docRef: auditRef(id),
            source,
            contentChanged: result.contentChanged,
            permissionChanged: result.permissionChanged
          });
        }
        run = { ...run, checkpoint: id, pendingIds: remaining };
        this.runs.set(source, run);
      }
      this.states.set(source, {
        ...state,
        cursor: run.cursorTo,
        lastSuccessfulSyncAt: new Date().toISOString()
      });
      this.runs.set(source, { ...run, status: "complete" });
    } catch (error: unknown) {
      this.runs.set(source, { ...run, status: "failed" });
      this.audit.append("sync_failed", "sync", { source, checkpointRef: run.checkpoint ? auditRef(run.checkpoint) : undefined });
      throw error;
    }
  }

  async query(user: User, question: string): Promise<QueryAnswer> {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("Invalid question");
    this.audit.append("query_received", user.id, { questionHash: hashQuestion(trimmed) });

    const candidates = this.index.search(trimmed, 30);
    const candidateDocIds = [...new Set(candidates.map(candidate => candidate.docId))];
    this.audit.append("candidates_found", user.id, { count: candidateDocIds.length });

    const decisions = this.fga.batchCheck(user, candidateDocIds);
    for (const decision of decisions) {
      this.audit.append("access_decision", user.id, {
        docRef: auditRef(decision.docId),
        allowed: decision.allowed,
        reason: decision.reason
      });
    }

    const allowedIds = new Set(decisions.filter(decision => decision.allowed).map(decision => decision.docId));
    if (!allowedIds.size) return this.noResult(user);

    const context: Array<{ citation: string; text: string }> = [];
    const citationMap = new Map<string, Citation>();
    for (const candidate of candidates.filter(item => allowedIds.has(item.docId)).slice(0, 8)) {
      const sourceAllowed = await this.connector(candidate.docId).checkAccess(user, candidate.docId);
      const doc = await this.refreshLive(candidate.docId);
      const effectiveTier = this.fga.effectiveTier(candidate.docId);
      const allowed = sourceAllowed && Boolean(doc) && Boolean(effectiveTier) &&
        tierAllows(user, effectiveTier!) && this.fga.check(user, candidate.docId).allowed;
      this.audit.append("live_access_decision", user.id, { docRef: auditRef(candidate.docId), allowed });
      if (!allowed || !doc) continue;

      const indexed = this.index.documents.get(candidate.docId);
      const freshChunk = indexed?.chunks.find(item => item.chunkId === candidate.chunkId);
      if (!indexed || !freshChunk) continue;
      context.push({ citation: freshChunk.chunkId, text: freshChunk.text });
      citationMap.set(freshChunk.chunkId, {
        docId: indexed.docId,
        chunkId: freshChunk.chunkId,
        title: indexed.title,
        url: indexed.url,
        version: indexed.version,
        updatedAt: indexed.updatedAt,
        lastIndexedAt: indexed.lastIndexedAt
      });
    }

    if (!context.length) return this.noResult(user);
    this.audit.append("context_sent", user.id, { chunkIds: [...citationMap.keys()] });
    const generated = await this.llm.generate(context, trimmed);
    const answer = groundedOutput(generated, citationMap);
    this.audit.append("answer_returned", user.id, {
      citationIds: answer.citations.map(citation => citation.chunkId),
      empty: answer.text === NO_RESULT
    });
    return answer;
  }

  async visibleDocuments(user: User): Promise<Array<Pick<SourceDocument, "docId" | "source" | "title" | "url" | "updatedAt" | "metadata" | "tier"> & { version: number }>> {
    const visible = [];
    for (const doc of this.index.documents.values()) {
      if (doc.deletedAt || !this.fga.check(user, doc.docId).allowed) continue;
      if (!await this.connectors[doc.source].checkAccess(user, doc.docId)) continue;
      visible.push({
        docId: doc.docId,
        source: doc.source,
        title: doc.title,
        url: doc.url,
        updatedAt: doc.updatedAt,
        metadata: doc.metadata,
        tier: this.fga.effectiveTier(doc.docId) ?? doc.tier,
        version: doc.version
      });
    }
    return visible;
  }

  async narrowTier(actor: User, docId: string, tier: Tier): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    this.fga.narrowTier(docId, tier);
    this.audit.append("tier_narrowed", actor.id, { docRef: auditRef(docId), tier });
  }

  async setNativePermissions(actor: User, docId: string, permissions: SourcePermission): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (!this.isValidPermission(permissions)) throw new Error("Invalid permissions");
    const connector = this.connector(docId);
    const current = await connector.fetchPermissions(docId);
    if (!current || !isPermissionSubset(permissions, current)) {
      throw new Error("Native permission edits may only narrow access");
    }
    connector.updatePermissions(docId, permissions);
    await this.sync(connector.source);
    this.audit.append("native_permission_changed", actor.id, { docRef: auditRef(docId) });
  }

  async editContent(actor: User, docId: string, content: string): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (!content.trim() || content.length > 50_000) throw new Error("Invalid content");
    const connector = this.connector(docId);
    connector.updateContent(docId, content);
    await this.sync(connector.source);
    this.audit.append("source_content_changed", actor.id, { docId });
  }

  async previewAccess(actor: User, targetUserId: string): Promise<{ user: User; documents: Awaited<ReturnType<Brain["visibleDocuments"]>> }> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    const target = this.user(targetUserId);
    if (!target) throw new Error("Unknown user");
    return { user: target, documents: await this.visibleDocuments(target) };
  }

  private async refreshLive(docId: string): Promise<SourceDocument | undefined> {
    const connector = this.connector(docId);
    const doc = await connector.fetchDocument(docId);
    if (!doc) {
      this.index.tombstone(docId);
      this.fga.remove(docId);
      this.audit.append("document_deleted", "query", { docId });
      return undefined;
    }
    const indexed = this.index.documents.get(docId);
    if (!indexed || doc.version !== indexed.version ||
      JSON.stringify(doc.permissions) !== JSON.stringify(indexed.permissions)) {
      const result = this.index.upsert(doc);
      this.fga.upsert(doc);
      this.audit.append("live_refresh", "query", {
        docId,
        version: doc.version,
        contentChanged: result.contentChanged,
        permissionChanged: result.permissionChanged
      });
    }
    return doc;
  }

  private noResult(user: User): QueryAnswer {
    this.audit.append("answer_returned", user.id, { citationIds: [], empty: true });
    return { text: NO_RESULT, citations: [] };
  }

  private connector(docId: string): MockConnector {
    const source = docId.split(":")[0] as Source;
    const connector = this.connectors[source];
    if (!connector) throw new Error("Unknown source");
    return connector;
  }
}

function hashQuestion(question: string): string {
  return createHash("sha256").update(question).digest("hex");
}
