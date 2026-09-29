import type { User } from "@brain/types";

interface SupabaseUserConfig {
  url: string;
  secretKey: string;
  publishableKey: string;
  fetch?: typeof fetch;
}

function configured(): SupabaseUserConfig | undefined {
  const url = process.env.SUPABASE_AUTH_URL;
  const secretKey = process.env.SUPABASE_AUTH_SECRET_KEY;
  const publishableKey = process.env.SUPABASE_AUTH_PUBLISHABLE_KEY;
  if (!url && !secretKey && !publishableKey) return undefined;
  if (!url || !secretKey || !publishableKey) throw new Error("Supabase auth requires URL, secret, and publishable key");
  return { url, secretKey, publishableKey };
}

export class SupabaseUsers {
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;

  constructor(private readonly config: SupabaseUserConfig) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("SUPABASE_AUTH_URL must be an HTTPS project origin");
    }
    this.baseUrl = url.origin;
    this.transport = config.fetch ?? fetch;
  }

  static fromEnv(): SupabaseUsers | undefined {
    const config = configured();
    return config ? new SupabaseUsers(config) : undefined;
  }

  async list(): Promise<User[]> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?select=*`, {
      headers: { apikey: this.config.secretKey, authorization: `Bearer ${this.config.secretKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error("Supabase workspace users are empty");
    return rows.map((row: unknown) => {
      if (!row || typeof row !== "object") throw new Error("Invalid workspace user");
      const item = row as Record<string, unknown>;
      if (typeof item.auth_user_id !== "string" || typeof item.user_id !== "string" ||
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
        auth0Sub: `auth0|${item.user_id}`,
        supabaseAuthId: item.auth_user_id,
        role: item.role as User["role"],
        groups: item.groups as string[],
        contractor: item.contractor,
        platformIdentities: platformIdentities as User["platformIdentities"]
      };
    });
  }

  async validate(authorization: string, _users: readonly User[]): Promise<User> {
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) throw new Error("Unauthorized");
    try {
      const response = await this.transport(`${this.baseUrl}/auth/v1/user`, {
        headers: { apikey: this.config.publishableKey, authorization },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error("Unauthorized");
      const identity: unknown = await response.json();
      if (!identity || typeof identity !== "object" || !("id" in identity) ||
        typeof identity.id !== "string") throw new Error("Unauthorized");
      const user = (await this.list()).find(item => item.supabaseAuthId === identity.id);
      if (!user) throw new Error("Unauthorized");
      return user;
    } catch {
      throw new Error("Unauthorized");
    }
  }
}
