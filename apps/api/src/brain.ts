import { StaleState, type Persistence } from "./persistence.js";
import { ModelUnavailable } from "./llm.js";
import { balanceBySource, planQuery, type QueryPlan } from "./query-plan.js";
import { agreementSummary, agreementsFor, auditSummary, catchUpQuestion, duplicatesFor, latestFor, projectOf, projectsFor,
  sentences, tracked, type Project, type WorkspaceDocument } from "./workspace.js";
import { createHash, randomUUID } from "node:crypto";
import { commitmentFingerprint, MemoryTaskStore, proposalId, type Proposal, type TaskStore } from "../../slack/src/store.js";
import { fingerprint as taskFingerprint, tokens as taskTokens } from "../../slack/src/fingerprint.js";
import { AuditLog } from "@brain/audit";
import { loadMockCorpus, MockConnector, type Container, type GeneratedItems, type ImportScope } from "@brain/connectors";
import { SourceNotConnected } from "@brain/connectors/live";
import { FgaAdapter, type RemoteFgaAdapter } from "@brain/fga-adapter";
import { checkAnswer, distinctiveWords, hash, HybridIndex, LocalGroundedLlm, NO_RESULT, terms, type LlmClient, type SemanticEmbeddingClient,
  type SupabaseIndex } from "@brain/retrieval";
import type {
  Citation,
  ConnectorState,
  QueryAnswer,
  QueryScope,
  SearchCandidate,
  Source,
  SourceDocument,
  SourcePermission,
  SyncRun,
  Tier,
  User
} from "@brain/types";

const sources: Source[] = ["slack", "jira", "confluence", "drive"];
const reviewQueues = new Map<string, Promise<unknown>>();
// After a failed embedding, the provider rests this long. A free plan that refuses or hangs is asked again later, and
// questions don't wait on it meanwhile.
const EMBEDDING_PAUSE_MS = 5 * 60_000;
/** The mock data: the 26 hand-written items, or those plus the generated company (`pnpm dataset`). A `Brain` also takes
 * a company generated in memory, as `pnpm bench` does at the brief's scale. */
export type Corpus = "curated" | "demo";

/** The Jira writes the workspace makes for live sources. JiraAsUser implements it with the company's shared connection. */
export interface LiveJira {
  canCreate(user: User, project: string): Promise<boolean>;
  createIssue(user: User, input: { project: string; summary: string; description: string }): Promise<{ key: string; url: string } | undefined>;
  markDone(user: User, key: string): Promise<boolean>;
}

export class Brain {
  readonly connections = new Map<Source, { source: Source; status: string; scope: ImportScope; connectedBy?: string; connectedAt?: string; error?: string }>();
  readonly jobs = new Map<Source, { source: Source; status: string; found: number; indexed: number; skipped: number; failed: number; error?: string; startedAt: string; finishedAt?: string }>();
  readonly orgId: string;
  private persistence?: Persistence;
  private persistQueue: Promise<void> = Promise.resolve();
  readonly users: User[];
  readonly connectors: Record<Source, MockConnector>;
  readonly liveMode: boolean;
  /** Jira writes through the company's shared connection, for live sources. Without it, live sources stay read-only. */
  liveJira?: LiveJira;
  readonly index = new HybridIndex();
  readonly fga = new FgaAdapter();
  readonly remoteFga?: RemoteFgaAdapter;
  readonly embedding?: SemanticEmbeddingClient;
  readonly supabase?: SupabaseIndex;
  readonly audit: AuditLog;
  readonly states = new Map<Source, ConnectorState>();
  readonly runs = new Map<Source, SyncRun>();
  readonly llm: LlmClient;
  // The model the organization's admin chose in settings. It wins over the operator's own model (the env vars).
  private readonly orgLlm?: { current(): Promise<LlmClient | undefined> };
  // Answers from the same authorized context when the model can't: over budget, rate limited or failing.
  private readonly fallbackLlm = new LocalGroundedLlm();
  readonly lastTraceIds = new Map<string, string>();
  private readonly syncQueues = new Map<Source, Promise<void>>();
  /** Told about work that carries on after a request's reply, so a serverless host keeps running until it finishes. */
  onBackground?: (work: Promise<unknown>) => void;
  private readonly remoteSynced = new Set<string>();
  private readonly supabaseSynced = new Set<string>();
  private embeddingPausedUntil = 0;
  readonly taskStore: TaskStore;
  private readonly slackUserIds: Record<string, string>;

  constructor(llm: LlmClient = new LocalGroundedLlm(), options: { orgId?: string; persistence?: Persistence; audit?: AuditLog; remoteFga?: RemoteFgaAdapter; embedding?: SemanticEmbeddingClient; supabase?: SupabaseIndex; taskStore?: TaskStore; slackUserIds?: Record<string, string>; orgLlm?: { current(): Promise<LlmClient | undefined> }; users?: User[]; connectors?: Record<Source, MockConnector>; corpus?: Corpus | GeneratedItems } = {}) {
    this.orgId = options.orgId ?? "demo-company-a";
    this.persistence = options.persistence;
    const fixture = loadMockCorpus(new Date(), { generated: typeof options.corpus === "object" ? options.corpus : options.corpus === "demo" });
    this.users = options.users ?? fixture.users;
    this.connectors = options.connectors ?? fixture.connectors;
    this.liveMode = Boolean(options.connectors);
    this.llm = llm;
    this.orgLlm = options.orgLlm;
    this.audit = options.audit ?? new AuditLog();
    this.remoteFga = options.remoteFga;
    this.embedding = options.embedding;
    this.supabase = options.supabase;
    this.taskStore = options.taskStore ?? new MemoryTaskStore();
    this.slackUserIds = { ...options.slackUserIds };
    for (const source of sources) {
      this.states.set(source, { source, cursor: 0 });
      this.connections.set(source, { source, status: "Connected", scope: {} });
    }
  }

  async restore(): Promise<void> {
    const snapshot = await this.persistence?.loadState();
    if (!snapshot) return;
    if (snapshot.orgId !== this.orgId) throw new Error("State organization mismatch");
    this.index.restore(snapshot.documents);
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

  /**
   * Reloads the workspace when another API instance has saved it since this one did, so this instance never answers or
   * saves from an old copy. Waits for this instance's own saves first; cheap when nothing changed (one small read).
   */
  async refreshIfStale(): Promise<boolean> {
    if (!this.persistence) return false;
    await this.persistQueue.catch(() => undefined);
    if (await this.persistence.currentRevision() === this.persistence.revision) return false;
    await this.restore();
    return true;
  }

  async persist(): Promise<void> {
    const next = this.persistQueue.catch(() => undefined).then(async () => {
      await this.audit.flush();
      if (!this.persistence) return;
      // A disconnected source is purged, so its mock originals are not written to the snapshot either.
      const connectorDocuments = this.liveMode ? undefined : (await Promise.all(sources
        .filter(source => this.connections.get(source)?.status !== "Not connected")
        .map(source => this.connectors[source].listItems()))).flat();
      await this.persistence.saveState({ orgId: this.orgId, documents: [...this.index.documents.values()],
        grants: this.fga.snapshot(), semanticVectors: this.index.semanticSnapshot(),
        remoteSynced: [...this.remoteSynced], supabaseSynced: [...this.supabaseSynced], states: [...this.states.values()], runs: [...this.runs.values()],
        users: this.users, connections: [...this.connections.values()], jobs: [...this.jobs.values()], connectorDocuments })
        .catch(async error => {
          // Another instance saved first. Take its state rather than overwrite it; the caller is told to try again.
          if (error instanceof StaleState) await this.restore();
          throw error;
        });
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

  /**
   * Where each of this company's sources stands, for its Sync health page: connected or not, the import in progress or
   * last finished, how many items are indexed, and when the source last synced. Only this company's own state.
   */
  syncHealth(): Array<{ source: Source; status: string; scope?: string; connectedAt?: string; error?: string; items: number; lastSync?: string;
    job?: { status: string; found: number; indexed: number; failed: number; finishedAt?: string }; pending?: number }> {
    return sources.map(source => {
      const connection = this.connections.get(source);
      const job = this.jobs.get(source);
      const run = this.runs.get(source);
      const connected = Boolean(connection) && connection!.status !== "Not connected";
      return { source, status: connection?.status ?? (this.liveMode ? "Not connected" : "Connected"), ...(connection?.scope?.mode ? { scope: connection.scope.mode } : {}),
        ...(connection?.connectedAt ? { connectedAt: connection.connectedAt } : {}), ...(connection?.error ? { error: connection.error } : {}),
        items: [...this.index.documents.values()].filter(doc => doc.source === source && !doc.deletedAt).length,
        // A source that isn't connected has no sync to report, whatever older state says.
        ...(connected || !this.liveMode ? {
          ...(this.states.get(source)?.lastSuccessfulSyncAt ? { lastSync: this.states.get(source)!.lastSuccessfulSyncAt } : {}),
          ...(job ? { job: { status: job.status, found: job.found, indexed: job.indexed, failed: job.failed, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}) } } : {}),
          ...(run && run.status === "running" ? { pending: run.pendingIds.length } : {})
        } : {}) };
    });
  }

  /** Syncs the sources this company has connected, and says which ones failed; unconnected sources are skipped, not errors. */
  async syncConnected(): Promise<Array<{ source: Source; ok: boolean; error?: string }>> {
    const results: Array<{ source: Source; ok: boolean; error?: string }> = [];
    for (const source of sources) {
      if (this.liveMode && (this.connections.get(source)?.status ?? "Not connected") === "Not connected") continue;
      try { await this.sync(source); results.push({ source, ok: true }); }
      catch (error) { results.push({ source, ok: false, error: error instanceof Error ? error.message : "Sync failed" }); }
    }
    return results;
  }

  async syncAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const source of sources) {
      try { await this.sync(source); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Source synchronization failed");
  }

  async sync(source: Source): Promise<void> {
    const previous = this.syncQueues.get(source) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncSource(source)).catch(async error => {
      const connection = this.connections.get(source);
      // With no credential at all the source simply isn't connected; marking it Error would have it retried forever.
      if (connection && connection.status !== "Not connected" && error instanceof SourceNotConnected) {
        connection.status = "Not connected";
        connection.error = undefined;
      } else if (connection && connection.status !== "Not connected") {
        connection.status = "Error";
        connection.error = error instanceof Error ? error.message : "Sync failed";
      }
      const job = this.jobs.get(source);
      if (job?.status === "running") { job.status = "failed"; job.error = error instanceof Error ? error.message : "Source discovery failed"; }
      await this.persist();
      throw error;
    });
    const settled = next.catch(() => undefined).then(() => {
      if (this.syncQueues.get(source) === settled) this.syncQueues.delete(source);
    });
    this.syncQueues.set(source, settled);
    this.onBackground?.(settled);
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
      const changed = await connector.listUpdatedSince(state.cursor, state.providerCheckpoint);
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
        ...(changed.checkpoint ? { providerCheckpoint: changed.checkpoint } : {}),
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
      await this.retryMissingEmbeddings(source);
      this.states.set(source, {
        ...state, orgId: this.orgId,
        cursor: run.cursorTo,
        ...(run.providerCheckpoint ? { providerCheckpoint: run.providerCheckpoint } : {}),
        lastSuccessfulSyncAt: new Date().toISOString()
      });
      this.runs.set(source, { ...run, status: "complete" });
      const job = this.jobs.get(source);
      if (job?.status === "running") {
        job.status = "complete"; job.finishedAt = new Date().toISOString();
        this.audit.append("import_completed", "sync", { ...job });
      }
      const connection = this.connections.get(source);
      if (connection) { connection.status = "Live"; connection.error = undefined; }
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

  /** A provider sign-in finished. A new connection imports nothing until the admin chooses. Reconnecting a source that is
   * already set up, for instance after its credential was rejected, keeps the scope the admin chose. */
  markConnected(actor: User, source: Source): void {
    this.assertOrg(actor);
    const existing = this.connections.get(source);
    const keep = existing && existing.status !== "Not connected";
    this.connections.set(source, { source, status: "Connected", scope: keep ? existing.scope : { mode: "none" },
      connectedBy: actor.id, connectedAt: new Date().toISOString() });
    this.audit.append("connection_created", actor.id, { source, reconnected: Boolean(keep) });
  }

  /** Admin picker: the channels, projects, spaces or shared drives the connected credential can see. */
  async listContainers(actor: User, source: Source): Promise<Container[]> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.connections.get(source)?.status === "Not connected") throw new Error("Connect source first");
    return this.connectors[source].listContainers();
  }

  async connect(actor: User, source: Source, scope?: ImportScope): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.liveMode) throw new Error("Live OAuth setup is required");
    // Connecting again keeps the scope already chosen, unless a new one is given.
    const existing = this.connections.get(source);
    scope ??= existing && existing.status !== "Not connected" ? existing.scope : {};
    this.connections.set(source, { source, status: "Connected", scope, connectedBy: actor.id, connectedAt: new Date().toISOString() });
    this.audit.append("connection_created", actor.id, { source });
    await this.persist();
  }

  async setScope(actor: User, source: Source, scope: ImportScope): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (this.syncQueues.has(source)) throw new Error("Sync running; retry scope change");
    // "Only what is new" starts at the moment it was chosen, and keeps that moment when the scope is saved again.
    const previous = this.connections.get(source)!.scope;
    if (scope.futureOnly && !scope.since) scope = { ...scope, since: previous.futureOnly && previous.since ? previous.since : new Date().toISOString() };
    if (!scope.futureOnly && previous.futureOnly && scope.since === previous.since) scope = { ...scope, since: undefined };
    this.connections.get(source)!.scope = scope;
    this.audit.append("scope_changed", actor.id, { source, mode: scope.mode ?? "all", containers: scope.containers?.length ?? 0,
      ids: scope.ids?.length ?? 0, futureOnly: Boolean(scope.futureOnly), since: scope.since });
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

  /**
   * A reading this copy isn't doing, started over ten minutes ago, stopped when the copy doing it was shut down (a
   * serverless function has a time limit). Left as "running" it would lock the setup page and block a new reading, so it
   * is marked as stopped; the next sync carries on from where it got to.
   */
  settleStaleJobs(now = Date.now()): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || this.syncQueues.has(job.source) || now - Date.parse(job.startedAt) < 600_000) continue;
      job.status = "failed"; job.error = "Reading stopped before it finished; it will carry on at the next sync";
      const connection = this.connections.get(job.source);
      if (connection?.status === "Importing") { connection.status = "Error"; connection.error = job.error; }
    }
  }

  async startImport(actor: User, source: Source): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    this.settleStaleJobs();
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
    this.onBackground?.(settled);
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
      this.index.remove(doc.docId);
    }
    this.runs.delete(source); this.jobs.delete(source);
    this.states.set(source, { source, cursor: 0 });
    this.connections.get(source)!.status = "Not connected";
    this.audit.append("connection_removed", actor.id, { source });
    await this.persist();
  }

  importNotice(): string | undefined {
    const jobs = [...this.jobs.values()].filter(job => job.status === "running");
    const failed = sources.filter(source => this.jobs.get(source)?.status === "failed" ||
      Boolean(this.jobs.get(source)?.failed) || this.connections.get(source)?.status === "Error" || this.runs.get(source)?.status === "failed");
    if (failed.length) return `Import or sync failed for ${failed.join(", ")}. Coverage is incomplete; answers and possible gaps may miss material.`;
    if (!jobs.length) {
      const partial = sources.some(source => { const scope = this.connections.get(source)?.scope;
        return this.connections.get(source)?.status === "Not connected" || scope?.mode === "selected" || scope?.mode === "none" ||
          scope?.futureOnly || Boolean(scope?.since || scope?.ids?.length || scope?.containers?.length);
      });
      if (partial) return "Coverage is limited to connected sources and the configured import scope. Older or excluded material may be missing.";
      return sources.some(source => !this.states.get(source)?.lastSuccessfulSyncAt) ? "Some sources have not completed a successful sync. Coverage is incomplete." : undefined;
    }
    const total = jobs.reduce((n,j) => n + j.found, 0);
    const done = jobs.reduce((n,j) => n + j.indexed + j.skipped, 0);
    return `Import ${total ? Math.floor(100 * done / total) : 0}% complete — answers may be missing older material`;
  }

  /**
   * Answers a question from what the person may see. `within` keeps the answer to one project's items, as the
   * workspace's catch-up does.
   */
  async query(user: User, question: string, onTrace?: (traceId: string) => void,
    revalidateUser?: () => Promise<User | undefined>,
    options: { project?: string; within?: { project: string; docIds: readonly string[] } } = {}): Promise<QueryAnswer> {
    // One log line per question with where the time went, in milliseconds per stage. It never carries the question or any content.
    const started = performance.now();
    const stages: Record<string, number> = {};
    let last = started;
    const lap = (stage: string) => { const now = performance.now(); stages[stage] = Math.round(now - last); last = now; };
    try { return await this.answerQuery(user, question, onTrace, revalidateUser, options, lap); }
    finally { console.info(JSON.stringify({ event: "query_timing", totalMs: Math.round(performance.now() - started), stages })); }
  }

  private async answerQuery(user: User, question: string, onTrace: ((traceId: string) => void) | undefined,
    revalidateUser: (() => Promise<User | undefined>) | undefined,
    options: { project?: string; within?: { project: string; docIds: readonly string[] } }, lap: (stage: string) => void): Promise<QueryAnswer> {
    this.assertOrg(user);
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("Invalid question");
    if (options.project) {
      const selected = projectsFor(await this.visibleDocuments(user)).find(item => item.key === options.project);
      if (!selected) throw new Error("Unknown document");
      options = { within: { project: selected.name, docIds: selected.docIds } };
    }
    const traceId = randomUUID();
    this.lastTraceIds.set(user.id, traceId);
    onTrace?.(traceId);
    const audit = (type: string, data: Record<string, unknown>) =>
      this.audit.append(type, user.id, { traceId, ...data });
    audit("query_received", { question: trimmed, questionHash: hashQuestion(trimmed) });
    await this.audit.flush();
    lap("audit_start");

    // ② Access is decided on document IDs only, and every decision is audited.
    const authorize = async (docIds: string[]): Promise<Set<string>> => {
      const localDecisions = this.fga.batchCheck(user, docIds);
      const remoteDecisions = this.remoteFga ? await this.remoteFga.batchCheck(user, docIds) : undefined;
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
      return new Set(decisions.filter(decision => decision.allowed).map(decision => decision.docId));
    };

    // Platforms the question names come first in the answer; a time range it names applies to those platforms, or to
    // every platform when it names none.
    const plan = planQuery(trimmed);
    // A question that names a project the person may open keeps to that project's items. A project they may not open
    // changes nothing, and its refusal never reaches their own trace.
    const named = options.within ? undefined : this.namedProject(trimmed);
    const keptTo = named && (await authorize([named.masterDocId])).has(named.masterDocId) ? named : undefined;
    const within = options.within ? new Set(options.within.docIds) : keptTo ? new Set(keptTo.docIds) : undefined;
    const project = options.within?.project ?? keptTo?.name;
    const scope: QueryScope | undefined = plan.sources.length || plan.window || project
      ? { sources: plan.sources, ...plan.window, ...(project ? { project } : {}) } : undefined;
    audit("query_planned", { sources: plan.sources, ...plan.window, ...(project ? { project } : {}) });

    let queryVector: number[] | undefined;
    if (this.embedding && (this.embedding.available?.() ?? true)) {
      if (Date.now() < this.embeddingPausedUntil) audit("embedding_fallback", { reason: "paused" });
      else {
        try { queryVector = await this.embedding.embed(trimmed); }
        catch { this.pauseEmbedding(); audit("embedding_fallback", { reason: "failed" }); }
      }
    }
    lap("plan_and_embed");
    // Keep the full local candidate set so denied hits cannot crowd an
    // accessible document out of the authorization pass.
    const localCandidates = await this.index.searchAsync(plan.searchText, Number.MAX_SAFE_INTEGER, queryVector);
    let candidates = localCandidates;
    if (this.supabase && queryVector?.length === 1024) {
      try {
        // Remote ranking may only reorder chunks that pass the local relevance gate, and keeps their local coverage.
        const relevant = new Map(localCandidates.map(item => [item.chunkId, item]));
        const remote = (await this.supabase.search(plan.searchText, queryVector, 30)).filter(item => relevant.has(item.chunkId))
          .map(item => ({ ...item, coverage: relevant.get(item.chunkId)!.coverage, semantic: relevant.get(item.chunkId)!.semantic }));
        const seen = new Set(remote.map(item => item.chunkId));
        candidates = [...remote, ...localCandidates.filter(item => !seen.has(item.chunkId))];
      }
      catch { audit("search_fallback", {}); }
    }
    lap("search");
    if (plan.window) {
      candidates = candidates.filter(item => {
        const doc = this.index.documents.get(item.docId);
        return !doc || inWindow(doc, plan);
      });
    }
    if (within) candidates = candidates.filter(item => within.has(item.docId));
    const candidateDocIds = [...new Set(candidates.map(candidate => candidate.docId))];
    audit("candidates_found", { count: candidateDocIds.length });
    for (const candidate of candidates) {
      audit("candidate_ranked", {
        ...this.auditDocument(candidate.docId),
        chunkRef: auditRef(candidate.chunkId),
        score: Number(candidate.score.toFixed(4))
      });
    }

    const allowedIds = await authorize(candidateDocIds);
    lap("authorize");
    if (!allowedIds.size) return this.noResult(user, traceId, scope);

    const asksForHistory = /\b(superseded|old|draft|historical|previous)\b/i.test(trimmed);
    const allowedHits = candidates.filter(item => allowedIds.has(item.docId));
    // Outside a project, a weak partial match drops out before its links are followed, and so does one that doesn't
    // name the issue the question names.
    const hits = within ? allowedHits : namedIssueHits(coveringHits(allowedHits, item =>
      asksForHistory || this.index.documents.get(item.docId)?.metadata.status !== "superseded"), trimmed, docId => {
      const doc = this.index.documents.get(docId);
      return doc ? `${doc.title}\n${doc.content}` : "";
    });
    const linked = this.linkedCandidates(candidates, new Set(hits.map(item => item.docId)), plan, audit, within);
    const linkedAllowed = linked.length ? await authorize([...new Set(linked.map(item => item.docId))]) : new Set<string>();
    const authorizedCandidates: Array<SearchCandidate & { linkedFrom?: string }> = [
      ...hits,
      ...linked.filter(item => linkedAllowed.has(item.docId))
    ];
    const currentCandidates = authorizedCandidates.filter(item =>
      this.index.documents.get(item.docId)?.metadata.status !== "superseded");
    const answerCandidates = balanceBySource(!asksForHistory && currentCandidates.length ? currentCandidates : authorizedCandidates,
      plan.sources, docId => this.index.documents.get(docId)?.source);

    // ④ Each document is checked at its source once per question, before its text is used.
    const liveChecks = new Map<string, Promise<SourceDocument | undefined>>();
    const liveCheck = (docId: string) => {
      let check = liveChecks.get(docId);
      if (!check) {
        const indexedVersion = this.index.documents.get(docId)?.version;
        check = this.liveAuthorizedDocument(user, docId).then(doc => {
          audit("live_access_decision", {
            ...this.auditDocument(docId), allowed: Boolean(doc),
            ...(doc ? { sourceVersion: doc.version, refreshed: doc.version !== indexedVersion } : {})
          });
          return doc;
        });
        liveChecks.set(docId, check);
      }
      return check;
    };
    const context: Array<{ citation: string; text: string }> = [];
    const chunkTexts = new Map<string, string>();
    const citationMap = new Map<string, Citation>();
    for (const candidate of answerCandidates) {
      if (context.length >= 8) break;
      // A linked item counts only while the item it came through still passes its own live check.
      if (candidate.linkedFrom && !await liveCheck(candidate.linkedFrom)) continue;
      if (!await liveCheck(candidate.docId)) continue;

      const indexed = this.index.documents.get(candidate.docId);
      const freshChunk = indexed?.chunks.find(item => item.chunkId === candidate.chunkId);
      if (!indexed || !freshChunk) continue;
      context.push({ citation: freshChunk.chunkId, text: withJiraStatus(indexed, freshChunk.text) });
      chunkTexts.set(freshChunk.chunkId, freshChunk.text);
      citationMap.set(freshChunk.chunkId, {
        docId: indexed.docId,
        chunkId: freshChunk.chunkId,
        title: indexed.title,
        url: freshChunk.sourceUrl ?? indexed.url,
        version: indexed.version,
        updatedAt: indexed.updatedAt,
        lastIndexedAt: indexed.lastIndexedAt,
        ...(candidate.linkedFrom ? { linkedFrom: candidate.linkedFrom } : {})
      });
    }

    lap("live_checks");
    if (!context.length) return this.noResult(user, traceId, scope);
    audit("context_sent", { chunkIds: [...citationMap.keys()] });
    await this.audit.flush();
    lap("audit_context");
    const evidence = new Map(context.map(item => [item.citation, item.text]));
    let generated: string;
    // If the organization's own model can't be looked up, answer with the built-in writer rather than send the
    // organization's context to a model it didn't choose.
    let model: LlmClient = this.llm;
    try {
      model = (await this.orgLlm?.current()) ?? this.llm;
    } catch {
      model = this.fallbackLlm;
    }
    let fromModel = !(model instanceof LocalGroundedLlm);
    try {
      generated = await model.generate(context, trimmed);
    } catch (error) {
      audit("llm_fallback", { reason: error instanceof ModelUnavailable ? error.reason : "error" });
      generated = await this.fallbackLlm.generate(context, trimmed);
      fromModel = false;
    }
    lap("model");
    // Each line must say only what a passage it cites says (packages/retrieval/src/grounding.ts).
    let checked = checkAnswer(generated, citationMap, evidence);
    const leftOut = checked.report.removed;
    let fellBack = false;
    // Nothing the model wrote is backed by the sources: answer as if no model were set.
    if (fromModel && checked.answer.text === NO_RESULT) {
      audit("llm_fallback", { reason: "ungrounded" });
      checked = checkAnswer(await this.fallbackLlm.generate(context, trimmed), citationMap, evidence);
      fellBack = true;
    }
    // After a fallback the asker isn't told about the model's lines, which would say which writer answered (D57).
    const answer = fellBack && checked.answer.check
      ? { ...checked.answer, check: { ...checked.answer.check, removed: [] } } : checked.answer;
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
    lap("revalidate_and_recheck");
    audit("answer_returned", {
      answer: answer.text,
      documents: answer.citations.map(citation => this.auditDocument(citation.docId)),
      citationIds: answer.citations.map(citation => citation.chunkId),
      empty: answer.text === NO_RESULT,
      // What the checker kept, and what it left out with the text and the reason, for compliance (D63).
      ...(checked.report.lines.length || leftOut.length ? { check: {
        lines: checked.report.lines.map(line => line.kind), removed: leftOut, ...(fellBack ? { fallback: true } : {})
      } } : {})
    });
    return scope ? { ...answer, scope } : answer;
  }

  /**
   * The one project a question names: every distinctive word of its name, the master page's title, is in the question.
   * None when it names two or more. Its items are counted as the workspace counts them, before any access check.
   */
  private namedProject(question: string): Project | undefined {
    const asked = new Set(terms(question));
    const docs = [...this.index.documents.values()].filter(doc => !doc.deletedAt);
    const named = docs.filter(doc => doc.source === "confluence" && doc.metadata.label === "master" && doc.metadata.space)
      .filter(master => {
        const words = distinctiveWords(master.title.replace(/\s+master page$/i, ""));
        return words.length > 0 && words.every(word => asked.has(word));
      });
    if (named.length !== 1) return undefined;
    return projectsFor(docs.map(doc => ({ ...doc, links: doc.links ?? [] }))).find(item => item.masterDocId === named[0].docId);
  }

  /** The items one link away, in either direction, that still exist: what this item links to, and what links to it. */
  linkedIds(docId: string): string[] {
    return this.linkGraph()(docId);
  }

  // Reads every item's links once, so looking up many items costs one pass over the index.
  private linkGraph(): (docId: string) => string[] {
    const exists = (id: string) => { const doc = this.index.documents.get(id); return Boolean(doc && !doc.deletedAt); };
    const incoming = new Map<string, string[]>();
    for (const doc of this.index.documents.values()) {
      if (doc.deletedAt) continue;
      for (const target of doc.links ?? []) incoming.set(target, [...(incoming.get(target) ?? []), doc.docId]);
    }
    return docId => {
      if (!exists(docId)) return [];
      const found = new Set([...(this.index.documents.get(docId)!.links ?? []), ...(incoming.get(docId) ?? [])]);
      found.delete(docId);
      return [...found].filter(exists).sort();
    };
  }

  /**
   * Candidates reached by one link from what search found. Links are followed only from documents the asker may open
   * that clearly match, scoring at least half the best of them, up to eight: a denied document's links are never
   * followed, so nothing hidden can steer an answer. Links add only what search didn't find. A linked item matched
   * nothing in the question, so it brings its first chunk, scores half the item it came through, and keeps to the
   * question's time window like any search result.
   */
  private linkedCandidates(candidates: SearchCandidate[], allowedIds: Set<string>, plan: QueryPlan,
    audit: (type: string, data: Record<string, unknown>) => void, within?: Set<string>): Array<SearchCandidate & { linkedFrom: string }> {
    const best = new Map<string, SearchCandidate>();
    for (const candidate of candidates) {
      if (!allowedIds.has(candidate.docId)) continue;
      const current = best.get(candidate.docId);
      if (!current || candidate.score > current.score) best.set(candidate.docId, candidate);
    }
    const top = Math.max(0, ...[...best.values()].map(item => item.score));
    const sources = [...best.values()].filter(item => item.score >= top / 2).sort((a, b) => b.score - a.score).slice(0, 8);
    const searched = new Set(candidates.map(item => item.docId));
    const linked = new Map<string, SearchCandidate & { linkedFrom: string }>();
    const linkedTo = this.linkGraph();
    for (const from of sources) {
      for (const docId of linkedTo(from.docId)) {
        const doc = this.index.documents.get(docId);
        const first = doc?.chunks[0];
        const score = from.score / 2;
        if (searched.has(docId) || !doc || !first || !inWindow(doc, plan) || (within && !within.has(docId)) ||
          (linked.get(docId)?.score ?? -1) >= score) continue;
        linked.set(docId, { docId, chunkId: first.chunkId, score, linkedFrom: from.docId });
      }
    }
    const ranked = [...linked.values()].sort((a, b) => b.score - a.score);
    for (const item of ranked) {
      audit("candidate_linked", { ...this.auditDocument(item.docId), chunkRef: auditRef(item.chunkId),
        score: Number(item.score.toFixed(4)), fromDocId: item.linkedFrom, fromRef: auditRef(item.linkedFrom) });
    }
    return ranked;
  }

  async visibleDocuments(user: User): Promise<Array<WorkspaceDocument & { tier: Tier; lastIndexedAt: string; lastPermissionSyncAt: string }>> {
    const visible: Array<Omit<WorkspaceDocument, "links"> & { tier: Tier; lastIndexedAt: string; lastPermissionSyncAt: string }> = [];
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
        lastPermissionSyncAt: fresh.lastPermissionSyncAt,
        ...("slackMessages" in fresh ? { slackMessages: fresh.slackMessages as WorkspaceDocument["slackMessages"] } : {})
      });
    }
    // Links name only what this person may also open, so a link never reveals a hidden item.
    const ids = new Set(visible.map(doc => doc.docId));
    const linked = this.linkGraph();
    return visible.map(doc => ({ ...doc, links: linked(doc.docId).filter(id => ids.has(id)) }));
  }

  /**
   * A catch-up chosen by the person's role and groups, asked like any question, so it is checked and audited the same
   * way. A project counts only if the person may open its master page; the answer then keeps to that project's items.
   * Compliance gets the last 7 days of the audit trail instead.
   */
  async catchUp(user: User, projectKey?: string, onTrace?: (traceId: string) => void,
    revalidateUser?: () => Promise<User | undefined>, now = new Date()): Promise<
    { kind: "audit"; lines: string[]; importNotice?: string } | { kind: "question"; question: string; answer: QueryAnswer; importNotice?: string }> {
    this.assertOrg(user);
    if (user.role === "compliance") {
      return { kind: "audit", lines: auditSummary(this.audit.entries, this.audit.batches, actor => this.user(actor)?.name ?? actor,
        now, this.audit.verifyChain() && this.audit.verifyBatches()), importNotice: this.importNotice() };
    }
    const project = projectKey ? projectsFor(await this.visibleDocuments(user)).find(item => item.key === projectKey) : undefined;
    const question = catchUpQuestion(user, project)!;
    const answer = await this.query(user, question, onTrace, revalidateUser,
      project ? { within: { project: project.name, docIds: project.docIds } } : {});
    return { kind: "question", question, answer, importNotice: this.importNotice() };
  }

  private serializeReview<T>(command: () => Promise<T>): Promise<T> {
    const next = (reviewQueues.get(this.orgId) ?? Promise.resolve()).catch(() => undefined).then(command);
    reviewQueues.set(this.orgId, next);
    void next.catch(() => undefined).then(() => { if (reviewQueues.get(this.orgId) === next) reviewQueues.delete(this.orgId); });
    return next;
  }

  private async proposalSource(actor: User, id: string, revision: number): Promise<{ proposal: Proposal; documents: Awaited<ReturnType<Brain["visibleDocuments"]>> }> {
    this.assertOrg(actor);
    const proposal = await this.taskStore.getProposal(id);
    const documents = await this.visibleDocuments(actor);
    if (!proposal || !this.proposalHasEvidence(proposal, documents)) throw new Error("Unknown document");
    if (proposal.revision !== revision || proposal.status !== "pending") throw new Error("Stale commitment revision");
    return { proposal, documents };
  }

  private proposalHasEvidence(proposal: Proposal, documents: readonly WorkspaceDocument[]): boolean {
    const thread = documents.find(doc => doc.docId === `slack:${proposal.suggestion.c}` && doc.source === "slack");
    if (!thread || !proposal.suggestion.s) return false;
    return thread.slackMessages?.length ? thread.slackMessages.some(message => message.channelId === proposal.suggestion.c &&
      message.messageTs === proposal.suggestion.ts && (!proposal.teamId || message.teamId === proposal.teamId) &&
      (!proposal.authorSlackId || message.authorSlackId === proposal.authorSlackId) && message.text.includes(proposal.suggestion.s))
      : thread.content.includes(proposal.suggestion.s);
  }

  private slackId(user: User): string | undefined {
    const id = this.slackUserIds[user.id] ?? user.platformIdentities?.slack;
    return id && (!this.liveMode || /^[UW][A-Z0-9]+$/.test(id)) ? id : undefined;
  }

  private async rememberCommitmentLink(actor: User, proposal: Proposal, issueKey: string, issueUrl: string): Promise<void> {
    const fingerprint = commitmentFingerprint(proposal.id);
    const titleFingerprint = taskFingerprint(proposal.suggestion.p, proposal.suggestion.t);
    if ((await this.taskStore.findTask(proposal.suggestion.p, titleFingerprint, []))?.fingerprint === fingerprint) return;
    await this.taskStore.saveTask({ fingerprint, titleFingerprint: taskFingerprint(proposal.suggestion.p, proposal.suggestion.t),
      project: proposal.suggestion.p, title: proposal.suggestion.t, tokens: taskTokens(proposal.suggestion.t), issueKey, issueUrl,
      assigneeSlackId: proposal.suggestion.a, trackedBy: this.slackId(actor) ?? actor.id,
      channel: proposal.suggestion.c, messageTs: proposal.suggestion.ts, threadTs: proposal.suggestion.th,
      teamId: proposal.teamId, authorSlackId: proposal.authorSlackId, permalink: proposal.permalink, mentionCount: 1 });
  }

  async reviewCommitment(actor: User, input: { id: string; revision: number } &
    ({ action: "edit"; summary: string; ownerSlackId?: string; dueDate?: string } | { action: "dismiss" } | { action: "link"; issueDocId: string })) {
    return this.serializeReview(async () => {
      const { proposal, documents } = await this.proposalSource(actor, input.id, input.revision);
      const next: Proposal = { ...proposal, revision: proposal.revision + 1, reviewedBy: actor.id, reviewedAt: new Date().toISOString() };
      if (input.action === "edit") {
        const title = input.summary.trim();
        if (!title || title.length > 200 || (input.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ||
          !Number.isFinite(Date.parse(input.dueDate)) || new Date(input.dueDate).toISOString().slice(0, 10) !== input.dueDate))) throw new Error("Invalid commitment");
        const owner = input.ownerSlackId?.trim() ?? "";
        if (owner && !this.users.some(user => user.active !== false && (user.orgId ?? "demo-company-a") === this.orgId &&
          this.slackId(user) === owner)) throw new Error("Unknown user");
        next.suggestion = { ...proposal.suggestion, t: title, a: owner, d: input.dueDate || undefined };
      } else if (input.action === "dismiss") next.status = "dismissed";
      else {
        const issue = documents.find(doc => doc.docId === input.issueDocId && doc.source === "jira" && doc.metadata.project === proposal.suggestion.p);
        if (!issue) throw new Error("Unknown document");
        next.status = "linked";
        next.issueKey = issue.docId.slice(5);
        next.issueUrl = issue.url;
      }
      if (!await this.taskStore.saveProposal(next, proposal.revision)) throw new Error("Stale commitment revision");
      if (input.action === "link") await this.rememberCommitmentLink(actor, next, next.issueKey!, next.issueUrl!);
      this.audit.append("commitment_reviewed", actor.id, { action: input.action, fromDocId: `slack:${proposal.suggestion.c}`, revision: next.revision });
      return { id: next.id, revision: next.revision, status: next.status };
    });
  }

  /** Everything the workspace shows, computed from the documents this person may open and nothing else. */
  async workspace(user: User, now = new Date()) {
    const documents = await this.visibleDocuments(user);
    const projects = projectsFor(documents);
    const stored = await this.taskStore.listProposals();
    for (const item of agreementsFor(documents, this.liveMode)) {
      const channel = item.message?.channelId ?? item.threadDocId.slice(6);
      const ts = item.message?.messageTs ?? createHash("sha256").update(`${item.threadDocId}\0${item.sentence}`).digest("hex");
      if (stored.some(proposal => proposal.suggestion.c === channel && proposal.suggestion.ts === ts &&
        (!item.message || !proposal.teamId || proposal.teamId === item.message.teamId))) continue;
      const owner = item.message && /^I\s/i.test(item.sentence) ? this.users.find(person => person.active !== false &&
        (person.orgId ?? "demo-company-a") === this.orgId && this.slackId(person) === item.message!.authorSlackId) : undefined;
      const ownerSlackId = owner ? this.slackId(owner) : undefined;
      const proposal: Proposal = { id: proposalId(channel, ts, item.message?.teamId), revision: 1,
        status: "pending", suggestion: { t: item.summary, a: ownerSlackId ?? "", p: item.project, c: channel, ts,
          th: item.message?.threadTs, s: item.sentence }, ...(item.message ? { teamId: item.message.teamId,
          authorSlackId: item.message.authorSlackId, permalink: item.message.permalink } : {}) };
      if (await this.taskStore.saveProposal(proposal)) stored.push(proposal);
    }
    const lastSync = this.states.get("jira")?.lastSuccessfulSyncAt;
    for (const proposal of stored.filter(item => ["linked", "created"].includes(item.status) && item.issueKey)) {
      const thread = documents.find(doc => doc.docId === `slack:${proposal.suggestion.c}`);
      const issue = documents.find(doc => doc.docId === `jira:${proposal.issueKey}`);
      if (thread && issue && this.proposalHasEvidence(proposal, documents)) await this.rememberCommitmentLink(this.user(proposal.reviewedBy ?? "") ?? user, proposal, proposal.issueKey!, issue.url);
    }
    const commitments = stored.flatMap(proposal => {
      const threadDocId = `slack:${proposal.suggestion.c}`;
      const thread = documents.find(doc => doc.docId === threadDocId && doc.source === "slack");
      if (!thread || proposal.status === "dismissed" || !this.proposalHasEvidence(proposal, documents)) return [];
      if (proposal.status === "pending" && tracked(proposal.suggestion.s, documents.filter(doc => doc.source === "jira"))) return [];
      const linked = proposal.issueKey ? documents.find(doc => doc.docId === `jira:${proposal.issueKey}`) : undefined;
      if (proposal.issueKey && !linked) return [];
      const words = new Set(terms(proposal.suggestion.t));
      const candidates = documents.filter(doc => doc.source === "jira" && doc.metadata.project === proposal.suggestion.p)
        .map(doc => ({ docId: doc.docId, title: doc.title, url: doc.url, score: terms(doc.title + " " + doc.content).filter(word => words.has(word)).length }))
        .filter(doc => doc.score >= 2).sort((a, b) => b.score - a.score).slice(0, 5)
        .map(({ score: _score, ...candidate }) => candidate);
      const example = documents.find(doc => doc.source === "jira" && doc.metadata.project === proposal.suggestion.p);
      return [{ id: proposal.id, revision: proposal.revision, status: proposal.status, threadDocId, sentence: proposal.suggestion.s,
        project: proposal.suggestion.p, summary: proposal.suggestion.t, ownerSlackId: proposal.suggestion.a, dueDate: proposal.suggestion.d,
        canCreate: (!this.liveMode || Boolean(this.liveJira)) && proposal.status === "pending", permalink: proposal.permalink, candidates,
        ...(example ? { jiraUrl: example.url.replace(/\/browse\/[^/?#]+.*$/, `/browse/${proposal.suggestion.p}`) } : {}),
        ...(linked ? { issueDocId: linked.docId, issueTitle: linked.title, issueUrl: linked.url } : {}),
        notice: `Possible untracked commitment. Review visible ${proposal.suggestion.p} Jira candidates before creating work. ` +
          `Matching covers your accessible, imported sources${lastSync ? ` as of ${lastSync}` : "; no successful Jira sync recorded"}.`,
        importNotice: this.importNotice() }];
    });
    return { documents, projects, latest: latestFor(documents, projects, now), duplicates: duplicatesFor(documents, now),
      suggestions: commitments.filter(item => item.status === "pending"), commitments, importNotice: this.importNotice(),
      capabilities: { mode: this.liveMode ? "live" : "demo", createTask: !this.liveMode || Boolean(this.liveJira), markDone: !this.liveMode || Boolean(this.liveJira) },
      owners: this.users.filter(person => person.active !== false && (person.orgId ?? "demo-company-a") === this.orgId && this.slackId(person))
        .map(person => ({ slackId: this.slackId(person)!, name: person.name })) };
  }

  /**
   * Creates a Jira task from an agreement in a thread, on mock sources only: the app only reads live ones. The task's
   * title and text come from the agreed sentence alone. It copies the permissions and tier of the project issue it's
   * modelled on (the one the thread links to, else the project's latest), so it is never visible to more people.
   */
  async createTask(actor: User, threadDocId: string, sentence: string, approved?: { proposalId: string; revision: number }): Promise<{ docId: string; title: string }> {
    return this.serializeReview(() => this.createReviewedTask(actor, threadDocId, sentence, approved));
  }

  private async createReviewedTask(actor: User, threadDocId: string, sentence: string, approved?: { proposalId: string; revision: number }): Promise<{ docId: string; title: string }> {
    this.assertOrg(actor);
    if (this.liveMode && !this.liveJira) throw new Error("Live sources are read-only");
    let reviewed = approved ? await this.proposalSource(actor, approved.proposalId, approved.revision) : undefined;
    if (reviewed && (`slack:${reviewed.proposal.suggestion.c}` !== threadDocId || reviewed.proposal.suggestion.s !== sentence)) throw new Error("Unknown document");
    const documents = reviewed?.documents ?? await this.visibleDocuments(actor);
    const thread = documents.find(doc => doc.docId === threadDocId && doc.source === "slack");
    if (!thread) throw new Error("Unknown document");
    const issues = documents.filter(doc => doc.source === "jira");
    const summary = reviewed ? reviewed.proposal.suggestion.t : sentences(thread.content).includes(sentence) ? agreementSummary(sentence) : undefined;
    // A reviewed live commitment goes to the project it was reviewed for; otherwise the project the thread works in.
    const project = this.liveMode && reviewed?.proposal.suggestion.p ? reviewed.proposal.suggestion.p : projectOf(thread, issues);
    if (!summary || !project || !/^[A-Z][A-Z0-9]{0,9}$/.test(project)) throw new Error("Not an agreement in that thread");
    if (!approved && tracked(sentence, issues)) throw new Error("Already tracked");
    if (!reviewed) {
      const channel = threadDocId.slice(6);
      const ts = createHash("sha256").update(`${threadDocId}\0${sentence}`).digest("hex");
      const existing = (await this.taskStore.listProposals()).find(proposal => proposal.suggestion.c === channel && proposal.suggestion.s === sentence);
      if (existing && (existing.status !== "pending" || existing.revision !== 1)) throw new Error("Stale commitment revision");
      const proposal: Proposal = existing ?? { id: proposalId(channel, ts), revision: 1, status: "pending",
        suggestion: { t: summary, a: "", p: project, c: channel, ts, s: sentence } };
      if (!existing && !await this.taskStore.saveProposal(proposal)) throw new Error("Stale commitment revision");
      reviewed = { proposal, documents };
    }
    if (this.liveMode) return this.createLiveTask(actor, reviewed.proposal, thread, summary, project);
    const declared = this.index.documents.get(threadDocId)?.links ?? [];
    const inProject = issues.filter(issue => issue.metadata.project === project);
    const model = inProject.find(issue => declared.includes(issue.docId)) ??
      [...inProject].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const modelPermissions = model && await this.connectors.jira.fetchPermissions(model.docId);
    if (!model || !modelPermissions) throw new Error("Unknown document");
    const permissions = this.narrowedToThread(modelPermissions, model.tier, threadDocId);
    const numbers = (await this.connectors.jira.listIds()).map(id => id.match(new RegExp(`^jira:${project}-(\\d+)$`))?.[1])
      .filter((value): value is string => Boolean(value)).map(Number);
    let operation = await this.taskStore.reserveOperation(reviewed.proposal, `workspace-demo:${actor.id}`);
    if (!operation || operation.proposalId !== reviewed.proposal.id || operation.proposalRevision !== reviewed.proposal.revision ||
      operation.actorSlackId !== `workspace-demo:${actor.id}` || operation.existing) throw new Error("Stale commitment revision");
    const key = operation.issueKey ?? `${project}-${Math.max(0, ...numbers) + 1}`;
    const doc: SourceDocument = {
      docId: `jira:${key}`, source: "jira", sourceNativeId: key, title: `${key} ${summary}`,
      content: `${key} tracks the agreement in ${thread.title}: "${sentence}"`,
      url: operation.issueUrl ?? model.url.replace(/\/browse\/[^/?#]+.*$/, `/browse/${key}`), version: 1, updatedAt: new Date().toISOString(),
      metadata: { project, status: "open", ...(reviewed?.proposal.suggestion.a ? { ownerSlackId: reviewed.proposal.suggestion.a } : {}),
        ...(reviewed?.proposal.suggestion.d ? { dueDate: reviewed.proposal.suggestion.d } : {}) }, permissions, tier: model.tier, links: [threadDocId]
    };
    if (operation.state === "reserved" || operation.state === "refused") {
      if (tracked(sentence, issues)) {
        await this.taskStore.advanceOperation(operation.id, operation.state, { state: "refused" });
        throw new Error("Already tracked");
      }
      const creating = await this.taskStore.advanceOperation(operation.id, operation.state, { state: "creating", issueKey: key, issueUrl: doc.url });
      if (!creating) throw new Error("Stale commitment revision");
      operation = creating;
      try { this.connectors.jira.create(doc); }
      catch (error) {
        await this.taskStore.advanceOperation(operation.id, "creating", { state: "uncertain" });
        await this.persist();
        throw error;
      }
      await this.persist();
    } else {
      const existing = operation.issueKey && await this.connectors.jira.fetchDocument(doc.docId);
      if (!existing || existing.sourceNativeId !== key || existing.title !== doc.title || existing.content !== doc.content ||
        existing.url !== doc.url || existing.metadata.project !== project || existing.metadata.ownerSlackId !== doc.metadata.ownerSlackId ||
        existing.metadata.dueDate !== doc.metadata.dueDate || !existing.links?.includes(threadDocId)) {
        throw new Error("Mock task outcome needs reconciliation");
      }
    }
    if (operation.state !== "remote_succeeded") {
      const receipt = await this.taskStore.advanceOperation(operation.id, operation.state, { state: "remote_succeeded", issueKey: key, issueUrl: doc.url });
      if (!receipt) throw new Error("Mock task outcome needs reconciliation");
      operation = receipt;
    }
    await this.sync("jira");
    const completed = await this.taskStore.completeProposal(reviewed.proposal.id, reviewed.proposal.revision, operation.id, actor.id, new Date().toISOString());
    if (!completed) throw new Error("Stale commitment revision");
    await this.rememberCommitmentLink(actor, completed, key, doc.url);
    this.audit.append("task_created", actor.id, { ...this.auditDocument(doc.docId), fromDocId: threadDocId });
    return { docId: doc.docId, title: doc.title };
  }

  /**
   * Creates the reviewed task in the company's Jira, through the shared connection, for a person whose own Jira account may
   * create issues in that project. Jira receives the approved summary and an operation marker only, never the thread's
   * text or name. Each attempt is reserved first, so a repeat never creates a second issue, and an attempt whose result
   * is unknown stays blocked until it is reconciled.
   */
  private async createLiveTask(actor: User, proposal: Proposal, thread: { docId: string }, summary: string, project: string): Promise<{ docId: string; title: string }> {
    const jira = this.liveJira!;
    if (!await jira.canCreate(actor, project)) throw new Error("Your Jira account can't create issues in that project");
    let operation = await this.taskStore.reserveOperation(proposal, `workspace:${actor.id}`);
    if (!operation || operation.proposalId !== proposal.id || operation.proposalRevision !== proposal.revision ||
      operation.actorSlackId !== `workspace:${actor.id}` || operation.existing) throw new Error("Stale commitment revision");
    if (operation.state === "reserved" || operation.state === "refused") {
      const creating = await this.taskStore.advanceOperation(operation.id, operation.state, { state: "creating" });
      if (!creating) throw new Error("Stale commitment revision");
      operation = creating;
      let created: { key: string; url: string } | undefined;
      try { created = await jira.createIssue(actor, { project, summary, description: `Approved summary: ${summary}\nBroppy operation: ${operation.id}` }); }
      catch (error) {
        await this.taskStore.advanceOperation(operation.id, "creating", { state: "uncertain" }).catch(() => undefined);
        console.error("Jira task needs reconciliation", { operationId: operation.id, error: error instanceof Error ? error.message : String(error) });
        throw new Error("We couldn't confirm whether Jira created the task. Check Jira before trying again.");
      }
      if (!created) {
        await this.taskStore.advanceOperation(operation.id, "creating", { state: "refused" });
        throw new Error("Connect Jira first");
      }
      const receipt = await this.taskStore.advanceOperation(operation.id, "creating", { state: "remote_succeeded", issueKey: created.key, issueUrl: created.url });
      if (!receipt) throw new Error("Stale commitment revision");
      operation = receipt;
    }
    if (operation.state !== "remote_succeeded" || !operation.issueKey || !operation.issueUrl) {
      throw new Error("We couldn't confirm whether Jira created the task. Check Jira before trying again.");
    }
    const completed = await this.taskStore.completeProposal(proposal.id, proposal.revision, operation.id, actor.id, new Date().toISOString());
    if (!completed) throw new Error("Stale commitment revision");
    await this.rememberCommitmentLink(actor, completed, operation.issueKey, operation.issueUrl);
    const docId = `jira:${operation.issueKey}`;
    this.audit.append("task_created", actor.id, { docId, source: "jira", project, fromDocId: thread.docId });
    // The new issue shows in the workspace once the next Jira sync reads it; a failed sync here is retried by the scheduler.
    await this.sync("jira").catch(() => undefined);
    return { docId, title: `${operation.issueKey} ${summary}` };
  }

  /**
   * The task quotes the thread, so its readers must be a subset of the thread's readers. When the model issue would
   * let anyone in who can't open the thread, the permissions shrink to exactly the people who can open both.
   */
  private narrowedToThread(model: SourcePermission, tier: Tier, threadDocId: string): SourcePermission {
    const probe = { docId: "task-audience", permissions: model, tier };
    const modelGrants = new FgaAdapter();
    modelGrants.upsert(probe);
    const both = this.users.filter(user => modelGrants.check(user, probe.docId).allowed);
    const readers = both.filter(user => this.fga.check(user, threadDocId).allowed);
    if (readers.length === both.length) return model;
    const jiraIdentity = (user: User) => user.platformIdentities?.jira;
    return {
      users: readers.map(user => user.email), groups: [], public: false,
      native: model.native?.source === "jira"
        ? { ...model.native, issueViewers: readers.map(jiraIdentity).filter((id): id is string => Boolean(id)) }
        : model.native
    };
  }

  /** Marks a Jira task done, on mock sources only. A status is metadata, so nothing is re-chunked or re-embedded. */
  async markDone(actor: User, docId: string): Promise<void> {
    this.assertOrg(actor);
    if (this.liveMode && !this.liveJira) throw new Error("Live sources are read-only");
    if (!docId.startsWith("jira:")) throw new Error("Only Jira tasks can be marked done");
    const issue = this.fga.check(actor, docId).allowed ? await this.liveAuthorizedDocument(actor, docId) : undefined;
    if (!issue) throw new Error("Unknown document");
    if (issue.metadata.status === "done") return;
    if (this.liveMode) {
      // Jira decides: the person's own account must be allowed to move the issue, and the workflow must reach done.
      if (!await this.liveJira!.markDone(actor, docId.slice("jira:".length))) throw new Error("Jira didn't let you mark this task done");
      this.audit.append("task_status_changed", actor.id, { ...this.auditDocument(docId), status: "done" });
      await this.sync("jira").catch(() => undefined);
      return;
    }
    this.connectors.jira.updateMetadata(docId, { status: "done" });
    await this.sync("jira");
    this.audit.append("task_status_changed", actor.id, { ...this.auditDocument(docId), status: "done" });
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

  /** An explicit block: the person loses this document whatever the source, the tier or any grant would allow. */
  async blockUser(actor: User, docId: string, userId: string): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (!this.user(userId)) throw new Error("Unknown user");
    this.fga.block(docId, userId);
    this.audit.append("user_blocked", actor.id, { ...this.auditDocument(docId), userId });
    await this.persist();
  }

  async unblockUser(actor: User, docId: string, userId: string): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (!this.user(userId)) throw new Error("Unknown user");
    this.fga.unblock(docId, userId);
    this.audit.append("user_unblocked", actor.id, { ...this.auditDocument(docId), userId });
    await this.persist();
  }

  /** Lets one person past the tier of a restricted document, for a stated reason, until a date at most 90 days away. The admin who approves it is its owner. */
  async grantRestricted(actor: User, docId: string, userId: string, reason: string, expiresAt: string): Promise<void> {
    this.assertOrg(actor);
    if (actor.role !== "admin") throw new Error("Forbidden");
    if (!this.user(userId)) throw new Error("Unknown user");
    this.fga.grantRestricted(docId, { userId, owner: actor.id, reason: reason.trim(), expiresAt });
    this.audit.append("restricted_grant_created", actor.id, { ...this.auditDocument(docId), userId, reason: reason.trim(), expiresAt });
    await this.persist();
  }

  /** Removes restricted grants that have ended, and records each one. */
  sweepRestrictedGrants(now = new Date()): void {
    for (const item of this.fga.sweepExpired(now)) {
      this.audit.append("restricted_grant_expired", "sync", { ...this.auditDocument(item.docId), userId: item.userId, owner: item.owner });
    }
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

  /**
   * Reads one person's access to every live item now, so a new hire or a changed source account doesn't wait for the
   * hourly permission pass. It only adds: people lose access through the source check on each answer, which needs no
   * help. Work stops at the budget, and what is left is reported.
   */
  async refreshAccessFor(user: User, budgetMs = 15_000): Promise<AccessRefresh> {
    this.assertOrg(user);
    const result: AccessRefresh = { checked: 0, added: 0, failed: 0, remaining: 0 };
    if (!this.liveMode || user.active === false) return result;
    const deadline = Date.now() + budgetMs;
    const ids = [...this.index.documents.values()].filter(doc => !doc.deletedAt).map(doc => doc.docId);
    for (let i = 0; i < ids.length; i += 5) {
      if (Date.now() > deadline) { result.remaining = ids.length - i; break; }
      await Promise.all(ids.slice(i, i + 5).map(async docId => {
        try {
          const connector = this.connector(docId);
          if (this.connections.get(connector.source)?.status === "Not connected") return;
          result.checked++;
          if (!await connector.checkAccess(user, docId)) return;
          const indexed = this.index.documents.get(docId);
          const permissions = indexed && !indexed.deletedAt ? withViewer(indexed.permissions, user) : undefined;
          if (!indexed || !permissions) return;
          this.index.upsert({ ...indexed, permissions });
          this.fga.upsert({ docId, permissions, tier: indexed.tier });
          await this.persistSearch(docId, false);
          if (this.remoteFga) {
            try { await this.remoteFga.syncDocument({ docId, permissions, tier: indexed.tier }); this.remoteSynced.add(docId); }
            catch { this.remoteSynced.delete(docId); }
          }
          result.added++;
        } catch { result.failed++; }
      }));
    }
    this.audit.append("access_refreshed", user.id, { scope: "person", ...result });
    return result;
  }

  /** Re-reads the permissions of every live item at the source, for the admin's Refresh access. Stops at the budget. */
  async refreshAllAccess(actor: User, budgetMs = 25_000, from = 0): Promise<AccessRefresh> {
    this.assertOrg(actor);
    const result: AccessRefresh = { checked: 0, added: 0, failed: 0, remaining: 0 };
    if (!this.liveMode) return result;
    const deadline = Date.now() + budgetMs;
    const ids = [...this.index.documents.values()].filter(doc => !doc.deletedAt).map(doc => doc.docId).sort();
    for (let i = Math.max(0, from); i < ids.length; i += 3) {
      if (Date.now() > deadline) { result.remaining = ids.length - i; result.next = i; break; }
      await Promise.all(ids.slice(i, i + 3).map(async docId => {
        try {
          if (this.connections.get(this.connector(docId).source)?.status === "Not connected") return;
          result.checked++;
          await this.refreshLive(docId);
        } catch { result.failed++; }
      }));
    }
    await this.persist();
    this.audit.append("access_refreshed", actor.id, { scope: "all", from, ...result });
    return result;
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

  private embeddingReady(): boolean {
    return Boolean(this.embedding) && (this.embedding?.available?.() ?? true) && Date.now() >= this.embeddingPausedUntil;
  }

  private pauseEmbedding(): void {
    this.embeddingPausedUntil = Date.now() + EMBEDDING_PAUSE_MS;
  }

  /** Embeds this source's documents that still lack vectors: after a failure, a pause or a restart. */
  private async retryMissingEmbeddings(source: Source): Promise<void> {
    for (const doc of [...this.index.documents.values()]) {
      if (!this.embeddingReady()) return;
      if (doc.source !== source || doc.deletedAt || this.index.semanticCount(doc.docId) === doc.chunks.length) continue;
      await this.persistSearch(doc.docId, false);
    }
  }

  private async persistSearch(docId: string, contentChanged: boolean): Promise<void> {
    const indexed = this.index.documents.get(docId);
    if (!indexed || indexed.deletedAt) return;
    // An embedding that fails, or waits out a pause or the budget, never stops sync: the document keeps keyword
    // search, and a later sync embeds it (retryMissingEmbeddings).
    let embedded = false;
    if (this.embeddingReady() && (contentChanged || this.index.semanticCount(docId) !== indexed.chunks.length)) {
      embedded = await this.index.refreshSemantic(docId, this.embedding!);
      if (!embedded) this.pauseEmbedding();
    }
    if (this.supabase) {
      // Vectors that arrive late rewrite the chunks, so Supabase's search gets them too.
      const rewriteChunks = contentChanged || embedded || !this.supabaseSynced.has(docId);
      try {
        await this.supabase.syncDocument(indexed, this.index.semanticVectorsFor(docId), rewriteChunks);
        this.supabaseSynced.add(docId);
      } catch (error) {
        this.supabaseSynced.delete(docId);
        throw error;
      }
    }
  }

  /** A source that errors counts as denied for this document, so the other sources still answer. */
  private async liveAuthorizedDocument(user: User, docId: string): Promise<SourceDocument | undefined> {
    try {
      return await this.checkedLiveDocument(user, docId);
    } catch {
      this.audit.append("source_check_failed", user.id, { ...this.auditDocument(docId) });
      return undefined;
    }
  }

  private async checkedLiveDocument(user: User, docId: string): Promise<SourceDocument | undefined> {
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

  /**
   * The model for a turn that carries no company content: the organization's, else the operator's. If the organization's
   * setting can't be read, none, so nothing goes to a model the organization didn't choose.
   */
  async conversationModel(): Promise<LlmClient | undefined> {
    try {
      const model = (await this.orgLlm?.current()) ?? this.llm;
      return model instanceof LocalGroundedLlm ? undefined : model;
    } catch { return undefined; }
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

/**
 * A question that names an issue ("Why is DB-15 blocked?") is about that issue. Once one of the matches names it, a
 * match that doesn't drops out unless it covers two or more of the question's other distinctive words, so every
 * blocked issue of another project doesn't crowd it out. Only the asker's allowed matches are read, so a document they
 * can't open never changes the result.
 */
export function namedIssueHits<T extends SearchCandidate>(hits: T[], question: string, text: (docId: string) => string): T[] {
  const keys = [...new Set((question.match(/(?<![A-Za-z0-9-])[A-Za-z][A-Za-z0-9]{1,9}-\d+(?![\d-])/g) ?? []).map(key => key.toUpperCase()))];
  if (!keys.length) return hits;
  const patterns = keys.map(key => new RegExp(`(?<![A-Za-z0-9-])${key}(?![\\d-])`, "i"));
  const names = (hit: T) => patterns.some(pattern => pattern.test(text(hit.docId)));
  return hits.some(names) ? hits.filter(hit => names(hit) || (hit.coverage ?? 0) >= 2) : hits;
}

/**
 * The search hits that cover enough of the question: at least half, rounded up, of the distinctive words the best
 * eligible hit covers. Only hits the asker may open are passed in, so a denied document can't move the bar. A hit
 * found by meaning alone stays if it is at least as close as the closest hit that clears the bar.
 */
export function coveringHits<T extends SearchCandidate>(hits: T[], eligible: (hit: T) => boolean): T[] {
  const base = hits.some(eligible) ? hits.filter(eligible) : hits;
  const required = Math.ceil(Math.max(0, ...base.map(hit => hit.coverage ?? 0)) / 2);
  const close = base.filter(hit => (hit.coverage ?? 0) >= required && hit.semantic !== undefined).map(hit => hit.semantic!);
  const closest = close.length ? Math.max(...close) : -Infinity;
  return hits.filter(hit => (hit.coverage ?? 0) >= required || (hit.semantic !== undefined && hit.semantic >= closest));
}

// The question's time window: it applies to the platforms the question names, or to every platform when it names none.
function inWindow(doc: SourceDocument, plan: QueryPlan): boolean {
  if (!plan.window || (plan.sources.length && !plan.sources.includes(doc.source))) return true;
  const updated = Date.parse(doc.updatedAt);
  return updated >= Date.parse(plan.window.from) && updated <= Date.parse(plan.window.to);
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

/** What a read of access did. `next` is where to carry on from when the time budget ran out. */
export interface AccessRefresh { checked: number; added: number; failed: number; remaining: number; next?: number }

/** The permission with this person added as a viewer, or undefined when they are already listed everywhere. */
function withViewer(permission: SourcePermission, user: User): SourcePermission | undefined {
  const native = permission.native;
  if (!native) return undefined;
  const account = user.platformIdentities?.[native.source] ?? user.email;
  let changed = false;
  const add = (list: string[], value: string): string[] => { if (list.includes(value)) return list; changed = true; return [...list, value]; };
  const addOpt = (list: string[] | undefined, value: string) => list && add(list, value);
  const users = add(permission.users, user.email);
  let next: NonNullable<SourcePermission["native"]>;
  if (native.source === "slack") next = { ...native, members: add(native.members, account) };
  else if (native.source === "jira") next = { ...native, projectViewers: add(native.projectViewers, account), ...(native.issueViewers ? { issueViewers: addOpt(native.issueViewers, account) } : {}) };
  else if (native.source === "confluence") next = { ...native, spaceViewers: add(native.spaceViewers, account), ...(native.pageViewers ? { pageViewers: addOpt(native.pageViewers, account) } : {}) };
  else next = { ...native, sharedUsers: add(native.sharedUsers, account) };
  return changed ? { ...permission, users, native: next } : undefined;
}
