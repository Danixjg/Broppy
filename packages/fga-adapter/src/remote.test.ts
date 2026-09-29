import { describe, expect, it, vi } from "vitest";
import type { SourcePermission, User } from "@brain/types";
import { RemoteFgaAdapter } from "./index.js";

const user: User = {
  id: "u1", name: "Ravi", email: "ravi@example.test", auth0Sub: "auth0|ravi",
  groups: ["fraud-ops"], role: "member", platformIdentities: {
    slack: "ravi@slack.test", jira: "ravi@jira.test", confluence: "ravi@confluence.test", drive: "ravi@drive.test"
  }
};

function permission(users: string[] = [user.email], groups: string[] = []): SourcePermission {
  return {
    users, groups, public: false,
    native: { source: "slack", channelId: "private", visibility: "private", members: ["ravi@slack.test"] }
  };
}

function service() {
  const tuples = new Map<string, { user: string; relation: string; object: string }>();
  const requests: Array<{ path: string; body: any; headers: Headers }> = [];
  let fail: string | undefined;
  let batchResult: ((body: any) => unknown) | undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body, headers: new Headers(init?.headers) });
    if (fail === path.split("/").at(-1)) return new Response("error", { status: 503 });
    if (path.endsWith("/read")) {
      return Response.json({ tuples: [...tuples.values()]
        .filter(tuple => tuple.object === body.tuple_key.object).map(key => ({ key })), continuation_token: "" });
    }
    if (path.endsWith("/write")) {
      for (const tuple of body.deletes?.tuple_keys ?? []) tuples.delete(JSON.stringify(tuple));
      for (const tuple of body.writes?.tuple_keys ?? []) tuples.set(JSON.stringify(tuple), tuple);
      return Response.json({});
    }
    if (path.endsWith("/batch-check")) {
      if (batchResult) return Response.json(batchResult(body));
      const entries = body.checks.map((check: any) => {
        const direct = JSON.stringify({
          user: check.tuple_key.user, relation: "direct_reader", object: check.tuple_key.object
        });
        const group = check.contextual_tuples.tuple_keys.some((membership: any) =>
          tuples.has(JSON.stringify({ user: `${membership.object}#member`, relation: "group_reader", object: check.tuple_key.object })));
        const publicGrant = JSON.stringify({ user: "user:*", relation: "public_reader", object: check.tuple_key.object });
        return [check.correlation_id, { allowed: tuples.has(direct) || group || tuples.has(publicGrant) }];
      });
      return Response.json({ result: Object.fromEntries(entries.reverse()) });
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const adapter = () => new RemoteFgaAdapter({
    url: "https://fga.example.test", storeId: "store", modelId: "model", token: "test-token",
    fetch: transport as unknown as typeof fetch
  });
  return { adapter, requests, tuples, setFail: (path?: string) => { fail = path; },
    setBatchResult: (result?: (body: any) => unknown) => { batchResult = result; } };
}

describe("RemoteFgaAdapter", () => {
  it("reconciles direct and group grants and checks with current Auth0 groups", async () => {
    const remote = service();
    const adapter = remote.adapter();
    await adapter.syncDocument({ docId: "slack:1", permissions: permission([user.email], ["fraud-ops"]), tier: "internal" });
    expect(remote.requests[0].path).toBe("/stores/store/read");
    expect(remote.requests[0].body.consistency).toBe("HIGHER_CONSISTENCY");
    expect(remote.requests[1].body).toEqual({ authorization_model_id: "model", writes: { tuple_keys: [
      { user: `user:${user.email}`, relation: "direct_reader", object: "document:slack:1" },
      { user: "group:fraud-ops#member", relation: "group_reader", object: "document:slack:1" }
    ] } });
    expect(remote.requests[1].headers.get("authorization")).toBe("Bearer test-token");
    expect(await adapter.batchCheck(user, ["slack:1"])).toEqual([
      { docId: "slack:1", allowed: true, reason: "fga" }
    ]);
    expect(remote.requests.at(-1)?.body.checks[0]).toEqual({
      tuple_key: { user: `user:${user.email}`, relation: "native_reader", object: "document:slack:1" },
      correlation_id: "1",
      contextual_tuples: { tuple_keys: [
        { user: `user:${user.email}`, relation: "member", object: "group:fraud-ops" }
      ] }
    });
    expect(remote.requests.at(-1)?.body.consistency).toBe("HIGHER_CONSISTENCY");
  });

  it("reads existing tuples after restart and removes stale grants and deleted documents", async () => {
    const remote = service();
    await remote.adapter().syncDocument({ docId: "d", permissions: permission(["old@example.test"], ["old"]), tier: "open" });
    const restarted = remote.adapter();
    await restarted.syncDocument({ docId: "d", permissions: permission([user.email], ["fraud-ops"]), tier: "open" });
    expect(remote.requests.at(-1)?.body).toEqual({
      authorization_model_id: "model",
      deletes: { tuple_keys: [
        { user: "user:old@example.test", relation: "direct_reader", object: "document:d" },
        { user: "group:old#member", relation: "group_reader", object: "document:d" }
      ] },
      writes: { tuple_keys: [
        { user: `user:${user.email}`, relation: "direct_reader", object: "document:d" },
        { user: "group:fraud-ops#member", relation: "group_reader", object: "document:d" }
      ] }
    });
    await restarted.removeDocument("d");
    expect(remote.tuples.size).toBe(0);
    expect(await restarted.batchCheck(user, ["d"])).toEqual([{ docId: "d", allowed: false, reason: "fga" }]);
  });

  it("uses current group membership for group-only access", async () => {
    const remote = service();
    const adapter = remote.adapter();
    await adapter.syncDocument({ docId: "group-doc", permissions: permission([], ["fraud-ops"]), tier: "open" });
    expect((await adapter.batchCheck(user, ["group-doc"]))[0].allowed).toBe(true);
    const removedFromGroup = { ...user, groups: [] };
    expect(await adapter.batchCheck(removedFromGroup, ["group-doc"]))
      .toEqual([{ docId: "group-doc", allowed: false, reason: "fga" }]);
  });

  it("writes and revokes wildcard grants for public documents", async () => {
    const remote = service();
    const adapter = remote.adapter();
    const publicPermission = { ...permission([], []), public: true,
      native: { source: "slack" as const, channelId: "public", visibility: "public" as const, members: [] } };
    await adapter.syncDocument({ docId: "public-doc", permissions: publicPermission, tier: "open" });
    expect([...remote.tuples.values()]).toContainEqual({
      user: "user:*", relation: "public_reader", object: "document:public-doc"
    });
    expect((await adapter.batchCheck(user, ["public-doc"]))[0].allowed).toBe(true);
    await adapter.syncDocument({ docId: "public-doc", permissions: {
      ...publicPermission, public: false
    }, tier: "open" });
    expect((await adapter.batchCheck(user, ["public-doc"]))[0].allowed).toBe(false);
    expect(remote.tuples.size).toBe(0);
  });

  it("chunks unique document checks at 50 and maps out of order results by correlation ID", async () => {
    const remote = service();
    const adapter = remote.adapter();
    for (let i = 0; i < 51; i++) {
      await adapter.syncDocument({ docId: `d${i}`, permissions: permission(), tier: "open" });
    }
    const result = await adapter.batchCheck(user, [...Array.from({ length: 51 }, (_, i) => `d${i}`), "d0"]);
    expect(result).toHaveLength(51);
    expect(result.every(decision => decision.allowed)).toBe(true);
    const batches = remote.requests.filter(request => request.path.endsWith("/batch-check"));
    expect(batches.map(batch => batch.body.checks.length)).toEqual([50, 1]);
    expect(new Set(batches.flatMap(batch => batch.body.checks.map((check: any) => check.correlation_id))).size).toBe(51);
  });

  it("denies when native source or local tier denies, even if remote allows", async () => {
    const remote = service();
    const adapter = remote.adapter();
    await adapter.syncDocument({ docId: "d", permissions: permission(), tier: "open" });
    adapter.narrowTier("d", "restricted");
    const ordinaryUser = { ...user, groups: ["engineering"] };
    expect(await adapter.batchCheck(ordinaryUser, ["d"])).toEqual([{ docId: "d", allowed: false, reason: "tier" }]);
    expect(() => adapter.narrowTier("d", "open")).toThrow("narrow");
    await adapter.syncDocument({ docId: "d", permissions: permission(), tier: "open" });
    expect(adapter.effectiveTier("d")).toBe("restricted");
    const securityUser = { ...user, groups: ["security"], platformIdentities: { ...user.platformIdentities!, slack: "outsider" } };
    expect(await adapter.batchCheck(securityUser, ["d"])).toEqual([{ docId: "d", allowed: false, reason: "fga" }]);
    expect(remote.requests.filter(request => request.path.endsWith("/batch-check"))).toHaveLength(0);
  });

  it("fails closed on remote failures and incomplete or erroneous responses", async () => {
    const remote = service();
    const adapter = remote.adapter();
    await adapter.syncDocument({ docId: "d", permissions: permission(), tier: "open" });
    remote.setFail("batch-check");
    expect((await adapter.batchCheck(user, ["d"]))[0].allowed).toBe(false);
    remote.setFail();
    remote.setBatchResult(() => ({ result: {} }));
    expect((await adapter.batchCheck(user, ["d"]))[0].allowed).toBe(false);
    remote.setBatchResult(() => ({ result: { "1": { allowed: true, error: { code: "failed" } } } }));
    expect((await adapter.batchCheck(user, ["d"]))[0].allowed).toBe(false);
    remote.setFail("write");
    await expect(adapter.syncDocument({ docId: "d", permissions: permission(["new@example.test"]), tier: "open" }))
      .rejects.toThrow("OpenFGA write failed");
    expect((await adapter.batchCheck(user, ["d"]))[0].allowed).toBe(false);
  });

  it("requires configured endpoint, store, and model", () => {
    expect(() => RemoteFgaAdapter.fromEnv({})).toThrow("FGA_API_URL");
    expect(() => RemoteFgaAdapter.fromEnv({ FGA_API_URL: "https://fga.example.test" })).toThrow("FGA_STORE_ID");
    expect(() => RemoteFgaAdapter.fromEnv({ FGA_API_URL: "https://fga.example.test", FGA_STORE_ID: "s" }))
      .toThrow("FGA_MODEL_ID");
  });
});
