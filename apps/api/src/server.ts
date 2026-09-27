import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Brain } from "./brain.js";
import { SyncOrchestrator } from "./orchestrator.js";
import type { SourcePermission, Tier, User } from "@brain/types";

export interface ApiServer {
  brain: Brain;
  orchestrator: SyncOrchestrator;
  server: Server;
}

interface ApiServerOptions {
  brain?: Brain;
  startOrchestrator?: boolean;
}

function assertDemoIdentityEnabled(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Mock identity headers are disabled in production");
  }
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "access-control-allow-headers": "content-type,x-demo-user",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "http://127.0.0.1:3001",
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

function identity(request: IncomingMessage, brain: Brain): User | undefined {
  const id = request.headers["x-demo-user"];
  return typeof id === "string" ? brain.user(id) : undefined;
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  assertDemoIdentityEnabled();

  const brain = options.brain ?? new Brain();
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

      const user = identity(request, brain);
      if (!user) return send(response, 401, { error: "Unauthorized" });

      if (request.method === "POST" && url.pathname === "/v1/query") {
        const input = await body(request);
        if (typeof input.question !== "string") throw new Error("Invalid question");
        return send(response, 200, await brain.query(user, input.question));
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

      return send(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Request failed";
      if (message === "Forbidden") return send(response, 403, { error: "Forbidden" });
      if (message === "Unknown document" || message === "Unknown source item" || message === "Unknown user") {
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
