import type { Persistence } from "./persistence.js";
import { ModelUnavailable } from "./llm.js";
import { balanceBySource, planQuery } from "./query-plan.js";
import { createHash, randomUUID } from "node:crypto";
import { AuditLog } from "@brain/audit";
import { loadMockCorpus, MockConnector, type ImportScope } from "@brain/connectors";
import { FgaAdapter, type RemoteFgaAdapter } from "@brain/fga-adapter";
import { groundedOutput, hash, HybridIndex, LocalGroundedLlm, NO_RESULT, type LlmClient, type SemanticEmbeddingClient, type SupabaseIndex } from "@brain/retrieval";
import type {
  Citation,
  ConnectorState,
  QueryAnswer,
  QueryScope,
  Source,
  SourceDocument,
  SourcePermission,
  SyncRun,
  Tier,
  User
} from "@brain/types";

const sources: Source[] = ["slack", "jira", "confluence", "drive"];
export class Brain {
  readonly connections = new Map<Source, { source: Source; status: string; scope: ImportScope; connectedBy?: string; connectedAt?: string }>();
  readonly jobs = new Map<Source, { source: Source; status: string; found: number; indexed: number; skipped: number; failed: number; error?: string; startedAt: string; finishedAt?: string }>();
  readonly orgId: string;
  private persistence?: Persistence;
  private persistQueue: Promise<void> = Promise.resolve();
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
  // Answers from the same authorized context when the model can't: over budget, rate limited or failing.
  private readonly fallbackLlm = new LocalGroundedLlm();
  readonly lastTraceIds = new Map<string, string>();
  private readonly syncQueues = new Map<Source, Promise<void>>();
  private readonly remoteSynced = new Set<string>();
  private readonly supabaseSynced = new Set<string>();

  constructor(llm: LlmClient = new LocalGroundedLlm(), options: { orgId?: string; persistence?: Persistence; audit?: AuditLog; remoteFga?: RemoteFgaAdapter; embedding?: SemanticEmbeddingClient; supabase?: SupabaseIndex; users?: User[]; connectors?: Record<Source, MockConnector> } = {}) {
    this.orgId = options.orgId ?? "demo-company-a";
    this.persistence = options.persistence;
    const fixture = loadMockCorpus();
    this.users = options.users ?? fixture.users;
    this.connectors = options.connectors ?? fixture.connectors;
    this.liveMode = Boolean(options.connectors);
    this.llm = llm;
    this.audit = options.audit ?? new AuditLog();
    this.remoteFga = options.remoteFga;
    this.embedding = options.embedding;
    this.supabase = options.supabase;
    for (const source of sources) {
      this.states.set(source, { source, cursor: 0 });
      this.connections.set(source, { source, status: "Connected", scope: {} });
    }
  }

  async restore(): Promise<void> {
    const snapshot = await this.persistence?.loadState();
    if (!snapshot) return;
    if (snapshot.orgId !== this.orgId) throw new Error("State organization mismatch");
    for (const doc of snapshot.documents) this.index.documents.set(doc.docId, doc);
    this.fga.restore(snapshot.grants);
    this.remoteFga?.restoreGrants(this.fga.snapshot().map(([docId, grant]) => ({ docId, ...grant })));
    this.index.restoreSemantic(snapshot.semanticVectors ?? []);
    for (const id of snapshot.remoteSynced ?? []) this.remoteSynced.add(id);
    for (const id of snapshot.supabaseSynced ?? []) this.supabaseSynced.add(id);
    for (const state of snapshot.states) this.states.set(state.source, state);
    for (const run of snapshot.runs) this.runs.set(run.source, run);
    for (const connection of snapshot.connections ?? []) this.connections.set(connection.source, connection);
    for (const job of snapshot.jobs ?? []) this.jobs.set(job.source, job);
    if (!this.liveMode && snapshot.connectorDocuments) {
      for (const source of sources) {
        this.connectors[source] = new MockConnector(source, snapshot.connectorDocuments.filter((doc: SourceDocument) => doc.source === source));
        this.states.set(source, { source, cursor: 0 });
      }
    }
    if (!this.liveMode && snapshot.users) this.users.splice(0, this.users.length, ...snapshot.users);
  }

  async persist(): Promise<void> {
    const next = this.persistQueue.catch(() => undefined).then(async () => {
      await this.audit.flush();
      if (!this.persistence) return;
      const connectorDocuments = this.liveMode ? undefined : (await Promise.all(sources.map(source => this.connectors[source].listItems()))).flat();
      await this.persistence.saveState({ orgId: this.orgId, documents: [...this.index.documents.values()],
        grants: this.fga.snapshot(), semanticVectors: this.index.semanticSnapshot(),
        remoteSynced: [...this.remoteSynced], supabaseSynced: [...this.supabaseSynced], states: [...this.states.values()], runs: [...this.runs.values()],
        users: this.users, connections: [...this.connections.values()], jobs: [...this.jobs.values()], connectorDocuments });
    });
    this.persistQueue = next;
    return next;
  }

  private assertOrg(user: User): void {
    if ((user.orgId ?? "demo-company-a") !== this.orgId || user.active === false) throw new Error("Forbidden");
  }

  user(id: string): User | undefined {
    return this.users.find(item => item.id === id);
  }

  async syncAll(): Promise<void> {
    for (const source of sources) await this.sync(source);
  }

  async sync(source: Source): Promise<void> {
    const previous = this.syncQueues.get(source) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncSource(source)).catch(async error => {
      const connection = this.connections.get(source);
      if (connection && connection.status !== "Not connected") connection.status = "Error";
      const job = this.jobs.get(source);
      if (job?.status === "running") { job.status = "failed"; job.error = error instanceof Error ? error.message : "Source discovery failed"; }
      await this.persist();
      throw error;
    });
    const settled = next.catch(() => undefined).then(() => {
      if (this.syncQueues.get(source) === settled) this.syncQueues.delete(source);
    });
    this.syncQueues.set(source, settled);
    return next;
  }

  private async syncSource(source: Source): Promise<void> {
    if (this.connections.get(source)?.status === "Not connected") return;
    const connector = this.connectors[source];
    const state = this.states.get(source);
    if (!state) throw new Error("Unknown source");
    const scoped = new Set(await connector.discover(this.connections.get(source)?.scope));
    let run = this.runs.get(source);
    if (!run || run.status === "complete") {
      const changed = await connector.listUpdatedSince(state.cursor);
      changed.ids = changed.ids.filter(id => scoped.has(id));
      const liveIds = scoped;
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
      if (!state.lastSuccessfulSyncAt && !this.jobs.has(source)) {
        this.jobs.set(source, { source, status: "running", found: run.pendingIds.length, indexed: 0, skipped: 0, failed: 0, startedAt: new Date().toISOString() });
        this.audit.append("import_started", "sync", { source, found: run.pendingIds.length });
      }
    }
    this.runs.set(source, { ...run, status: "running" });
    const resumedJob = this.jobs.get(source);
    if (resumedJob?.status === "failed") { resumedJob.status = "running"; resumedJob.error = undefined; }
    try {
      while (run.pendingIds.length) {
        const id: string = run.pendingIds[0];
        const remaining = run.pendingIds.slice(1);
        const doc = scoped.has(id) ? await connector.fetchDocument(id) : undefined;
        const job = this.jobs.get(source);
        if (!doc) {
          if (job?.status === "running") job.skipped++;
          const removed = this.index.tombstone(id);
          this.fga.remove(id);
          await this.remoteFga?.removeDocument(id);
          this.remoteSynced.delete(id);
          const deletedAt = this.index.documents.get(id)?.deletedAt;
          if (deletedAt && this.supabaseSynced.has(id)) await this.supabase?.tombstone(id, deletedAt);
          this.supabaseSynced.delete(id);
          if (removed) {
            this.audit.append("document_deleted", "sync", { ...this.auditDocument(id), source });
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
          doc.orgId = this.orgId;
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
            ...this.auditDocument(id),
            source,
            contentChanged: result.contentChanged,
            permissionChanged: result.permissionChanged
          });
        }
        if (doc && job?.status === "running") job.indexed++;
        run = { ...run, checkpoint: id, pendingIds: remaining, orgId: this.orgId };
        this.runs.set(source, run);
        await this.persist();
      }
      this.states.set(source, {
        ...state, orgId: this.orgId,
        cursor: run.cursorTo,
        lastSuccessfulSyncAt: new Date().toISOString()
      });
      this.runs.set(source, { ...run, status: "complete" });
      const job = this.jobs.get(source);
      if (job?.status === "running") {
        job.status = "complete"; job.finishedAt = new Date().toISOString();
        this.audit.append("import_completed", "sync", { ...job });
      }
      const connection = this.connections.get(source);
      if (connection) connection.status = "Live";
      await this.persist();
    } catch (error: unknown) {
      this.runs.set(source, { ...run, status: "failed" });
      const job = this.jobs.get(source);
      if (job) { job.status = "failed"; job.failed++; job.error = error instanceof Error ? error.message : "Import failed"; }
      const connection = this.connections.get(source);
      if (connection) connection.status = "Error";
      this.audit.append("sync_failed", "sync", { source, checkpointRef: run.checkpoint ? auditRef(run.checkpoint) : undefined });
      await this.persist();
      throw error;
    }
  }

  async connect(actor: User, source: Source): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live OAuth setup is required");
    this.connections.set(source, { source, status: "Connected", scope: {}, connectedBy: actor.id, connectedAt: new Date().toISOString() });
    this.audit.append("connection_created", actor.id, { source });
    await this.persist();
  }

  async setScope(actor: User, source: Source, scope: ImportScope): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.syncQueues.has(source)) throw new Error("Sync running; retry scope change");
    this.connections.get(source)!.scope = scope;
    // Scope narrowing is applied immediately to local access. Background sync purges remote data.
    const keep = new Set(await this.connectors[source].discover(scope));
    for (const doc of this.index.documents.values()) if (doc.source === source && !keep.has(doc.docId)) {
      this.index.tombstone(doc.docId); this.fga.remove(doc.docId);
      await this.remoteFga?.removeDocument(doc.docId);
      if (this.supabase) await this.supabase.purge(doc.docId);
      this.remoteSynced.delete(doc.docId); this.supabaseSynced.delete(doc.docId);
    }
    this.runs.delete(source);
    this.states.set(source, { source, cursor: 0 });
    await this.persist();
  }

  async startImport(actor: User, source: Source): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.syncQueues.has(source) || this.jobs.get(source)?.status === "running") return;
    if (this.connections.get(source)?.status === "Not connected") throw new Error("Connect source first");
    this.jobs.set(source, { source, status: "running", found: 0, indexed: 0, skipped: 0, failed: 0, startedAt: new Date().toISOString() });
    this.connections.get(source)!.status = "Importing";
    this.audit.append("import_started", actor.id, { source });
    const next = Promise.resolve().then(async () => {
      await this.persist();
      const ids = await this.connectors[source].discover(this.connections.get(source)?.scope);
      const changed = await this.connectors[source].listUpdatedSince(0);
      this.runs.set(source, { source, cursorFrom: 0, cursorTo: changed.cursor, pendingIds: ids, status: "running" });
      this.jobs.get(source)!.found = ids.length;
      await this.persist();
      await this.syncSource(source);
    }).catch(async error => {
      const job = this.jobs.get(source)!;
      job.status = "failed"; job.error = error instanceof Error ? error.message : "Import failed";
      this.connections.get(source)!.status = "Error";
      await this.persist();
    });
    const settled = next.catch(() => undefined).then(() => {
      if (this.syncQueues.get(source) === settled) this.syncQueues.delete(source);
    });
    this.syncQueues.set(source, settled);
  }

  async disconnect(actor: User, source: Source): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    this.connections.get(source)!.status = "Not connected";
    await this.syncQueues.get(source);
    for (const doc of [...this.index.documents.values()]) if (doc.source === source) {
      this.fga.remove(doc.docId);
      this.index.tombstone(doc.docId);
      await this.remoteFga?.removeDocument(doc.docId);
      await this.supabase?.purge(doc.docId);
      this.remoteSynced.delete(doc.docId); this.supabaseSynced.delete(doc.docId);
      this.index.documents.delete(doc.docId);
    }
    this.runs.delete(source); this.jobs.delete(source);
    this.states.set(source, { source, cursor: 0 });
    this.connections.get(source)!.status = "Not connected";
    this.audit.append("connection_removed", actor.id, { source });
    await this.persist();
  }

  importNotice(): string | undefined {
    const jobs = [...this.jobs.values()].filter(job => job.status === "running");
    if (!jobs.length) return undefined;
    const total = jobs.reduce((n,j) => n + j.found, 0);
    const done = jobs.reduce((n,j) => n + j.indexed + j.skipped, 0);
    return `Import ${total ? Math.floor(100 * done / total) : 0}% complete — answers may be missing older material`;
  }

  async query(user: User, question: string, onTrace?: (traceId: string) => void,
    revalidateUser?: () => Promise<User | undefined>): Promise<QueryAnswer> {
    this.assertOrg(user);
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("Invalid question");
    const traceId = randomUUID();
    this.lastTraceIds.set(user.id, traceId);
    onTrace?.(traceId);
    const audit = (type: string, data: Record<string, unknown>) =>
      this.audit.append(type, user.id, { traceId, ...data });
    audit("query_received", { question: trimmed, questionHash: hashQuestion(trimmed) });
    await this.audit.flush();
    // Platforms the question names come first in the answer; a time range it names applies to those platforms, or to
    // every platform when it names none.
    const plan = planQuery(trimmed);
    const scope: QueryScope | undefined = plan.sources.length || plan.window ? { sources: plan.sources, ...plan.window } : undefined;
    audit("query_planned", { sources: plan.sources, ...plan.window });

    let queryVector: number[] | undefined;
    if (this.embedding && (this.embedding.available?.() ?? true)) {
      try { queryVector = await this.embedding.embed(trimmed); }
      catch { audit("embedding_fallback", {}); }
    }
    // Keep the full local candidate set so denied hits cannot crowd an
    // accessible document out of the authorization pass.
    const localCandidates = this.index.search(plan.searchText, Number.MAX_SAFE_INTEGER, queryVector);
    let candidates = localCandidates;
    if (this.supabase && queryVector?.length === 1024) {
      try {
        // Remote ranking may only reorder chunks that pass the local relevance gate.
        const relevant = new Set(localCandidates.map(item => item.chunkId));
        const remote = (await this.supabase.search(plan.searchText, queryVector, 30)).filter(item => relevant.has(item.chunkId));
        const seen = new Set(remote.map(item => item.chunkId));
        candidates = [...remote, ...localCandidates.filter(item => !seen.has(item.chunkId))];
      }
      catch { audit("search_fallback", {}); }
    }
    if (plan.window) {
      const from = Date.parse(plan.window.from);
      const to = Date.parse(plan.window.to);
      candidates = candidates.filter(item => {
        const doc = this.index.documents.get(item.docId);
        if (!doc || (plan.sources.length && !plan.sources.includes(doc.source))) return true;
        const updated = Date.parse(doc.updatedAt);
        return updated >= from && updated <= to;
      });
    }
    const candidateDocIds = [...new Set(candidates.map(candidate => candidate.docId))];
    audit("candidates_found", { count: candidateDocIds.length });
    for (const candidate of candidates) {
      audit("candidate_ranked", {
        ...this.auditDocument(candidate.docId),
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
        ...this.auditDocument(decision.docId),
        allowed: decision.allowed,
        reason: decision.reason
      });
    }

    const allowedIds = new Set(decisions.filter(decision => decision.allowed).map(decision => decision.docId));
    if (!allowedIds.size) return this.noResult(user, traceId, scope);

    const authorizedCandidates = candidates.filter(item => allowedIds.has(item.docId));
    const asksForHistory = /\b(superseded|old|draft|historical|previous)\b/i.test(trimmed);
    const currentCandidates = authorizedCandidates.filter(item =>
      this.index.documents.get(item.docId)?.metadata.status !== "superseded");
    const answerCandidates = balanceBySource(!asksForHistory && currentCandidates.length ? currentCandidates : authorizedCandidates,
      plan.sources, docId => this.index.documents.get(docId)?.source);
    const context: Array<{ citation: string; text: string }> = [];
    const chunkTexts = new Map<string, string>();
    const citationMap = new Map<string, Citation>();
    for (const candidate of answerCandidates) {
      if (context.length >= 8) break;
      const indexedVersion = this.index.documents.get(candidate.docId)?.version;
      const doc = await this.liveAuthorizedDocument(user, candidate.docId);
      audit("live_access_decision", {
        ...this.auditDocument(candidate.docId), allowed: Boolean(doc),
        ...(doc ? { sourceVersion: doc.version, refreshed: doc.version !== indexedVersion } : {})
      });
      if (!doc) continue;

      const indexed = this.index.documents.get(candidate.docId);
      const freshChunk = indexed?.chunks.find(item => item.chunkId === candidate.chunkId);
      if (!indexed || !freshChunk) continue;
      context.push({ citation: freshChunk.chunkId, text: withJiraStatus(indexed, freshChunk.text) });
      chunkTexts.set(freshChunk.chunkId, freshChunk.text);
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

    if (!context.length) return this.noResult(user, traceId, scope);
    audit("context_sent", { chunkIds: [...citationMap.keys()] });
    await this.audit.flush();
    const evidence = new Map(context.map(item => [item.citation, item.text]));
    let generated: string;
    let fromModel = !(this.llm instanceof LocalGroundedLlm);
    try {
      generated = await this.llm.generate(context, trimmed);
    } catch (error) {
      audit("llm_fallback", { reason: error instanceof ModelUnavailable ? error.reason : "error" });
      generated = await this.fallbackLlm.generate(context, trimmed);
      fromModel = false;
    }
    let answer = groundedOutput(generated, citationMap, evidence);
    // Nothing the model wrote was copied word for word from the sources: answer as if no model were set.
    if (fromModel && answer.text === NO_RESULT) {
      audit("llm_fallback", { reason: "ungrounded" });
      answer = groundedOutput(await this.fallbackLlm.generate(context, trimmed), citationMap, evidence);
    }
    let outputUser = user;
    if (revalidateUser) {
      try {
        const current = await revalidateUser();
        if (!current || current.id !== user.id) return this.noResult(user, traceId, scope);
        outputUser = current;
      } catch {
        return this.noResult(user, traceId, scope);
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
          item.chunkId === citation.chunkId && item.text === chunkTexts.get(citation.chunkId)));
      audit("output_access_decision", { ...this.auditDocument(citation.docId), allowed });
      if (!allowed) return this.noResult(user, traceId, scope);
    }
    audit("answer_returned", {
      answer: answer.text,
      documents: answer.citations.map(citation => this.auditDocument(citation.docId)),
      citationIds: answer.citations.map(citation => citation.chunkId),
      empty: answer.text === NO_RESULT
    });
    return scope ? { ...answer, scope } : answer;
  }

  /** The items one link away, in either direction, that still exist: what this item links to, and what links to it. */
  linkedIds(docId: string): string[] {
    const exists = (id: string) => { const doc = this.index.documents.get(id); return Boolean(doc && !doc.deletedAt); };
    if (!exists(docId)) return [];
    const found = new Set((this.index.documents.get(docId)!.links ?? []).filter(id => id !== docId && exists(id)));
    for (const doc of this.index.documents.values()) {
      if (doc.docId !== docId && !doc.deletedAt && doc.links?.includes(docId)) found.add(doc.docId);
    }
    return [...found].sort();
  }

  async visibleDocuments(user: User): Promise<Array<Pick<SourceDocument, "docId" | "source" | "title" | "content" | "url" | "updatedAt" | "metadata" | "tier"> & { version: number; lastIndexedAt: string; lastPermissionSyncAt: string }>> {
    const visible: Array<Pick<SourceDocument, "docId" | "source" | "title" | "content" | "url" | "updatedAt" | "metadata" | "tier"> & { version: number; lastIndexedAt: string; lastPermissionSyncAt: string }> = [];
    this.assertOrg(user);
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
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    this.remoteFga?.narrowTier(docId, tier);
    this.fga.narrowTier(docId, tier);
    this.audit.append("tier_narrowed", actor.id, { ...this.auditDocument(docId), tier });
  }

  async setNativePermissions(actor: User, docId: string, permissions: SourcePermission): Promise<void> {
    this.assertOrg(actor);
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
    this.audit.append("native_permission_changed", actor.id, { ...this.auditDocument(docId) });
  }

  removeUserFromGroup(actor: User, userId: string, group: string): void {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live group membership must be changed at the identity provider");
    const target = this.user(userId);
    if (!target) throw new Error("Unknown user");
    if (!target.groups.includes(group)) throw new Error("Unknown group membership");
    target.groups = target.groups.filter(item => item !== group);
    this.audit.append("group_membership_removed", actor.id, { userId, group });
  }

  async removeSlackMember(actor: User, docId: string, userId: string): Promise<void> {
    this.assertOrg(actor);
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
    this.audit.append("channel_membership_removed", actor.id, { ...this.auditDocument(docId), userId });
  }

  async editContent(actor: User, docId: string, content: string): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live content must be edited at the source");
    if (!content.trim() || content.length > 50_000) throw new Error("Invalid content");
    const connector = this.connector(docId);
    connector.updateContent(docId, content);
    await this.sync(connector.source);
    this.audit.append("source_content_changed", actor.id, { docId });
  }

  async previewAccess(actor: User, targetUserId: string): Promise<{ user: User; documents: Awaited<ReturnType<Brain["visibleDocuments"]>>; reasons: Record<string, string[]> }> {
    this.assertOrg(actor);
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
      this.audit.append("document_deleted", "query", { ...this.auditDocument(docId) });
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
        this.audit.append("live_permission_refresh", "query", { ...this.auditDocument(docId) });
      }
      return indexed;
    }
    const doc = await connector.fetchDocument(docId);
    if (doc) {
      doc.orgId = this.orgId;
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
        ...this.auditDocument(docId),
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
    // Over its budget, the embedding client is skipped: the document keeps keyword search until it is available.
    if (this.embedding && (this.embedding.available?.() ?? true) &&
      (contentChanged || existing.size !== indexed.chunks.length)) {
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
    if (this.connections.get(connector.source)?.status === "Not connected") return undefined;
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

  private noResult(user: User, traceId: string, scope?: QueryScope): QueryAnswer {
    this.audit.append("answer_returned", user.id, { traceId, answer: NO_RESULT, citationIds: [], empty: true });
    // The scope comes from the question alone, so it reveals nothing about what exists.
    return { text: NO_RESULT, citations: [], ...(scope ? { scope } : {}) };
  }

  private auditDocument(docId: string): Record<string, unknown> {
    const doc = this.index.documents.get(docId);
    const native = doc?.permissions.native;
    return { docRef: auditRef(docId), docId, source: doc?.source ?? docId.split(":")[0],
      space: doc?.metadata.space ?? (native?.source === "confluence" ? native.spaceKey : undefined),
      project: doc?.metadata.project ?? (native?.source === "jira" ? native.projectKey : undefined) };
  }

  private connector(docId: string): MockConnector {
    const source = docId.split(":")[0] as Source;
    const connector = this.connectors[source];
    if (!connector) throw new Error("Unknown source");
    return connector;
  }
}

// A Jira issue's status lives in its fields, not its text, so the answer context states it next to the issue key:
// "DB-12 (in progress) tracks …", or "DB-15 (blocked): …" when the text doesn't start with the key.
function withJiraStatus(doc: SourceDocument, text: string): string {
  const status = doc.source === "jira" ? doc.metadata.status : undefined;
  if (!status) return text;
  const key = doc.sourceNativeId;
  return text.startsWith(`${key} `) ? `${key} (${status})${text.slice(key.length)}` : `${key} (${status}): ${text}`;
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
