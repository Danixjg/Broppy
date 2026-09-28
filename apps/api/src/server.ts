import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Brain } from "./brain.js";
import { SyncOrchestrator } from "./orchestrator.js";
import { createAuth0TokenValidatorFromEnv, type Auth0TokenValidator } from "./auth.js";
import { createHunyuanLlmFromEnv } from "./hunyuan.js";
import { createHunyuanEmbeddingClientFromEnv } from "./embedding.js";
import { AuditLog, FileAuditStore } from "@brain/audit";
import { RemoteFgaAdapter } from "@brain/fga-adapter";
import { SupabaseIndex } from "@brain/retrieval";
import type { AuditEntry, SourcePermission, Tier, User } from "@brain/types";

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
    "access-control-allow-methods": "GET,POST,OPTIONS",
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

async function identity(request: IncomingMessage, brain: Brain, auth0?: Auth0TokenValidator): Promise<User | undefined> {
  const authorization = request.headers.authorization;
  if (authorization) return auth0?.validate(authorization);
  if (process.env.ALLOW_DEMO_AUTH !== "true" || process.env.NODE_ENV === "production") return undefined;
  const id = request.headers["x-demo-user"];
  return typeof id === "string" ? brain.user(id) : undefined;
}

function auditMatches(query: string, entry: { type: string; actor: string; data: Record<string, unknown> }): boolean {
  const terms = (query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])
    .filter(term => !["show", "me", "all", "the", "events", "event", "for", "where", "were", "with", "by", "about"].includes(term));
  const searchable = `${entry.type} ${entry.actor} ${JSON.stringify(entry.data)}`.toLowerCase();
  return terms.every(term => {
    if (["denied", "deny", "rejected"].includes(term)) return entry.data.allowed === false;
    if (["allowed", "allow", "approved"].includes(term)) return entry.data.allowed === true;
    if (["permission", "permissions", "access"].includes(term)) {
      return /permission|access/.test(searchable);
    }
    if (["changed", "changes", "change"].includes(term)) return /changed|narrowed|refresh/.test(searchable);
    return searchable.includes(term);
  });
}

function actorTrace(entries: AuditEntry[]): Array<Pick<AuditEntry, "sequence" | "timestamp" | "type" | "data">> {
  const answer = [...entries].reverse().find(entry => entry.type === "answer_returned");
  if (answer?.data.empty === true) {
    return [{ sequence: 1, timestamp: answer.timestamp, type: "answer_returned", data: { empty: true } }];
  }
  const allowedRefs = new Set(entries.filter(entry =>
    entry.type === "live_access_decision" && entry.data.allowed === true)
    .map(entry => entry.data.docRef));
  const visible = entries.filter(entry => {
    if (entry.type === "candidate_ranked" || entry.type === "access_decision") {
      return allowedRefs.has(entry.data.docRef) &&
        (entry.type !== "access_decision" || entry.data.allowed === true);
    }
    if (entry.type === "live_access_decision") return entry.data.allowed === true;
    return entry.type === "context_sent" || entry.type === "answer_returned";
  });
  return visible.map((entry, index) => {
    const data = { ...entry.data };
    delete data.traceId;
    return { sequence: index + 1, timestamp: entry.timestamp, type: entry.type, data };
  });
}

function configuredAudit(): AuditLog {
  const path = process.env.AUDIT_LOG_PATH;
  if (!path) return new AuditLog();
  const keyPath = process.env.AUDIT_SIGNING_KEY_FILE;
  if (!keyPath) throw new Error("AUDIT_SIGNING_KEY_FILE is required with AUDIT_LOG_PATH");
  return new AuditLog({ store: new FileAuditStore(path), signingKey: readFileSync(keyPath) });
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  const hasAuth0 = Boolean(process.env.AUTH0_ISSUER && process.env.AUTH0_AUDIENCE);
  if (!hasAuth0 && (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_AUTH !== "true")) {
    throw new Error("Auth0 configuration required when demo authentication is disabled");
  }
  const useHunyuan = Boolean(process.env.HUNYUAN_API_KEY || process.env.HUNYUAN_MODEL);
  const useRemoteFga = Boolean(process.env.FGA_API_URL || process.env.FGA_STORE_ID ||
    process.env.FGA_MODEL_ID || process.env.FGA_API_TOKEN);
  const embedding = createHunyuanEmbeddingClientFromEnv();
  const supabase = SupabaseIndex.fromEnv();
  if (supabase && !embedding) throw new Error("Supabase hybrid search requires HUNYUAN_EMBEDDING_API_KEY");
  const brain = options.brain ?? new Brain(useHunyuan ? createHunyuanLlmFromEnv() : undefined,
    { audit: configuredAudit(), remoteFga: useRemoteFga ? RemoteFgaAdapter.fromEnv() : undefined, embedding, supabase: supabase ?? undefined });
  const auth0 = hasAuth0 ? createAuth0TokenValidatorFromEnv(brain.users) : undefined;
  const orchestrator = new SyncOrchestrator(brain);
  await brain.syncAll();
  if (options.startOrchestrator ?? true) orchestrator.start();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "OPTIONS") return send(response, 204, null);
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, {
          ok: true,
          sync: [...brain.states.values()],
          pending: [...brain.runs.values()].filter(run => run.status !== "complete"),
          auditEntries: brain.audit.entries.length,
          merkleBatches: brain.audit.batches.length
        });
      }

      const user = await identity(request, brain, auth0);
      if (!user) return send(response, 401, { error: "Unauthorized" });

      if (request.method === "GET" && url.pathname === "/v1/me") {
        return send(response, 200, { id: user.id, name: user.name, role: user.role, groups: user.groups });
      }

      if (request.method === "POST" && url.pathname === "/v1/query") {
        const input = await body(request);
        if (typeof input.question !== "string") throw new Error("Invalid question");
        let traceId: string | undefined;
        const answer = await brain.query(user, input.question, id => { traceId = id; });
        return send(response, 200, { ...answer, traceId });
      }

      if (request.method === "GET" && url.pathname === "/v1/trace") {
        const traceId = url.searchParams.get("traceId") ?? brain.lastTraceIds.get(user.id);
        if (!traceId) return send(response, 404, { error: "Not found" });
        const entries = brain.audit.entries.filter(entry => entry.data.traceId === traceId &&
          (entry.actor === user.id || user.role === "compliance"));
        return entries.length ? send(response, 200, {
          traceId,
          entries: user.role === "compliance" ? entries : actorTrace(entries)
        }) : send(response, 404, { error: "Not found" });
      }

      if (request.method === "GET" && url.pathname === "/v1/workspace") {
        return send(response, 200, { documents: await brain.visibleDocuments(user) });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/tier") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !["open", "internal", "restricted"].includes(String(input.tier))) {
          throw new Error("Invalid tier change");
        }
        await brain.narrowTier(user, input.docId, input.tier as Tier);
        return send(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/permissions") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !input.permissions || typeof input.permissions !== "object") {
          throw new Error("Invalid permissions");
        }
        await brain.setNativePermissions(user, input.docId, input.permissions as SourcePermission);
        return send(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/permissions") {
        if (user.role !== "admin") return send(response, 403, { error: "Forbidden" });
        const docId = url.searchParams.get("docId") ?? "";
        const visible = (await brain.visibleDocuments(user)).some(doc => doc.docId === docId);
        if (!visible) return send(response, 404, { error: "Not found" });
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
        return send(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/channel-member") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.docId !== "string") {
          throw new Error("Invalid channel change");
        }
        await brain.removeSlackMember(user, input.docId, input.userId);
        return send(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/content") {
        const input = await body(request);
        if (typeof input.docId !== "string" || typeof input.content !== "string") {
          throw new Error("Invalid content");
        }
        await brain.editContent(user, input.docId, input.content);
        return send(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/sync") {
        if (user.role !== "admin") return send(response, 403, { error: "Forbidden" });
        await brain.syncAll();
        return send(response, 200, { states: [...brain.states.values()] });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/preview") {
        const target = url.searchParams.get("user") ?? "alex";
        return send(response, 200, await brain.previewAccess(user, target));
      }

      if (url.pathname === "/v1/audit" && request.method === "GET") {
        if (user.role !== "compliance") return send(response, 403, { error: "Forbidden" });
        return send(response, 200, {
          entries: brain.audit.entries,
          batches: brain.audit.batches,
          chainValid: brain.audit.verifyChain()
        });
      }

      if (url.pathname === "/v1/audit/search" && request.method === "GET") {
        if (user.role !== "compliance") return send(response, 403, { error: "Forbidden" });
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        if (query.length > 200) throw new Error("Invalid query");
        const entries = brain.audit.entries.filter(entry => auditMatches(query, entry));
        return send(response, 200, { entries });
      }

      if (url.pathname === "/v1/audit/seal" && request.method === "POST") {
        if (user.role !== "compliance") return send(response, 403, { error: "Forbidden" });
        return send(response, 200, { batch: brain.audit.seal() ?? null });
      }

      if (url.pathname === "/v1/audit/proof" && request.method === "GET") {
        if (user.role !== "compliance") return send(response, 403, { error: "Forbidden" });
        const sequence = Number(url.searchParams.get("sequence"));
        if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid sequence");
        const proof = brain.audit.proof(sequence);
        return proof
          ? send(response, 200, { proof })
          : send(response, 404, { error: "Proof unavailable; seal the log first" });
      }

      if (url.pathname === "/v1/audit/verify" && request.method === "POST") {
        if (user.role !== "compliance") return send(response, 403, { error: "Forbidden" });
        const input = await body(request);
        const sequence = input.sequence;
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
          throw new Error("Invalid sequence");
        }
        const proof = brain.audit.proof(sequence);
        const batch = brain.audit.batches.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
        return send(response, 200, {
          verified: Boolean(proof && batch && brain.audit.verifyChain() && brain.audit.verifyBatches() &&
            AuditLog.verifyProof(proof, batch)),
          proof: proof ?? null,
          batch: batch ?? null
        });
      }

      return send(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Request failed";
      if (message === "Unauthorized") return send(response, 401, { error: "Unauthorized" });
      if (message === "Forbidden") return send(response, 403, { error: "Forbidden" });
      if (message === "Unknown document" || message === "Unknown source item" || message === "Unknown user" ||
        message === "Unknown group membership" || message === "Unknown channel membership") {
        return send(response, 404, { error: "Not found" });
      }
      return send(response, 400, { error: "Invalid request" });
    }
  });

  return { brain, orchestrator, server };
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isMainModule()) {
  const { orchestrator, server } = await createApiServer();
  server.listen(3000, "127.0.0.1");

  const stop = (): void => {
    orchestrator.stop();
    server.close();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
