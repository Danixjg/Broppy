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

  private async page(offset: number): Promise<User[]> {
    const response = await this.transport(`${this.baseUrl}/rest/v1/workspace_users?select=*&org_id=eq.${encodeURIComponent(this.orgId)}&order=user_id&limit=500&offset=${offset}`, {
      headers: { apikey: this.config.secretKey, authorization: `Bearer ${this.config.secretKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase workspace users failed (${response.status})`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Supabase workspace users are empty");
    return rows.map((row: unknown) => {
      if (!row || typeof row !== "object") throw new Error("Invalid workspace user");
      const item = row as Record<string, unknown>;
      if (typeof item.auth0_sub !== "string" || typeof item.org_id !== "string" || typeof item.active !== "boolean" || typeof item.user_id !== "string" ||
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
        auth0Sub: item.auth0_sub,
        orgId: item.org_id,
        active: item.active,
        role: item.role as User["role"],
        groups: item.groups as string[],
        contractor: item.contractor,
        platformIdentities: platformIdentities as User["platformIdentities"]
      };
    });
  }

  async bySub(sub: string): Promise<User | undefined> {
    return (await this.list()).find(user => user.auth0Sub === sub);
  }
}
