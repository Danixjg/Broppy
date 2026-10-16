import { normalizeEmail } from "./user-directory.js";

interface Config { url: string; secretKey: string; fetch?: typeof fetch }

/** Another company already has this name (the database's unique name rule refused it). */
export class NameTaken extends Error { constructor() { super("Company name taken"); } }

/** A company (people invited by its admins) or a personal workspace (one person's own, with no team). */
export type WorkspaceKind = "company" | "personal";

/**
 * The companies that may use this API. The company set up by hand (AUTH0_ORG_ID) is always allowed; every other one is a
 * row written when it signed itself up. A valid sign-in from an Auth0 organization that is not here is turned away, so
 * having an organization in the same Auth0 account is never enough.
 */
export class Companies {
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;

  constructor(private readonly config: Config, readonly homeOrgId: string) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS project origin");
    }
    this.baseUrl = url.origin;
    this.transport = config.fetch ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Companies | undefined {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return undefined;
    return new Companies({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY }, env.AUTH0_ORG_ID ?? "");
  }

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.config.secretKey, authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/json", ...extra };
  }

  /** Whether this organization may use the API. A failure to ask means no, so a database outage never widens access. */
  async isKnown(orgId: string): Promise<boolean> {
    if (orgId === this.homeOrgId) return true;
    if (!/^org_[A-Za-z0-9]{1,64}$/.test(orgId)) return false;
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?select=org_id,status&org_id=eq.${encodeURIComponent(orgId)}`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
    const rows = await response.json() as Array<{ org_id?: unknown; status?: unknown }>;
    return Array.isArray(rows) && rows.some(row => row.org_id === orgId && row.status === "active");
  }

  async register(company: { orgId: string; name: string; createdBy: string; kind?: WorkspaceKind }): Promise<void> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations`, {
      method: "POST", headers: this.headers(), signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ org_id: company.orgId, name: company.name, created_by_email: normalizeEmail(company.createdBy), status: "active",
        kind: company.kind ?? "company" })
    });
    if (response.status === 409) throw new NameTaken();
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
  }

  /** Whether this workspace is a company or one person's own; undefined for one listed before that was recorded. */
  async kind(orgId: string): Promise<WorkspaceKind | undefined> {
    if (orgId === this.homeOrgId || !/^org_[A-Za-z0-9]{1,64}$/.test(orgId)) return orgId === this.homeOrgId ? "company" : undefined;
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?select=kind&org_id=eq.${encodeURIComponent(orgId)}`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
    const rows = await response.json() as Array<{ kind?: unknown }>;
    const kind = Array.isArray(rows) ? rows[0]?.kind : undefined;
    return kind === "company" || kind === "personal" ? kind : undefined;
  }

  /** The company's display name, for showing people which company they are signed in to. */
  async name(orgId: string): Promise<string | undefined> {
    if (!/^org_[A-Za-z0-9]{1,64}$/.test(orgId)) return undefined;
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?select=name&org_id=eq.${encodeURIComponent(orgId)}`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
    const rows = await response.json() as Array<{ name?: unknown }>;
    const name = Array.isArray(rows) ? rows[0]?.name : undefined;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }

  /** Records the kind of a workspace listed before kinds were, once it has been worked out. Never changes a recorded one. */
  async recordKind(orgId: string, kind: WorkspaceKind): Promise<void> {
    if (orgId === this.homeOrgId) return;
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?org_id=eq.${encodeURIComponent(orgId)}&kind=is.null`, {
      method: "PATCH", headers: this.headers(), signal: AbortSignal.timeout(5000), body: JSON.stringify({ kind })
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
  }

  /**
   * Active companies (not personal workspaces) whose name is this one, ignoring case and spacing. At most two are
   * returned: one is an answer, two means the name alone can't say which.
   */
  async withName(name: string): Promise<Array<{ orgId: string; name: string }>> {
    const wanted = name.trim().replace(/\s+/g, " ");
    if (wanted.length < 2 || wanted.length > 60) return [];
    const pattern = wanted.replace(/[\\%_*]/g, "\\$&");
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?select=org_id,name&name=ilike.${encodeURIComponent(pattern)}&status=eq.active&or=(kind.is.null,kind.eq.company)&limit=2`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
    const rows = await response.json() as Array<{ org_id?: unknown; name?: unknown }>;
    return Array.isArray(rows) ? rows.filter(row => typeof row.org_id === "string" && /^org_[A-Za-z0-9]{1,64}$/.test(row.org_id)
      && typeof row.name === "string" && row.name.trim().replace(/\s+/g, " ").toLowerCase() === wanted.toLowerCase())
      .map(row => ({ orgId: row.org_id as string, name: row.name as string })) : [];
  }

  /**
   * The companies with at least one source connected, least recently synced first, for the scheduled background sync.
   * The home company is included when it has connections too.
   */
  async withConnectedSources(): Promise<string[]> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/source_connections?select=org_id,status`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase source connections failed (${response.status})`);
    const rows = await response.json() as Array<{ org_id?: unknown; status?: unknown }>;
    const orgs = new Set(Array.isArray(rows) ? rows.filter(row => typeof row.org_id === "string" && typeof row.status === "string" && row.status !== "Not connected")
      .map(row => row.org_id as string) : []);
    const synced = await this.transport(`${this.baseUrl}/rest/v1/connector_state?select=org_id,last_successful_sync_at`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    const last = new Map<string, number>();
    if (synced.ok) for (const row of await synced.json() as Array<{ org_id?: unknown; last_successful_sync_at?: unknown }>) {
      if (typeof row.org_id !== "string") continue;
      const at = typeof row.last_successful_sync_at === "string" ? Date.parse(row.last_successful_sync_at) : 0;
      last.set(row.org_id, Math.max(last.get(row.org_id) ?? 0, Number.isFinite(at) ? at : 0));
    }
    return [...orgs].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0));
  }

  /**
   * A secret Broppy keeps in Supabase Vault (the background sync's, or the Slack service secret), read with the service
   * key through a function only the service role may call, so it never has to be copied by hand. Undefined when it
   * hasn't been created.
   */
  async vaultSecret(name: "broppy_sync_cron_secret" | "broppy_slack_service_token"): Promise<string | undefined> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: this.headers(), body: "{}", signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return undefined;
    const secret = await response.json() as unknown;
    return typeof secret === "string" && secret.length >= 32 ? secret : undefined;
  }

  async remove(orgId: string): Promise<void> {
    if (orgId === this.homeOrgId) throw new Error("The home company cannot be removed");
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?org_id=eq.${encodeURIComponent(orgId)}`, {
      method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
  }

  /**
   * Whether someone with this email has already signed in to a company, in any organization. An entry nobody has
   * signed in to yet doesn't count: otherwise anyone could use a stranger's address to stop them signing their own company up.
   */
  async emailInUse(email: string): Promise<boolean> {
    const pattern = normalizeEmail(email).replace(/[\\%_*]/g, "\\$&");
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?select=user_id&email=ilike.${encodeURIComponent(pattern)}&auth0_sub=not.is.null&active=eq.true&limit=1`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  }
}
