import { describe, expect, it } from "vitest";
import { Brain } from "./brain.js";
import { Persistence, StaleState } from "./persistence.js";

/**
 * A serverless host runs several copies of the API at once, all saving one workspace. This pretend database keeps the
 * snapshot and its revision exactly as migration 014 does.
 */
function sharedDatabase() {
  const row: { snapshot?: unknown; revision: number } = { revision: 0 };
  let saves = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.pathname === "/rest/v1/brain_state") return json(row.snapshot === undefined ? [] : [{ snapshot: row.snapshot, revision: row.revision }]);
    if (url.pathname === "/rest/v1/rpc/save_brain_state_at") {
      const body = JSON.parse(String(init?.body));
      if (body.expected !== row.revision) return json(null);
      row.snapshot = structuredClone(body.snapshot); row.revision += 1; saves += 1;
      return json(row.revision);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/append_audit_record")) return json(null);
    return new Response("{}", { status: 404 });
  };
  const copy = () => new Brain(undefined, { persistence: new Persistence("demo-company-a", "https://db.test", "key", transport) });
  return { copy, row, saves: () => saves };
}

describe("several copies of the API on one workspace", () => {
  it("shows a change saved by another copy, such as a source connected there", async () => {
    const db = sharedDatabase();
    const first = db.copy(); await first.syncAll(); await first.persist();
    const second = db.copy(); await second.restore();
    // The approval comes back to the first copy; the setup page then asks the second.
    first.connections.get("jira")!.status = "Not connected";
    await first.persist();
    expect(await second.refreshIfStale()).toBe(true);
    expect(second.connections.get("jira")!.status).toBe("Not connected");
    expect(await second.refreshIfStale()).toBe(false);
  });

  it("never lets an older copy overwrite newer state: its save is refused and it takes the newer state", async () => {
    const db = sharedDatabase();
    const first = db.copy(); await first.syncAll(); await first.persist();
    const second = db.copy(); await second.restore();
    first.connections.get("drive")!.status = "Error";
    await first.persist();
    const saved = db.row.revision;
    // The second copy hasn't looked yet and tries to save its old view.
    await expect(second.persist()).rejects.toBeInstanceOf(StaleState);
    expect(db.row.revision).toBe(saved);
    expect((db.row.snapshot as any).connections.find((item: any) => item.source === "drive").status).toBe("Error");
    // It reloaded, so its next save builds on the newer state.
    expect(second.connections.get("drive")!.status).toBe("Error");
    await second.persist();
    expect(db.row.revision).toBe(saved + 1);
  });

  it("saves as before on a database without revisions yet", async () => {
    let legacy = 0;
    const transport: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/rest/v1/rpc/save_brain_state_at") return new Response("{}", { status: 404 });
      if (path === "/rest/v1/rpc/save_brain_state") { legacy += 1; return new Response(null, { status: 204 }); }
      return new Response("[]", { status: 200 });
    };
    const persistence = new Persistence("demo-company-a", "https://db.test", "key", transport);
    await persistence.saveState({}); await persistence.saveState({});
    expect(legacy).toBe(2);
    expect(await persistence.currentRevision()).toBe(0);
  });
});
