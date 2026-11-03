import { describe, expect, it, vi } from "vitest";
import type { User } from "@brain/types";

// The recovery path below does not use the native index or policy engine.
vi.mock("@brain/rust-core", () => ({ core: vi.fn(), NativeIndex: class {}, NativePolicy: class {} }));

import { Brain, type LiveJira } from "./brain.js";
import { MemoryTaskCommandStore } from "./task-commands.js";
import { taskCommandRoutes, type TaskCatalogAccess } from "./tasks.js";

describe("uncertain transition recovery", () => {
  async function runTransition(initialStatus: string, liveStatus: string | null = initialStatus) {
    const actor = { id: "maya", orgId: "org", role: "member" } as User;
    const document = { docId: "jira:DB-9", version: 1, metadata: { status: initialStatus } };
    const settle = vi.fn(async () => true);
    const send = vi.fn(async () => { throw new Error("connection lost before Jira received the request"); });
    const jira = {
      legalTransitions: async () => [{ id: "31", name: "Resolve", target: { name: "Done", category: "done" },
        fields: [{ id: "resolutionId", name: "Resolution", type: "option", required: true, supported: true }] }],
      currentTransitionStatus: async () => liveStatus ?? undefined,
      transitionIssue: send,
      settleUncertainEdit: settle
    } as unknown as LiveJira;
    // Exercise the real command store and transition path without starting the native index or an HTTP server.
    const brain = Object.assign(Object.create(Brain.prototype) as Brain, {
      orgId: "org", liveMode: true, liveJira: jira, commandStore: new MemoryTaskCommandStore(),
      taskDetail: async () => ({ document }), index: { documents: new Map() }, audit: { append: vi.fn() }
    });
    const result = await brain.taskTransition(actor, document.docId,
      { ifMatch: "task-r1", idempotencyKey: "key", intentId: "intent" },
      { transitionId: "31", fields: { resolutionId: "1" } });
    expect(result.status).toBe("uncertain");
    if (result.status !== "uncertain") throw new Error("Expected an uncertain transition");
    return { brain, actor, operationId: result.operation.id, send, settle };
  }

  it("does not claim a lost self-transition ran merely because its values already match", async () => {
    const { brain, actor, operationId, send, settle } = await runTransition("Done");
    expect((await brain.settleUncertain(actor, operationId)).status).toBe("uncertain");
    expect(send).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(await brain.commandStore.barrierFor("jira:DB-9")).toBeDefined();
  });

  it("still settles a lost transition to a different status when Jira confirms the desired state", async () => {
    const { brain, actor, operationId, send, settle } = await runTransition("In Progress");
    expect((await brain.settleUncertain(actor, operationId)).status).toBe("applied");
    expect(send).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(await brain.commandStore.barrierFor("jira:DB-9")).toBeUndefined();
  });

  it("uses Jira's current status when the indexed status is stale", async () => {
    const { brain, actor, operationId, settle } = await runTransition("In Progress", "Done");
    expect((await brain.settleUncertain(actor, operationId)).status).toBe("uncertain");
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps the outcome uncertain if the pre-write Jira status could not be read", async () => {
    const { brain, actor, operationId, settle } = await runTransition("In Progress", null);
    expect((await brain.settleUncertain(actor, operationId)).status).toBe("uncertain");
    expect(settle).not.toHaveBeenCalled();
  });

  it("returns the same actionable refusal when a fieldless self-transition is retried", async () => {
    const actor = { id: "maya", orgId: "org", role: "member" } as User;
    const document = { docId: "jira:DB-9", version: 1, metadata: { status: "Done" } };
    const send = vi.fn();
    const brain = Object.assign(Object.create(Brain.prototype) as Brain, {
      orgId: "org", liveMode: true, commandStore: new MemoryTaskCommandStore(), taskDetail: async () => ({ document }),
      index: { documents: new Map() }, audit: { append: vi.fn() },
      liveJira: { legalTransitions: async () => [{ id: "31", name: "Stay done", target: { name: "Done", category: "done" }, fields: [] }],
        transitionIssue: send }
    });
    const request = { method: "POST" as const, url: new URL("https://example.test/v1/tasks/jira/DB-9/transitions"), user: actor,
      body: { clientIntentId: "intent", transitionId: "31", fields: {} },
      headers: { "if-match": "task-r1", "idempotency-key": "key" }, list: { liveMode: true } as TaskCatalogAccess, commands: brain };
    const first = await taskCommandRoutes(request);
    const replay = await taskCommandRoutes(request);
    expect(first?.status).toBe(409);
    expect(replay?.status).toBe(409);
    expect(first?.body).toMatchObject({ error: { code: "TRANSITION_NO_EFFECT", message: expect.stringContaining("Jira") } });
    expect(replay?.body).toMatchObject({ error: { code: "TRANSITION_NO_EFFECT", message: expect.stringContaining("Jira") } });
    expect(send).not.toHaveBeenCalled();
  });
});
