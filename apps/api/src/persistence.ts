import type { AuditEntry } from "@brain/types";
import type { SignedMerkleBatch } from "@brain/audit";

/** Another API instance saved the workspace after this one loaded it. */
export class StaleState extends Error { constructor() { super("Workspace changed elsewhere"); } }

/**
 * Server key only. Several API instances may serve one organization (a serverless host runs many), so the workspace
 * snapshot carries a revision: a save names the revision it started from, and is refused if another instance saved since.
 */
export class Persistence {
  /** The revision of the snapshot this instance last loaded or saved. */
  revision = 0;
  private legacySave = false;
  constructor(readonly orgId: string, private readonly url: string, private readonly key: string,
    private readonly transport: typeof fetch = fetch) {
    if (!orgId || new URL(url).protocol !== "https:") throw new Error("Invalid persistence configuration");
  }
  static fromEnv(orgId = process.env.AUTH0_ORG_ID ?? ""): Persistence | undefined {
    if (!process.env.SUPABASE_URL) return undefined;
    return new Persistence(orgId, process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY ?? "");
  }
  async request(path: string, method = "GET", data?: unknown): Promise<any> {
    const response = await this.transport(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      method, headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Persistence failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  private async rows(table: string, order: string): Promise<any[]> {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.request(`${table}?org_id=eq.${encodeURIComponent(this.orgId)}&order=${order}&limit=500&offset=${offset}`);
      if (!Array.isArray(page)) throw new Error("Invalid stored rows");
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  }
  async loadAudit() {
    const entries = (await this.rows("audit_entries", "sequence.asc")).map(row => { if (!row.payload) throw new Error("Legacy audit requires verified migration"); return row.payload as AuditEntry; });
    const batches = (await this.rows("merkle_batches", "first_sequence.asc")).map(row => row.payload as SignedMerkleBatch);
    return { entries, batches };
  }
  async appendAudit(kind: "entry" | "batch", value: AuditEntry | SignedMerkleBatch) {
    await this.request("rpc/append_audit_record", "POST", { organization: this.orgId, kind, record: value });
  }
  async loadState(): Promise<any | undefined> {
    const rows = await this.request(`brain_state?org_id=eq.${encodeURIComponent(this.orgId)}&select=snapshot,revision`);
    this.revision = typeof rows[0]?.revision === "number" ? rows[0].revision : 0;
    return rows[0]?.snapshot;
  }
  /** The revision saved now, read cheaply, to tell whether another instance has saved since this one loaded. */
  async currentRevision(): Promise<number> {
    if (this.legacySave) return this.revision;
    const rows = await this.request(`brain_state?org_id=eq.${encodeURIComponent(this.orgId)}&select=revision`);
    return typeof rows[0]?.revision === "number" ? rows[0].revision : 0;
  }
  async saveState(snapshot: unknown) {
    if (!this.legacySave) {
      try {
        const saved = await this.request("rpc/save_brain_state_at", "POST", { organization: this.orgId, snapshot, expected: this.revision });
        if (typeof saved !== "number") throw new StaleState();
        this.revision = saved;
        return;
      } catch (error) {
        // A database without migration 014 has no revisions: save as before, one writer assumed.
        if (!(error instanceof Error) || !/\(404\)$/.test(error.message)) throw error;
        console.warn("save_brain_state_at is missing; apply migration 014 so API instances can't overwrite each other");
        this.legacySave = true;
      }
    }
    await this.request("rpc/save_brain_state", "POST", { organization: this.orgId, snapshot });
  }
}
