import { normalizeEmail } from "./user-directory.js";

interface Config { url: string; secretKey: string; fetch?: typeof fetch }

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

  async register(company: { orgId: string; name: string; createdBy: string }): Promise<void> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations`, {
      method: "POST", headers: this.headers(), signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ org_id: company.orgId, name: company.name, created_by_email: normalizeEmail(company.createdBy), status: "active" })
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
  }

  async remove(orgId: string): Promise<void> {
    if (orgId === this.homeOrgId) throw new Error("The home company cannot be removed");
    const response = await this.transport(`${this.baseUrl}/rest/v1/organizations?org_id=eq.${encodeURIComponent(orgId)}`, {
      method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase organizations failed (${response.status})`);
  }

  /** Removes every person listed for a company that is being undone. Never the home company's. */
  async forgetPeople(orgId: string): Promise<void> {
    if (orgId === this.homeOrgId) throw new Error("The home company cannot be removed");
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?org_id=eq.${encodeURIComponent(orgId)}`, {
      method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
  }

  /** Whether this email is already on any company's list (active), in any organization. */
  async emailInUse(email: string): Promise<boolean> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?select=user_id&email=eq.${encodeURIComponent(normalizeEmail(email))}&limit=1`, {
      headers: this.headers(), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  }
}
