import { SourceOAuth } from "./source-oauth.js";
import { Persistence } from "./persistence.js";
import { searchAudit } from "./audit-search.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Brain } from "./brain.js";
import { SyncOrchestrator } from "./orchestrator.js";
import { createAuth0TokenValidatorFromEnv, type Auth0TokenValidator } from "./auth.js";
import { modelsFromEnv } from "./llm-budget.js";
import { UserDirectory } from "./user-directory.js";
import { LiveConnector, liveConnectorsFromEnv } from "@brain/connectors/live";
import { MockConnector, loadMockCorpus, type ImportScope } from "@brain/connectors";
import { AuditLog, FileAuditStore } from "@brain/audit";
import { RemoteFgaAdapter } from "@brain/fga-adapter";
import { SupabaseIndex } from "@brain/retrieval";
import type { AuditEntry, Source, SourcePermission, Tier, User } from "@brain/types";

export interface ApiServer {
  brain: Brain;
  orchestrator: SyncOrchestrator;
  server: Server;
}

interface ApiServerOptions {
  brain?: Brain;
  startOrchestrator?: boolean;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "access-control-allow-headers": "content-type,x-demo-user,authorization",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": process.env.WEB_ORIGIN ?? "http://127.0.0.1:3001",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid body");
  }
  return parsed as Record<string, unknown>;
}

// Settings that connect real identities or data. A public demo must run without all of them.
const REAL_SETTINGS = ["AUTH0_ISSUER", "AUTH0_AUDIENCE", "AUTH0_ORG_ID", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "LIVE_SOURCES_JSON", "SOURCE_OAUTH_JSON", "FGA_API_URL", "FGA_STORE_ID", "FGA_MODEL_ID", "FGA_CLIENT_ID",
  "FGA_CLIENT_SECRET"];

// PUBLIC_DEMO lets anyone pick a demo persona, so it only ever serves the fictional mock corpus.
function publicDemo(): boolean {
  if (process.env.PUBLIC_DEMO !== "true") return false;
  const real = REAL_SETTINGS.filter(name => process.env[name]);
  if (real.length) throw new Error(`PUBLIC_DEMO serves mock data only; remove ${real.join(", ")}`);
  return true;
}

async function identity(request: IncomingMessage, brain: Brain, auth0?: Auth0TokenValidator,
  allowDemo = true): Promise<User | undefined> {
  const authorization = request.headers.authorization;
  if (authorization) return auth0?.validate(authorization);
  if (auth0 || !allowDemo) return undefined;
  const demoHeaders = process.env.PUBLIC_DEMO === "true" ||
    (process.env.ALLOW_DEMO_AUTH === "true" && process.env.NODE_ENV !== "production");
  if (!demoHeaders) return undefined;
  const id = request.headers["x-demo-user"];
  return typeof id === "string" ? brain.user(id) : undefined;
}

/** The asker's own view of a query's trace: only documents they were allowed, and no trace ID. */
export function actorTrace(entries: AuditEntry[]): Array<Pick<AuditEntry, "sequence" | "timestamp" | "type" | "data">> {
  const answer = [...entries].reverse().find(entry => entry.type === "answer_returned");
  if (answer?.data.empty === true) {
    return [{ sequence: 1, timestamp: answer.timestamp, type: "answer_returned", data: { empty: true } }];
  }
  const allowedRefs = new Set(entries.filter(entry =>
    entry.type === "live_access_decision" && entry.data.allowed === true)
    .map(entry => entry.data.docRef));
  const visible = entries.filter(entry => {
    // A linked item shows only once it passed the live check, and only items the asker may open are followed.
    if (entry.type === "candidate_ranked" || entry.type === "candidate_linked" || entry.type === "access_decision") {
      return allowedRefs.has(entry.data.docRef) &&
        (entry.type !== "access_decision" || entry.data.allowed === true);
    }
    if (entry.type === "live_access_decision") return entry.data.allowed === true;
    return entry.type === "query_planned" || entry.type === "context_sent" || entry.type === "answer_returned";
  });
  return visible.map((entry, index) => {
    const data = { ...entry.data };
    delete data.traceId;
    return { sequence: index + 1, timestamp: entry.timestamp, type: entry.type, data };
  });
}

async function configuredAudit(persistence?: Persistence): Promise<AuditLog> {
  if (persistence) {
    const keyPath = process.env.AUDIT_SIGNING_KEY_FILE;
    if (!keyPath) throw new Error("AUDIT_SIGNING_KEY_FILE is required for durable audit");
    return new AuditLog({ orgId: persistence.orgId, signingKey: readFileSync(keyPath), initial: await persistence.loadAudit(),
      persist: (kind, value) => persistence.appendAudit(kind, value) });
  }
  const path = process.env.AUDIT_LOG_PATH;
  if (!path) return new AuditLog();
  const keyPath = process.env.AUDIT_SIGNING_KEY_FILE;
  if (!keyPath) throw new Error("AUDIT_SIGNING_KEY_FILE is required with AUDIT_LOG_PATH");
  return new AuditLog({ store: new FileAuditStore(path), signingKey: readFileSync(keyPath) });
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  const demoOnly = publicDemo();
  const hasAuth0 = Boolean(process.env.AUTH0_ISSUER || process.env.AUTH0_AUDIENCE || process.env.AUTH0_ORG_ID);
  const directory = UserDirectory.fromEnv();
  if (hasAuth0 && !directory) throw new Error("Auth0 requires the Supabase user directory");
  if (!hasAuth0 && !demoOnly && (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_AUTH !== "true")) {
    throw new Error("Auth0 configuration required when demo authentication is disabled");
  }
  const useRemoteFga = Boolean(process.env.FGA_API_URL || process.env.FGA_STORE_ID ||
    process.env.FGA_MODEL_ID || process.env.FGA_CLIENT_ID || process.env.FGA_CLIENT_SECRET);
  const models = modelsFromEnv(process.env);
  const embedding = models.embedding;
  const supabase = embedding ? SupabaseIndex.fromEnv() : null;
  if (supabase && !embedding) throw new Error("Supabase hybrid search requires an embedding provider (EMBEDDING_PROVIDER)");
  const users = hasAuth0 ? await directory!.list() : undefined;
  const persistence = options.brain ? undefined : Persistence.fromEnv();
  const oauthConfigs = process.env.SOURCE_OAUTH_JSON ? JSON.parse(process.env.SOURCE_OAUTH_JSON) : undefined;
  if (oauthConfigs && process.env.LIVE_SOURCES_JSON) throw new Error("Choose OAuth or manually managed source credentials");
  if (oauthConfigs && !persistence) throw new Error("Source OAuth requires Supabase persistence");
  const oauth = oauthConfigs && persistence ? new SourceOAuth(oauthConfigs, process.env.API_ORIGIN ?? "http://127.0.0.1:3000", persistence) : undefined;
  const connectors = liveConnectorsFromEnv(users ?? loadMockCorpus().users) ?? (oauth ? Object.fromEntries(
    (["slack", "jira", "confluence", "drive"] as Source[]).map(source => [source, oauthConfigs[source] ? new LiveConnector(source, {
      ids: [], serviceAuthorization: "", userAuthorizations: {}, discover: true, baseUrl: oauthConfigs[source].baseUrl, cloudId: oauthConfigs[source].cloudId,
      authorization: userId => oauth.authorization(source, userId)
    }, users ?? []) : new MockConnector(source, [])])) as Record<Source, MockConnector> : undefined);
  if (connectors && !hasAuth0) {
    throw new Error("Live sources require Auth0 sign-in");
  }
  const brain = options.brain ?? new Brain(models.llm,
    { orgId: process.env.AUTH0_ORG_ID, persistence, audit: await configuredAudit(persistence), remoteFga: useRemoteFga ? RemoteFgaAdapter.fromEnv() : undefined, embedding, supabase: supabase ?? undefined, users, connectors });
  if (oauth) for (const connection of brain.connections.values()) connection.status = "Not connected";
  await brain.restore();
  const auth0 = hasAuth0 ? createAuth0TokenValidatorFromEnv(directory!) : undefined;
  const orchestrator = new SyncOrchestrator(brain, connectors ? 300_000 : 30_000);
  if (options.startOrchestrator === false) await brain.syncAll();
  if (options.startOrchestrator ?? true) orchestrator.start();

  const server = createServer(async (request, response) => {
    let actor: User | undefined;
    const reply = async (response: ServerResponse, status: number, data: unknown) => {
      // A refused request is part of the trail too. Only the actor, method and route are recorded, never the body.
      if (status === 403 && actor) {
        brain.audit.append("request_denied", actor.id, { method: request.method, path: new URL(request.url ?? "/", "http://localhost").pathname });
        await brain.audit.flush();
      }
      if (status >= 200 && status < 300) await brain.persist();
      send(response, status, data);
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "OPTIONS") return await reply(response, 204, null);
      if (request.method === "GET" && url.pathname === "/health") {
        return await reply(response, 200, {
          ok: true,
          sync: [...brain.states.values()],
          pending: [...brain.runs.values()].filter(run => run.status !== "complete"),
          auditEntries: brain.audit.entries.length,
          merkleBatches: brain.audit.batches.length
        });
      }

      const callback = /^\/v1\/admin\/connections\/(slack|jira|confluence|drive)\/callback$/.exec(url.pathname);
      if (callback && request.method === "GET" && oauth && directory) {
        const source = callback[1] as Source;
        const actor = await oauth.complete(source, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "", sub => directory.bySub(sub));
        brain.markConnected(actor, source);
        await brain.persist();
        response.writeHead(302, { location: new URL("/connectors.html", process.env.WEB_ORIGIN ?? "http://127.0.0.1:3001").href, "cache-control": "no-store" });
        response.end(); return;
      }

      const user = await identity(request, brain, auth0, !connectors);
      if (!user) return await reply(response, 401, { error: "Unauthorized" });
      actor = user;

      if (request.method === "GET" && url.pathname === "/v1/me") {
        return await reply(response, 200, { id: user.id, name: user.name, role: user.role, groups: user.groups });
      }

      if (request.method === "POST" && url.pathname === "/v1/query") {
        const input = await body(request);
        if (typeof input.question !== "string") throw new Error("Invalid question");
        let traceId: string | undefined;
        const answer = await brain.query(user, input.question, id => { traceId = id; },
          () => identity(request, brain, auth0, !connectors));
        return await reply(response, 200, { ...answer, traceId, importNotice: brain.importNotice() });
      }

      if (request.method === "GET" && url.pathname === "/v1/trace") {
        const traceId = url.searchParams.get("traceId") ?? brain.lastTraceIds.get(user.id);
        if (!traceId) return await reply(response, 404, { error: "Not found" });
        const entries = brain.audit.entries.filter(entry => entry.data.traceId === traceId &&
          (entry.actor === user.id || user.role === "compliance"));
        return entries.length ? send(response, 200, {
          traceId,
          entries: user.role === "compliance" ? entries : actorTrace(entries)
        }) : send(response, 404, { error: "Not found" });
      }

      if (url.pathname.startsWith("/v1/admin/connections") || url.pathname === "/v1/admin/import-jobs" || url.pathname === "/v1/admin/onboard") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const sources: Source[] = ["slack", "jira", "confluence", "drive"];
        if (url.pathname === "/v1/admin/connections" && request.method === "GET") {
          return await reply(response, 200, { connections: [...brain.connections.values()].map(connection => ({ ...connection,
            lastSync: brain.states.get(connection.source)?.lastSuccessfulSyncAt,
            count: [...brain.index.documents.values()].filter(doc => doc.source === connection.source && !doc.deletedAt).length })),
            unmatched: brain.users.flatMap(person => sources.filter(source => !person.platformIdentities?.[source]).map(source => ({ user: person.id, source }))),
            liveMode: brain.liveMode });
        }
        if (url.pathname === "/v1/admin/import-jobs" && request.method === "GET") return await reply(response, 200, { jobs: [...brain.jobs.values()] });
        if (url.pathname === "/v1/admin/onboard" && request.method === "POST") {
          if (brain.liveMode) throw new Error("Mock onboarding only");
          for (const source of sources) { await brain.connect(user, source); await brain.startImport(user, source); }
          return await reply(response, 202, { jobs: [...brain.jobs.values()] });
        }
        const match = /^\/v1\/admin\/connections\/(slack|jira|confluence|drive)(?:\/(authorize|callback|scope|import|containers))?$/.exec(url.pathname);
        if (!match) return await reply(response, 404, { error: "Not found" });
        const source = match[1] as Source;
        if (match[2] === "authorize" && request.method === "POST") {
          if (oauth) return await reply(response, 200, { url: oauth.begin(source, user) });
          await brain.connect(user, source); return await reply(response, 200, { connected: true });
        }
        if (match[2] === "containers" && request.method === "GET") return await reply(response, 200, { containers: await brain.listContainers(user, source) });
        if (match[2] === "scope" && request.method === "PUT") {
          const input = await body(request);
          if (input.mode !== undefined && !["all", "selected", "none"].includes(String(input.mode))) throw new Error("Invalid scope");
          if (input.futureOnly !== undefined && typeof input.futureOnly !== "boolean") throw new Error("Invalid scope");
          if (input.containers !== undefined && (!Array.isArray(input.containers) || !input.containers.every(id => typeof id === "string" && id.length > 0))) throw new Error("Invalid scope");
          if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.every(id => typeof id === "string" && id.length > 0))) throw new Error("Invalid scope");
          if (input.since !== undefined && (typeof input.since !== "string" || !Number.isFinite(Date.parse(input.since)))) throw new Error("Invalid scope");
          const mode = input.mode as ImportScope["mode"];
          await brain.setScope(user, source, { mode, containers: input.containers as string[] | undefined, ids: input.ids as string[] | undefined,
            since: input.since as string | undefined, futureOnly: input.futureOnly as boolean | undefined });
          // Saving what to include starts importing it; choosing none only removes.
          if (mode !== "none") await brain.startImport(user, source);
          return await reply(response, 200, { ok: true });
        }
        if (match[2] === "import" && request.method === "POST") { await brain.startImport(user, source); return await reply(response, 202, { ok: true }); }
        if (!match[2] && request.method === "DELETE") { await brain.disconnect(user, source); await oauth?.remove(source); return await reply(response, 200, { ok: true }); }
        return await reply(response, 404, { error: "Not found" });
      }

      if (request.method === "GET" && url.pathname === "/v1/workspace") {
        return await reply(response, 200, await brain.workspace(user));
      }

      if (request.method === "POST" && url.pathname === "/v1/catch-up") {
        const input = await body(request);
        if (input.project !== undefined && (typeof input.project !== "string" || input.project.length > 64)) {
          throw new Error("Invalid project");
        }
        let traceId: string | undefined;
        const result = await brain.catchUp(user, input.project as string | undefined, id => { traceId = id; },
          () => identity(request, brain, auth0, !connectors));
        return await reply(response, 200, result.kind === "audit" ? result : { ...result, traceId });
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const input = await body(request);
        if (typeof input.threadDocId !== "string" || typeof input.sentence !== "string" || input.sentence.length > 1000) {
          throw new Error("Invalid task");
        }
        return await reply(response, 201, await brain.createTask(user, input.threadDocId, input.sentence));
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks/done") {
        const input = await body(request);
        if (typeof input.docId !== "string") throw new Error("Invalid task");
        await brain.markDone(user, input.docId);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/tier") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !["open", "internal", "restricted"].includes(String(input.tier))) {
          throw new Error("Invalid tier change");
        }
        await brain.narrowTier(user, input.docId, input.tier as Tier);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/permissions") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !input.permissions || typeof input.permissions !== "object") {
          throw new Error("Invalid permissions");
        }
        await brain.setNativePermissions(user, input.docId, input.permissions as SourcePermission);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/permissions") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const docId = url.searchParams.get("docId") ?? "";
        const visible = (await brain.visibleDocuments(user)).some(doc => doc.docId === docId);
        if (!visible) return await reply(response, 404, { error: "Not found" });
        const source = docId.split(":")[0] as keyof typeof brain.connectors;
        const permissions = await brain.connectors[source]?.fetchPermissions(docId);
        return permissions ? send(response, 200, { docId, source, permissions }) :
          send(response, 404, { error: "Not found" });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/group") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.group !== "string") {
          throw new Error("Invalid group change");
        }
        brain.removeUserFromGroup(user, input.userId, input.group);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/channel-member") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.docId !== "string") {
          throw new Error("Invalid channel change");
        }
        await brain.removeSlackMember(user, input.docId, input.userId);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/content") {
        const input = await body(request);
        if (typeof input.docId !== "string" || typeof input.content !== "string") {
          throw new Error("Invalid content");
        }
        await brain.editContent(user, input.docId, input.content);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/sync") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        await brain.syncAll();
        return await reply(response, 200, { states: [...brain.states.values()] });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/preview") {
        const target = url.searchParams.get("user") ?? "alex";
        return await reply(response, 200, await brain.previewAccess(user, target));
      }

      if (url.pathname === "/v1/audit" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        return await reply(response, 200, {
          entries: brain.audit.entries,
          batches: brain.audit.batches,
          chainValid: brain.audit.verifyChain()
        });
      }

      if (url.pathname === "/v1/audit/search" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        if (query.length > 200) throw new Error("Invalid query");
        const documents = [...brain.index.documents.values()].map(doc => ({ docId: doc.docId, title: doc.title }));
        const result = searchAudit(brain.audit.entries, url.searchParams, brain.users, new Date(), documents);
        brain.audit.append("audit_searched", user.id, { query, filters: result.filters, results: result.entries.length });
        await brain.audit.flush();
        return await reply(response, 200, result);
      }

      if (url.pathname === "/v1/audit/seal" && request.method === "POST") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        return await reply(response, 200, { batch: brain.audit.seal() ?? null });
      }

      if (url.pathname === "/v1/audit/proof" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const sequence = Number(url.searchParams.get("sequence"));
        if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid sequence");
        const proof = brain.audit.proof(sequence);
        return proof
          ? send(response, 200, { proof })
          : send(response, 404, { error: "Proof unavailable; seal the log first" });
      }

      if (url.pathname === "/v1/audit/verify" && request.method === "POST") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const input = await body(request);
        const sequence = input.sequence;
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
          throw new Error("Invalid sequence");
        }
        const proof = brain.audit.proof(sequence);
        const batch = brain.audit.batches.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
        return await reply(response, 200, {
          verified: Boolean(proof && batch && brain.audit.verifyChain() && brain.audit.verifyBatches() &&
            AuditLog.verifyProof(proof, batch)),
          proof: proof ?? null,
          batch: batch ?? null
        });
      }

      return await reply(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Request failed";
      if (message === "Unauthorized") return await reply(response, 401, { error: "Unauthorized" });
      if (message === "Forbidden") return await reply(response, 403, { error: "Forbidden" });
      if (message === "Live sources are read-only") {
        return await reply(response, 409, { error: "This app only reads live sources. Make the change in Jira." });
      }
      if (message === "Already tracked") return await reply(response, 409, { error: "A Jira task already quotes this agreement." });
      if (message === "Unknown document" || message === "Unknown source item" || message === "Unknown user" ||
        message === "Unknown group membership" || message === "Unknown channel membership") {
        return await reply(response, 404, { error: "Not found" });
      }
      return await reply(response, 400, { error: "Invalid request" });
    }
  });

  return { brain, orchestrator, server };
}

// Serverless hosts such as Vercel import this module and call its default export once per request. The server is
// built on first use and reused while the instance stays warm; there is no background sync loop between requests.
let serverless: Promise<ApiServer> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  serverless ??= createApiServer({ startOrchestrator: false }).catch(error => {
    serverless = undefined;
    throw error;
  });
  const { server } = await serverless;
  server.emit("request", request, response);
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isMainModule()) {
  const { brain, orchestrator, server } = await createApiServer();
  server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1");

  const stop = (): void => {
    orchestrator.stop();
    server.close();
    // Seal what is left and write it out before the process exits, so the last entries are not left unsealed.
    void (async () => {
      try { brain.audit.seal(); await brain.audit.flush(); await brain.persist(); } catch { /* exiting anyway */ }
    })();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
