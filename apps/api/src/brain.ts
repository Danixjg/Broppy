import { createHash, randomUUID } from "node:crypto";
import { AuditLog } from "@brain/audit";
import { loadMockCorpus, type MockConnector } from "@brain/connectors";
import { FgaAdapter, type RemoteFgaAdapter } from "@brain/fga-adapter";
import { groundedOutput, hash, HybridIndex, LocalGroundedLlm, NO_RESULT, type LlmClient, type SemanticEmbeddingClient, type SupabaseIndex } from "@brain/retrieval";
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
export class Brain {
  readonly users: User[];
  readonly connectors: Record<Source, MockConnector>;
  readonly liveMode: boolean;
  readonly index = new HybridIndex();
  readonly fga = new FgaAdapter();
  readonly remoteFga?: RemoteFgaAdapter;
  readonly embedding?: SemanticEmbeddingClient;
  readonly supabase?: SupabaseIndex;
  readonly audit: AuditLog;
  readonly states = new Map<Source, ConnectorState>();
  readonly runs = new Map<Source, SyncRun>();
  readonly llm: LlmClient;
  readonly lastTraceIds = new Map<string, string>();
  private readonly syncQueues = new Map<Source, Promise<void>>();
  private readonly remoteSynced = new Set<string>();
  private readonly supabaseSynced = new Set<string>();

  constructor(llm: LlmClient = new LocalGroundedLlm(), options: { audit?: AuditLog; remoteFga?: RemoteFgaAdapter; embedding?: SemanticEmbeddingClient; supabase?: SupabaseIndex; users?: User[]; connectors?: Record<Source, MockConnector> } = {}) {
    const fixture = loadMockCorpus();
    this.users = options.users ?? fixture.users;
    this.connectors = options.connectors ?? fixture.connectors;
    this.liveMode = Boolean(options.connectors);
    this.llm = llm;
    this.audit = options.audit ?? new AuditLog();
    this.remoteFga = options.remoteFga;
    this.embedding = options.embedding;
    this.supabase = options.supabase;
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
    const next = previous.catch(() => undefined).then(() => this.syncSource(source));
    const settled = next.catch(() => undefined).then(() => {
      if (this.syncQueues.get(source) === settled) this.syncQueues.delete(source);
    });
    this.syncQueues.set(source, settled);
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
        .filter(doc => doc.source === source && !liveIds.has(doc.docId) &&
          (!doc.deletedAt || this.remoteSynced.has(doc.docId) || this.supabaseSynced.has(doc.docId)))
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
          const removed = this.index.tombstone(id);
          this.fga.remove(id);
          await this.remoteFga?.removeDocument(id);
          this.remoteSynced.delete(id);
          const deletedAt = this.index.documents.get(id)?.deletedAt;
          if (deletedAt && this.supabaseSynced.has(id)) await this.supabase?.tombstone(id, deletedAt);
          this.supabaseSynced.delete(id);
          if (removed) {
            this.audit.append("document_deleted", "sync", { docRef: auditRef(id), source });
          }
        } else {
          // Read source permissions again before content enters either index.
          // A change racing ingestion is retried from this ID on the next run.
          const [permissions, version] = await Promise.all([
            connector.fetchPermissions(id), connector.fetchVersion(id)
          ]);
          if (!permissions || version !== doc.version || hash(permissions) !== hash(doc.permissions)) {
            throw new Error("Source changed during ingestion");
          }
          const result = this.index.upsert(doc);
          this.fga.upsert(doc);
          await this.persistSearch(doc.docId, result.contentChanged);
          if (this.remoteFga && (result.permissionChanged || !this.remoteSynced.has(id))) {
            try {
              await this.remoteFga.syncDocument(doc);
              this.remoteSynced.add(id);
            } catch (error) {
              this.remoteSynced.delete(id);
              throw error;
            }
          }
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

  async query(user: User, question: string, onTrace?: (traceId: string) => void,
    revalidateUser?: () => Promise<User | undefined>): Promise<QueryAnswer> {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("Invalid question");
    const traceId = randomUUID();
    this.lastTraceIds.set(user.id, traceId);
    onTrace?.(traceId);
    const audit = (type: string, data: Record<string, unknown>) =>
      this.audit.append(type, user.id, { traceId, ...data });
    audit("query_received", { questionHash: hashQuestion(trimmed) });

    let queryVector: number[] | undefined;
    if (this.embedding) {
      try { queryVector = await this.embedding.embed(trimmed); }
      catch { audit("embedding_fallback", {}); }
    }
    // Keep the full local candidate set so denied hits cannot crowd an
    // accessible document out of the authorization pass.
    const localCandidates = this.index.search(trimmed, Number.MAX_SAFE_INTEGER, queryVector);
    let candidates = localCandidates;
    if (this.supabase && queryVector?.length === 1024) {
      try {
        const remote = await this.supabase.search(trimmed, queryVector, 30);
        const seen = new Set(remote.map(item => item.chunkId));
        candidates = [...remote, ...localCandidates.filter(item => !seen.has(item.chunkId))];
      }
      catch { audit("search_fallback", {}); }
    }
    const candidateDocIds = [...new Set(candidates.map(candidate => candidate.docId))];
    audit("candidates_found", { count: candidateDocIds.length });
    for (const candidate of candidates) {
      audit("candidate_ranked", {
        docRef: auditRef(candidate.docId),
        chunkRef: auditRef(candidate.chunkId),
        score: Number(candidate.score.toFixed(4))
      });
    }

    const localDecisions = this.fga.batchCheck(user, candidateDocIds);
    const remoteDecisions = this.remoteFga ? await this.remoteFga.batchCheck(user, candidateDocIds) : undefined;
    const remoteById = new Map(remoteDecisions?.map(decision => [decision.docId, decision]));
    const decisions = localDecisions.map(decision => {
      const remote = remoteById.get(decision.docId);
      return decision.allowed && remote && !remote.allowed ? remote :
        remoteDecisions && !remote ? { ...decision, allowed: false } : decision;
    });
    for (const decision of decisions) {
      audit("access_decision", {
        docRef: auditRef(decision.docId),
        allowed: decision.allowed,
        reason: decision.reason
      });
    }

    const allowedIds = new Set(decisions.filter(decision => decision.allowed).map(decision => decision.docId));
    if (!allowedIds.size) return this.noResult(user, traceId);

    const authorizedCandidates = candidates.filter(item => allowedIds.has(item.docId));
    const asksForHistory = /\b(superseded|old|draft|historical|previous)\b/i.test(trimmed);
    const currentCandidates = authorizedCandidates.filter(item =>
      this.index.documents.get(item.docId)?.metadata.status !== "superseded");
    const answerCandidates = !asksForHistory && currentCandidates.length ? currentCandidates : authorizedCandidates;
    const context: Array<{ citation: string; text: string }> = [];
    const citationMap = new Map<string, Citation>();
    for (const candidate of answerCandidates) {
      if (context.length >= 8) break;
      const indexedVersion = this.index.documents.get(candidate.docId)?.version;
      const doc = await this.liveAuthorizedDocument(user, candidate.docId);
      audit("live_access_decision", {
        docRef: auditRef(candidate.docId), allowed: Boolean(doc),
        ...(doc ? { sourceVersion: doc.version, refreshed: doc.version !== indexedVersion } : {})
      });
      if (!doc) continue;

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

    if (!context.length) return this.noResult(user, traceId);
    audit("context_sent", { chunkIds: [...citationMap.keys()] });
    const generated = await this.llm.generate(context, trimmed);
    const answer = groundedOutput(generated, citationMap,
      new Map(context.map(item => [item.citation, item.text])));
    let outputUser = user;
    if (revalidateUser) {
      try {
        const current = await revalidateUser();
        if (!current || current.id !== user.id) return this.noResult(user, traceId);
        outputUser = current;
      } catch {
        return this.noResult(user, traceId);
      }
    }
    // Generation can outlive a source ACL change. Recheck every source that
    // influenced the model before returning any generated text or citation.
    for (const citation of citationMap.values()) {
      let current: SourceDocument | undefined;
      try { current = await this.liveAuthorizedDocument(outputUser, citation.docId); }
      catch { current = undefined; }
      const allowed = Boolean(current && current.version === citation.version &&
        this.index.documents.get(citation.docId)?.chunks.some(item =>
          item.chunkId === citation.chunkId &&
          item.text === context.find(part => part.citation === citation.chunkId)?.text));
      audit("output_access_decision", { docRef: auditRef(citation.docId), allowed });
      if (!allowed) return this.noResult(user, traceId);
    }
    audit("answer_returned", {
      citationIds: answer.citations.map(citation => citation.chunkId),
      empty: answer.text === NO_RESULT
    });
    return answer;
  }

  async visibleDocuments(user: User): Promise<Array<Pick<SourceDocument, "docId" | "source" | "title" | "content" | "url" | "updatedAt" | "metadata" | "tier"> & { version: number; lastIndexedAt: string; lastPermissionSyncAt: string }>> {
    const visible: Array<Pick<SourceDocument, "docId" | "source" | "title" | "content" | "url" | "updatedAt" | "metadata" | "tier"> & { version: number; lastIndexedAt: string; lastPermissionSyncAt: string }> = [];
    for (const doc of this.index.documents.values()) {
      if (doc.deletedAt || !this.fga.check(user, doc.docId).allowed) continue;
      if (!await this.liveAuthorizedDocument(user, doc.docId)) continue;
      const fresh = this.index.documents.get(doc.docId);
      if (!fresh || fresh.deletedAt) continue;
      visible.push({
        docId: fresh.docId,
        source: fresh.source,
        title: fresh.title,
        content: fresh.content,
        url: fresh.url,
        updatedAt: fresh.updatedAt,
        metadata: fresh.metadata,
        tier: this.fga.effectiveTier(fresh.docId) ?? fresh.tier,
        version: fresh.version,
        lastIndexedAt: fresh.lastIndexedAt,
        lastPermissionSyncAt: fresh.lastPermissionSyncAt
      });
    }
    return visible;
  }

  async narrowTier(actor: User, docId: string, tier: Tier): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    this.remoteFga?.narrowTier(docId, tier);
    this.fga.narrowTier(docId, tier);
    this.audit.append("tier_narrowed", actor.id, { docRef: auditRef(docId), tier });
  }

  async setNativePermissions(actor: User, docId: string, permissions: SourcePermission): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live source permissions must be changed at the source");
    if (!isValidPermission(permissions)) throw new Error("Invalid permissions");
    const connector = this.connector(docId);
    const current = await connector.fetchPermissions(docId);
    if (!current || !isPermissionSubset(permissions, current)) {
      throw new Error("Native permission edits may only narrow access");
    }
    connector.updatePermissions(docId, permissions);
    await this.sync(connector.source);
    this.audit.append("native_permission_changed", actor.id, { docRef: auditRef(docId) });
  }

  removeUserFromGroup(actor: User, userId: string, group: string): void {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live group membership must be changed at the identity provider");
    const target = this.user(userId);
    if (!target) throw new Error("Unknown user");
    if (!target.groups.includes(group)) throw new Error("Unknown group membership");
    target.groups = target.groups.filter(item => item !== group);
    this.audit.append("group_membership_removed", actor.id, { userId, group });
  }

  async removeSlackMember(actor: User, docId: string, userId: string): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live channel membership must be changed in Slack");
    const target = this.user(userId);
    if (!target) throw new Error("Unknown user");
    const connector = this.connectors.slack;
    const doc = await connector.fetchDocument(docId);
    const native = doc?.permissions.native;
    if (doc?.source !== "slack" || native?.source !== "slack") throw new Error("Unknown document");
    const identity = target.platformIdentities?.slack;
    if (!identity || !native.members.includes(identity)) throw new Error("Unknown channel membership");
    connector.updatePermissions(docId, {
      ...doc.permissions,
      native: { ...native, members: native.members.filter(member => member !== identity) }
    });
    await this.sync("slack");
    this.audit.append("channel_membership_removed", actor.id, { docRef: auditRef(docId), userId });
  }

  async editContent(actor: User, docId: string, content: string): Promise<void> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live content must be edited at the source");
    if (!content.trim() || content.length > 50_000) throw new Error("Invalid content");
    const connector = this.connector(docId);
    connector.updateContent(docId, content);
    await this.sync(connector.source);
    this.audit.append("source_content_changed", actor.id, { docId });
  }

  async previewAccess(actor: User, targetUserId: string): Promise<{ user: User; documents: Awaited<ReturnType<Brain["visibleDocuments"]>>; reasons: Record<string, string[]> }> {
    if (actor.role !== "admin") throw new Error("Forbidden");
    const target = this.user(targetUserId);
    if (!target) throw new Error("Unknown user");
    const documents = await this.visibleDocuments(target);
    const reasons: Record<string, string[]> = {};
    for (const doc of documents) {
      const permission = this.index.documents.get(doc.docId)?.permissions;
      const matchingGroup = permission?.groups.find(group => target.groups.includes(group));
      const grantReason = permission?.users.includes(target.email) ? "Direct user grant" :
        matchingGroup ? `Group: ${matchingGroup}` : "Public brain grant";
      reasons[doc.docId] = [
        grantReason,
        `${doc.source} native permission`,
        `Tier: ${doc.tier}`
      ];
    }
    return { user: target, documents, reasons };
  }

  private async refreshLive(docId: string): Promise<SourceDocument | undefined> {
    const connector = this.connector(docId);
    const indexed = this.index.documents.get(docId);
    const [version, permissions] = await Promise.all([
      connector.fetchVersion(docId), connector.fetchPermissions(docId)
    ]);
    if (version === undefined || !permissions) {
      this.index.tombstone(docId);
      this.fga.remove(docId);
      await this.remoteFga?.removeDocument(docId);
      this.remoteSynced.delete(docId);
      const deletedAt = this.index.documents.get(docId)?.deletedAt;
      if (deletedAt && this.supabaseSynced.has(docId)) await this.supabase?.tombstone(docId, deletedAt);
      this.supabaseSynced.delete(docId);
      this.audit.append("document_deleted", "query", { docRef: auditRef(docId) });
      return undefined;
    }
    if (indexed && version === indexed.version) {
      if (hash(permissions) !== indexed.permissionHash) {
        const changed = { ...indexed, permissions };
        this.index.upsert(changed);
        this.fga.upsert(changed);
        await this.persistSearch(docId, false);
        if (this.remoteFga) {
          try {
            await this.remoteFga.syncDocument(changed);
            this.remoteSynced.add(docId);
          } catch (error) {
            this.remoteSynced.delete(docId);
            throw error;
          }
        }
        this.audit.append("live_permission_refresh", "query", { docRef: auditRef(docId) });
      }
      return indexed;
    }
    const doc = await connector.fetchDocument(docId);
    if (doc) {
      const result = this.index.upsert(doc);
      this.fga.upsert(doc);
      await this.persistSearch(docId, result.contentChanged);
      if (this.remoteFga) {
        try {
          await this.remoteFga.syncDocument(doc);
          this.remoteSynced.add(docId);
        } catch (error) {
          this.remoteSynced.delete(docId);
          throw error;
        }
      }
      this.audit.append("live_refresh", "query", {
        docRef: auditRef(docId),
        version: doc.version,
        contentChanged: result.contentChanged,
        permissionChanged: result.permissionChanged
      });
    }
    return doc;
  }

  private async persistSearch(docId: string, contentChanged: boolean): Promise<void> {
    const indexed = this.index.documents.get(docId);
    if (!indexed || indexed.deletedAt) return;
    const existing = this.index.semanticVectorsFor(docId);
    if (this.embedding && (contentChanged || existing.size !== indexed.chunks.length)) {
      if (!await this.index.refreshSemantic(docId, this.embedding)) {
        throw new Error("Semantic embedding refresh failed");
      }
    }
    if (this.supabase) {
      const rewriteChunks = contentChanged || !this.supabaseSynced.has(docId);
      try {
        await this.supabase.syncDocument(indexed, this.index.semanticVectorsFor(docId), rewriteChunks);
        this.supabaseSynced.add(docId);
      } catch (error) {
        this.supabaseSynced.delete(docId);
        throw error;
      }
    }
  }

  private async liveAuthorizedDocument(user: User, docId: string): Promise<SourceDocument | undefined> {
    const connector = this.connector(docId);
    if (!await connector.checkAccess(user, docId)) {
      const indexed = this.index.documents.get(docId);
      const permissions = await connector.fetchPermissions(docId);
      if (indexed && permissions) {
        this.index.upsert({ ...indexed, permissions });
        this.fga.upsert({ docId, permissions, tier: indexed.tier });
        if (this.remoteFga) {
          try {
            await this.remoteFga.syncDocument({ docId, permissions, tier: indexed.tier });
            this.remoteSynced.add(docId);
          } catch {
            this.remoteSynced.delete(docId);
          }
        }
      } else {
        this.index.tombstone(docId);
        this.fga.remove(docId);
        if (this.remoteFga) {
          try {
            await this.remoteFga.removeDocument(docId);
            this.remoteSynced.delete(docId);
          } catch {
            // The next ID pass retries the remote removal while the local tombstone denies access.
          }
        }
      }
      return undefined;
    }
    let doc: SourceDocument | undefined;
    try {
      doc = await this.refreshLive(docId);
    } catch {
      return undefined;
    }
    if (!doc || !this.fga.check(user, docId).allowed) return undefined;
    if (this.remoteFga && !(await this.remoteFga.batchCheck(user, [docId]))[0]?.allowed) return undefined;
    return await connector.checkAccess(user, docId) ? doc : undefined;
  }

  private noResult(user: User, traceId: string): QueryAnswer {
    this.audit.append("answer_returned", user.id, { traceId, citationIds: [], empty: true });
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

function auditRef(docId: string): string {
  return createHash("sha256").update(docId).digest("hex");
}

function isValidPermission(value: SourcePermission): boolean {
  return Boolean(value && typeof value === "object" &&
    Array.isArray(value.users) && value.users.every(user => typeof user === "string") &&
    Array.isArray(value.groups) && value.groups.every(group => typeof group === "string") &&
    typeof value.public === "boolean");
}

function isPermissionSubset(next: SourcePermission, current: SourcePermission): boolean {
  return (!next.public || current.public) &&
    next.users.every(user => current.public || current.users.includes(user)) &&
    next.groups.every(group => current.public || current.groups.includes(group));
}
