import { createHash, randomBytes } from "node:crypto";
import type { Source, User } from "@brain/types";
import type { Persistence } from "./persistence.js";

type ProviderConfig = { clientId: string; clientSecret: string; scopes: string[]; baseUrl?: string; cloudId?: string };
type Site = { baseUrl: string; cloudId: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at: number; userId: string; site?: Site };
const endpoints = {
  slack: { authorize: "https://slack.com/oauth/v2/authorize", token: "https://slack.com/api/oauth.v2.access" },
  jira: { authorize: "https://auth.atlassian.com/authorize", token: "https://auth.atlassian.com/oauth/token" },
  confluence: { authorize: "https://auth.atlassian.com/authorize", token: "https://auth.atlassian.com/oauth/token" },
  drive: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" }
};
type Mode = "org" | "user";
/** OAuth state is single use and bound to the initiating user. Org connections need an admin; user connections only the signed-in person. Tokens stay in Vault. */
export class SourceOAuth {
  private readonly pending = new Map<string, { source: Source; mode: Mode; user: User; verifier: string; expiresAt: number }>();
  private readonly refreshes = new Map<string, Promise<string | undefined>>();
  private readonly cache = new Map<string, Tokens>();
  constructor(readonly configs: Partial<Record<Source, ProviderConfig>>, private readonly callbackOrigin: string,
    private readonly persistence: Persistence, private readonly transport: typeof fetch = fetch) {
    const origin = new URL(callbackOrigin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) throw new Error("Invalid OAuth callback origin");
  }
  private callback(source: Source, mode: Mode) { return `${this.callbackOrigin.replace(/\/$/, "")}/v1/${mode === "org" ? "admin/" : ""}connections/${source}/callback`; }
  private key(source: Source, userId?: string) { return userId ? `${source}/${userId}` : source; }
  begin(source: Source, user: User, mode: Mode = "org"): string {
    if ((mode === "org" && user.role !== "admin") || user.orgId !== this.persistence.orgId || user.active !== true) throw new Error("Forbidden");
    const config = this.configs[source]; if (!config) throw new Error("Source OAuth is not configured");
    for (const [state, flow] of this.pending) if (flow.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { source, mode, user, verifier, expiresAt: Date.now() + 600_000 });
    const url = new URL(endpoints[source].authorize);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.callback(source, mode), state,
      response_type: "code", ...(source === "slack" ? { user_scope: config.scopes.join(",") } : { scope: config.scopes.join(" ") }),
      ...(source === "jira" || source === "confluence" ? { audience: "api.atlassian.com", prompt: "consent" } : {}),
      ...(source === "drive" ? { access_type: "offline", prompt: "consent", code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url") } : {}) }).toString();
    return url.href;
  }
  private async exchange(source: Source, values: Record<string, string>): Promise<any> {
    const config = this.configs[source]!;
    const response = await this.transport(endpoints[source].token, { method: "POST", redirect: "error",
      headers: { "content-type": source === "jira" || source === "confluence" ? "application/json" : "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15000),
      body: source === "jira" || source === "confluence" ? JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...values }) : new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }) });
    if (!response.ok) throw new Error("Source OAuth exchange failed");
    const raw = await response.json();
    if (raw.ok === false) throw new Error("Source OAuth exchange failed");
    const result = source === "slack" ? raw.authed_user ?? raw : raw;
    if (typeof result.access_token !== "string" || !result.access_token) throw new Error("Source OAuth returned no user token");
    return result;
  }
  async complete(source: Source, state: string, code: string, currentUser: (sub: string) => Promise<User | undefined>, mode: Mode = "org"): Promise<User> {
    const flow = this.pending.get(state); this.pending.delete(state);
    if (!flow || flow.source !== source || flow.mode !== mode || flow.expiresAt <= Date.now() || !code) throw new Error("Invalid OAuth state");
    const user = await currentUser(flow.user.auth0Sub);
    if (!user || user.active !== true || (mode === "org" && user.role !== "admin") || user.orgId !== this.persistence.orgId || user.id !== flow.user.id) throw new Error("Forbidden");
    const result = await this.exchange(source, { grant_type: "authorization_code", code, redirect_uri: this.callback(source, mode),
      ...(source === "drive" ? { code_verifier: flow.verifier } : {}) });
    // Confirm that the source account belongs to the signed-in user.
    const profileUrl = source === "drive" ? "https://www.googleapis.com/oauth2/v3/userinfo" :
      source === "slack" ? `https://slack.com/api/users.info?user=${encodeURIComponent(result.id ?? "")}` : "https://api.atlassian.com/me";
    const response = await this.transport(profileUrl, { headers: { authorization: `Bearer ${result.access_token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Source identity could not be matched");
    const profile = await response.json();
    const email = source === "slack" ? profile.user?.profile?.email : profile.email;
    if (typeof email !== "string" || email.toLowerCase() !== user.email.toLowerCase() ||
      email.toLowerCase() !== user.platformIdentities?.[source]?.toLowerCase()) throw new Error("Source identity could not be matched");
    const tokens: Tokens = { access_token: result.access_token, refresh_token: result.refresh_token,
      expires_at: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : Number.MAX_SAFE_INTEGER, userId: user.id };
    if (source === "jira" || source === "confluence") {
      const sites = await this.accessibleSites(result.access_token);
      if (mode === "org") tokens.site = this.chooseSite(source, sites);
      else {
        // A person's own connection must reach the site the organization is connected to.
        const org = await this.orgSite(source);
        if (org && !sites.some(site => site.cloudId === org.cloudId)) throw new Error("This account has no access to the connected Atlassian site");
      }
    }
    if (mode === "org") await this.persistence.request("rpc/store_source_token", "POST", { organization: this.persistence.orgId, provider: source, token: tokens, actor: user.id });
    else await this.persistence.request("rpc/store_user_source_token", "POST", { organization: this.persistence.orgId, person: user.id, provider: source, token: tokens });
    this.cache.set(this.key(source, mode === "user" ? user.id : undefined), tokens);
    return user;
  }
  /** Atlassian sites an access token can reach, from Atlassian itself, so nobody types a cloud ID. */
  private async accessibleSites(accessToken: string): Promise<Site[]> {
    const response = await this.transport("https://api.atlassian.com/oauth/token/accessible-resources",
      { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Atlassian sites could not be listed");
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error("Atlassian sites could not be listed");
    return list.flatMap((item: any) => {
      if (typeof item?.id !== "string" || typeof item?.url !== "string") return [];
      try { const url = new URL(item.url); return url.protocol === "https:" ? [{ baseUrl: url.origin, cloudId: item.id }] : []; } catch { return []; }
    });
  }
  /** Configuration may pin a site (cloudId or baseUrl); otherwise the only reachable site is used. */
  private chooseSite(source: Source, sites: Site[]): Site {
    const config = this.configs[source];
    const pinned = config?.cloudId ? sites.filter(site => site.cloudId === config.cloudId) :
      config?.baseUrl ? sites.filter(site => site.baseUrl === new URL(config.baseUrl!).origin) : sites;
    if (pinned.length === 1) return pinned[0];
    if (!pinned.length) throw new Error("This account has no access to an Atlassian site that matches the configuration");
    throw new Error("Several Atlassian sites are available; set baseUrl or cloudId in the source configuration to choose one");
  }
  /** The organization's Atlassian site: found at connect time, or pinned by configuration. */
  async orgSite(source: Source): Promise<Site | undefined> {
    if (source !== "jira" && source !== "confluence") return undefined;
    let tokens = this.cache.get(source);
    if (!tokens) tokens = await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source }) ?? undefined;
    if (tokens?.site) return tokens.site;
    const config = this.configs[source];
    return config?.baseUrl && config.cloudId ? { baseUrl: new URL(config.baseUrl).origin, cloudId: config.cloudId } : undefined;
  }
  /** Same lookup for other services (for example the Slack app) that call Atlassian with a person's token. */
  siteFor(source: Source): Promise<Site | undefined> { return this.orgSite(source); }

  /**
   * Authorization header for a source. With a user ID, that person's own connection is preferred, then the org
   * connection when the same person made it. Without one, only the org connection (used for imports).
   */
  async authorization(source: Source, userId?: string): Promise<string | undefined> {
    const key = this.key(source, userId);
    const active = this.refreshes.get(key);
    if (active) { await active; return this.authorization(source, userId); }
    const next = this.resolveAuthorization(source, userId);
    this.refreshes.set(key, next);
    try { return await next; } finally { this.refreshes.delete(key); }
  }
  /** The lookup other services (for example the Slack app) use to act as a user: user + provider -> Authorization header, or undefined when not connected. */
  authorizationFor(userId: string, source: Source): Promise<string | undefined> { return this.userAuthorization(source, userId); }
  private async userAuthorization(source: Source, userId: string): Promise<string | undefined> {
    const key = this.key(source, userId);
    const active = this.refreshes.get(key);
    if (active) { await active; return this.userAuthorization(source, userId); }
    const next = this.resolveUser(source, userId);
    this.refreshes.set(key, next);
    try { return await next; } finally { this.refreshes.delete(key); }
  }
  private async resolveUser(source: Source, userId: string): Promise<string | undefined> {
    const key = this.key(source, userId);
    let tokens = this.cache.get(key);
    if (!tokens) tokens = await this.persistence.request("rpc/read_user_source_token", "POST", { organization: this.persistence.orgId, person: userId, provider: source }) ?? undefined;
    if (!tokens || tokens.userId !== userId) return undefined;
    tokens = await this.fresh(source, tokens, key, fresh => this.persistence.request("rpc/store_user_source_token", "POST",
      { organization: this.persistence.orgId, person: userId, provider: source, token: fresh }));
    return `Bearer ${tokens.access_token}`;
  }
  private async resolveAuthorization(source: Source, userId?: string): Promise<string | undefined> {
    if (userId) { const own = await this.resolveUser(source, userId); if (own) return own; }
    let tokens = this.cache.get(source);
    if (!tokens) tokens = await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source });
    if (!tokens || (userId && tokens.userId !== userId)) return undefined;
    tokens = await this.fresh(source, tokens, source, fresh => this.persistence.request("rpc/store_source_token", "POST",
      { organization: this.persistence.orgId, provider: source, token: fresh, actor: fresh.userId }));
    return `Bearer ${tokens.access_token}`;
  }
  private async fresh(source: Source, tokens: Tokens, key: string, save: (tokens: Tokens) => Promise<unknown>): Promise<Tokens> {
    if (tokens.expires_at <= Date.now() + 30_000) {
      if (!tokens.refresh_token) throw new Error("Reconnect expired source");
      const fresh = await this.exchange(source, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      tokens = { ...tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? tokens.refresh_token,
        expires_at: Date.now() + Number(fresh.expires_in ?? 3600) * 1000 };
      await save(tokens);
    }
    this.cache.set(key, tokens);
    return tokens;
  }
  /** Sources this person has connected to their own account. */
  async connectedSources(userId: string): Promise<Source[]> {
    const rows = await this.persistence.request("rpc/list_user_source_connections", "POST", { organization: this.persistence.orgId, person: userId });
    return Array.isArray(rows) ? rows.map(row => row.source as Source) : [];
  }
  async removeUser(source: Source, userId: string): Promise<void> {
    await this.refreshes.get(this.key(source, userId))?.catch(() => undefined);
    this.cache.delete(this.key(source, userId));
    await this.persistence.request("rpc/remove_user_source_tokens", "POST", { organization: this.persistence.orgId, person: userId, provider: source });
  }
  /** Disconnecting the org source also purges every person's own connection to it. */
  async remove(source: Source): Promise<void> {
    for (const [key, flow] of this.refreshes) if (key === source || key.startsWith(`${source}/`)) await flow.catch(() => undefined);
    for (const key of [...this.cache.keys()]) if (key === source || key.startsWith(`${source}/`)) this.cache.delete(key);
    await this.persistence.request("rpc/remove_source_token", "POST", { organization: this.persistence.orgId, provider: source });
    await this.persistence.request("rpc/remove_user_source_tokens", "POST", { organization: this.persistence.orgId, person: null, provider: source });
  }
}
