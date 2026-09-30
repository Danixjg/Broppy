import type { AuditEntry } from "@brain/types";
import type { SignedMerkleBatch } from "@brain/audit";

/** Server key only. One API writer per organization; conflicts fail closed. */
export class Persistence {
  constructor(readonly orgId: string, private readonly url: string, private readonly key: string,
    private readonly transport: typeof fetch = fetch) {
    if (!orgId || new URL(url).protocol !== "https:") throw new Error("Invalid persistence configuration");
  }
  static fromEnv(): Persistence | undefined {
    if (!process.env.SUPABASE_URL) return undefined;
    return new Persistence(process.env.AUTH0_ORG_ID ?? "", process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY ?? "");
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
    const rows = await this.request(`brain_state?org_id=eq.${encodeURIComponent(this.orgId)}&select=snapshot`);
    return rows[0]?.snapshot;
  }
  async saveState(snapshot: unknown) {
    await this.request("rpc/save_brain_state", "POST", { organization: this.orgId, snapshot });
  }
}
