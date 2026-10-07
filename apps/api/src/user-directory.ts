import type { User } from "@brain/types";

interface SupabaseUserConfig {
  url: string;
  secretKey: string;
  fetch?: typeof fetch;
}

function configured(): SupabaseUserConfig | undefined {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url && !secretKey) return undefined;
  if (!url || !secretKey) throw new Error("Supabase directory requires URL and secret key");
  return { url, secretKey };
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export class DirectoryConflict extends Error { constructor() { super("Already in the directory"); } }

export class UserDirectory {
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;

  constructor(private readonly config: SupabaseUserConfig, private readonly orgId: string) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS project origin");
    }
    this.baseUrl = url.origin;
    this.transport = config.fetch ?? fetch;
  }

  static fromEnv(): UserDirectory | undefined {
    const config = configured();
    return config ? new UserDirectory(config, process.env.AUTH0_ORG_ID ?? "") : undefined;
  }

  async list(): Promise<User[]> {
    const users: User[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.page(offset); users.push(...page);
      if (page.length < 500) return users;
    }
  }

  private async page(offset: number, filter = "", limit = 500): Promise<User[]> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?select=*&org_id=eq.${encodeURIComponent(this.orgId)}${filter}&order=user_id&limit=${limit}&offset=${offset}`, {
      headers: { apikey: this.config.secretKey, authorization: `Bearer ${this.config.secretKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    return this.rows(await response.json());
  }

  private single(rows: unknown): User {
    const [user] = this.rows(rows);
    if (!user) throw new Error("Supabase workspace users are empty");
    return user;
  }

  private rows(rows: unknown): User[] {
    if (!Array.isArray(rows)) throw new Error("Supabase workspace users are empty");
    return rows.map((row: unknown) => {
      if (!row || typeof row !== "object") throw new Error("Invalid workspace user");
      const item = row as Record<string, unknown>;
      // A person the admin has added but who has not signed in yet has no Auth0 subject.
      if ((item.auth0_sub !== null && typeof item.auth0_sub !== "string") || typeof item.org_id !== "string" || typeof item.active !== "boolean" || typeof item.user_id !== "string" ||
        typeof item.name !== "string" || typeof item.email !== "string" ||
        !["member", "admin", "compliance"].includes(String(item.role)) ||
        !Array.isArray(item.groups) || !item.groups.every(group => typeof group === "string") ||
        typeof item.contractor !== "boolean" || !item.platform_identities ||
        typeof item.platform_identities !== "object" || Array.isArray(item.platform_identities)) {
        throw new Error("Invalid workspace user");
      }
      const platformIdentities = item.platform_identities as Record<string, unknown>;
      if (!Object.values(platformIdentities).every(value => typeof value === "string")) {
        throw new Error("Invalid workspace user identities");
      }
      return {
        id: item.user_id,
        name: item.name,
        email: item.email,
        auth0Sub: item.auth0_sub ?? "",
        orgId: item.org_id,
        active: item.active,
        role: item.role as User["role"],
        groups: item.groups as string[],
        contractor: item.contractor,
        platformIdentities: platformIdentities as User["platformIdentities"]
      };
    });
  }

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.config.secretKey, authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/json", ...extra };
  }

  /** The directory entry for this work email, whether or not the person has signed in or was removed. */
  async byEmail(email: string): Promise<User | undefined> {
    const wanted = normalizeEmail(email);
    return (await this.page(0, `&email=eq.${encodeURIComponent(wanted)}`, 1)).find(user => user.email.toLowerCase() === wanted);
  }

  /** Adds a person the admin has onboarded. They have no Auth0 subject until they first sign in. */
  async add(person: { id: string; name: string; email: string; role: User["role"]; groups: string[] }): Promise<User> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users`, {
      method: "POST", headers: this.headers({ Prefer: "return=representation" }), signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ org_id: this.orgId, user_id: person.id, name: person.name, email: normalizeEmail(person.email), role: person.role,
        groups: person.groups, contractor: false, active: true, platform_identities: { slack: normalizeEmail(person.email) } })
    });
    if (response.status === 409) throw new DirectoryConflict();
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    return this.single(await response.json());
  }

  /** Changes one person's row. Only the fields given change. */
  async update(userId: string, patch: { active?: boolean; role?: User["role"]; name?: string }): Promise<User | undefined> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?org_id=eq.${encodeURIComponent(this.orgId)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH", headers: this.headers({ Prefer: "return=representation" }), signal: AbortSignal.timeout(5000), body: JSON.stringify(patch)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    return this.rows(await response.json())[0];
  }

  /**
   * Links a first sign-in to the entry the admin added for that email. It only changes a row that is active and has no
   * subject yet, so one email can be claimed once and a second Auth0 account never takes it over.
   */
  async claim(email: string, sub: string): Promise<User | undefined> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?org_id=eq.${encodeURIComponent(this.orgId)}&email=eq.${encodeURIComponent(normalizeEmail(email))}&auth0_sub=is.null&active=eq.true`, {
      method: "PATCH", headers: this.headers({ Prefer: "return=representation" }), signal: AbortSignal.timeout(5000), body: JSON.stringify({ auth0_sub: sub })
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    return this.rows(await response.json())[0];
  }

  async bySub(sub: string): Promise<User | undefined> {
    // One keyed lookup (org_id + auth0_sub), not a read of the whole directory on every request.
    return (await this.page(0, `&auth0_sub=eq.${encodeURIComponent(sub)}`, 1)).find(user => user.auth0Sub === sub);
  }

  /** The user whose Slack identity in the directory (their Slack email) is this one. Several matches are ambiguous, so none. */
  async bySlackIdentity(identity: string): Promise<User | undefined> {
    const matches = await this.page(0, `&platform_identities->>slack=eq.${encodeURIComponent(identity)}`, 2);
    return matches.length === 1 && matches[0].platformIdentities?.slack === identity ? matches[0] : undefined;
  }
}
