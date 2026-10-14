import { createHash, randomBytes } from "node:crypto";
import type { AuthorizationProvider, Source, User } from "@brain/types";
import { oauthProviders, type ProviderConfig } from "./oauth-providers.js";
import type { Persistence } from "./persistence.js";

type Site = { baseUrl: string; cloudId: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at: number; userId: string; scopes?: string[]; site?: Site };
/** OAuth state is single use and bound to the initiating admin. Only the company admin connects a source; everyone works from that one shared connection. Tokens stay in Vault. */
export class SourceOAuth {
  private readonly refreshes = new Map<string, Promise<string | undefined>>();
  private readonly cache = new Map<string, Tokens>();
  constructor(readonly configs: Partial<Record<Source, ProviderConfig>>, private readonly callbackOrigin: string,
    private readonly persistence: Persistence, private readonly transport: typeof fetch = fetch) {
    const origin = new URL(callbackOrigin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) throw new Error("Invalid OAuth callback origin");
  }
  /**
   * Jira and Confluence both sign in through Atlassian. When both use the same Atlassian app, one approval asks for both
   * products' permissions and connects both; this is the other one.
   */
  partner(source: Source): Source | undefined {
    const other: Source | undefined = source === "jira" ? "confluence" : source === "confluence" ? "jira" : undefined;
    const mine = this.configs[source], theirs = other && this.configs[other];
    return mine && theirs && mine.clientId === theirs.clientId ? other : undefined;
  }
  private callback(source: Source) { return `${this.callbackOrigin.replace(/\/$/, "")}/v1/admin/connections/${source}/callback`; }
  /** Starts a sign-in. The single-use state lives in Supabase, so the callback can reach any API instance. */
  async begin(source: Source, user: User): Promise<string> {
    if (user.role !== "admin" || user.orgId !== this.persistence.orgId || user.active !== true) throw new Error("Forbidden");
    const own = this.configs[source]; if (!own) throw new Error("Source OAuth is not configured");
    const partner = this.partner(source);
    const config = partner ? { ...own, scopes: [...new Set([...own.scopes, ...this.configs[partner]!.scopes])] } : own;
    const provider = oauthProviders[source];
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    await this.persistence.request("rpc/begin_oauth_flow", "POST", { organization: this.persistence.orgId, state_hash: this.hash(state), provider: source, flow_mode: "org",
      person: user.id, person_sub: user.auth0Sub, code_verifier: verifier, ttl_seconds: 600 });
    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.callback(source), state, response_type: "code",
      ...provider.authorizeParams(config, verifier) }).toString();
    return url.href;
  }
  private hash(state: string) { return createHash("sha256").update(state).digest("hex"); }
  private async exchange(source: Source, values: Record<string, string>): Promise<any> {
    const config = this.configs[source]!, provider = oauthProviders[source];
    const request = provider.tokenRequest(config, values);
    const response = await this.transport(provider.tokenUrl, { method: "POST", redirect: "error",
      headers: { "content-type": request.contentType }, signal: AbortSignal.timeout(15000), body: request.body });
    if (!response.ok) throw new Error("Source OAuth exchange failed");
    const result = provider.tokens(await response.json());
    if (!result || typeof result.access_token !== "string" || !result.access_token) throw new Error("Source OAuth returned no user token");
    return result;
  }
  async complete(source: Source, state: string, code: string, currentUser: (sub: string) => Promise<User | undefined>): Promise<User> {
    return (await this.completeAll(source, state, code, currentUser)).user;
  }

  /**
   * Completes an approval and says which sources it connected: the one asked for, and its Atlassian partner when the
   * same approval granted every permission the partner needs, the person's account for it is the same, and its site
   * is the same one.
   */
  async completeAll(source: Source, state: string, code: string, currentUser: (sub: string) => Promise<User | undefined>): Promise<{ user: User; sources: Source[] }> {
    const provider = oauthProviders[source];
    const flow = state ? await this.persistence.request("rpc/consume_oauth_flow", "POST", { organization: this.persistence.orgId, state_hash: this.hash(state) }) : undefined;
    if (!flow || flow.provider !== source || flow.flow_mode !== "org" || !code) throw new Error("Invalid OAuth state");
    const user = await currentUser(flow.person_sub);
    if (!user || user.active !== true || user.role !== "admin" || user.orgId !== this.persistence.orgId || user.id !== flow.person) throw new Error("Forbidden");
    const result = await this.exchange(source, { grant_type: "authorization_code", code, redirect_uri: this.callback(source), ...provider.exchangeValues(flow.code_verifier) });
    // Confirm that the source account belongs to the signed-in user.
    const response = await this.transport(provider.profileUrl(result), { headers: { authorization: `Bearer ${result.access_token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Source identity could not be matched");
    const profile = await response.json();
    const email = provider.email(profile);
    if (typeof email !== "string" || email.toLowerCase() !== user.email.toLowerCase() ||
      email.toLowerCase() !== user.platformIdentities?.[source]?.toLowerCase()) throw new Error("Source identity could not be matched");
    const tokens = this.tokensFrom(source, user, result);
    const sites = provider.sites ? await this.accessibleSites(result.access_token) : [];
    if (provider.sites) tokens.site = this.chooseSite(source, sites);
    await this.store(source, user, tokens);
    const partner = this.partner(source);
    if (!partner) return { user, sources: [source] };
    const granted = typeof result.scope === "string" ? result.scope.split(/[ ,]/).filter(Boolean) : [];
    const needed = this.configs[partner]!.scopes;
    let site: Site | undefined;
    try { site = this.chooseSite(partner, sites); } catch { site = undefined; }
    if (!needed.every(scope => granted.includes(scope)) || email.toLowerCase() !== user.platformIdentities?.[partner]?.toLowerCase()
      || !site || site.cloudId !== tokens.site?.cloudId) return { user, sources: [source] };
    await this.store(partner, user, { ...tokens, site });
    return { user, sources: [source, partner] };
  }
  private tokensFrom(source: Source, user: User, result: any): Tokens {
    return { access_token: result.access_token, refresh_token: result.refresh_token,
      expires_at: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : Number.MAX_SAFE_INTEGER, userId: user.id,
      scopes: typeof result.scope === "string" ? result.scope.split(/[ ,]/).filter(Boolean) : this.configs[source]?.scopes };
  }
  private async store(source: Source, user: User, tokens: Tokens) {
    await this.persistence.request("rpc/store_source_token", "POST", { organization: this.persistence.orgId, provider: source, token: tokens, actor: user.id });
    this.cache.set(source, tokens);
    // Anyone who connected their own account before sharing was introduced no longer has a use for it.
    await this.persistence.request("rpc/remove_user_source_tokens", "POST", { organization: this.persistence.orgId, person: null, provider: source });
  }
  /** Stores the organization's connection from a grant obtained elsewhere (Slack's combined install and connect). The caller has already matched the account to the admin. */
  async storeGrant(source: Source, admin: User, grant: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }): Promise<void> {
    if (admin.role !== "admin" || admin.active !== true || admin.orgId !== this.persistence.orgId) throw new Error("Forbidden");
    await this.store(source, admin, this.tokensFrom(source, admin, grant));
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
    if (!oauthProviders[source].sites) return undefined;
    let tokens = this.cache.get(source);
    if (!tokens) tokens = await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source }) ?? undefined;
    if (tokens?.site) return tokens.site;
    const config = this.configs[source];
    return config?.baseUrl && config.cloudId ? { baseUrl: new URL(config.baseUrl).origin, cloudId: config.cloudId } : undefined;
  }
  /** Same lookup for other services (for example the Slack app) that call Atlassian with a person's token. */
  siteFor(source: Source): Promise<Site | undefined> { return this.orgSite(source); }

  /** Authorization header for a source: always the organization's connection, refreshed when needed. */
  async authorization(source: Source): Promise<string | undefined> {
    const active = this.refreshes.get(source);
    if (active) { await active; return this.authorization(source); }
    const next = this.resolveAuthorization(source);
    this.refreshes.set(source, next);
    try { return await next; } finally { this.refreshes.delete(source); }
  }
  /** The credential source for one provider, in the shape connectors consume: they ask for a header and never see where it came from. */
  provider(source: Source): AuthorizationProvider { return () => this.authorization(source); }
  private async resolveAuthorization(source: Source): Promise<string | undefined> {
    let tokens = this.cache.get(source);
    if (!tokens) tokens = await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source });
    if (!tokens) return undefined;
    tokens = await this.fresh(source, tokens, source, fresh => this.persistence.request("rpc/store_source_token", "POST",
      { organization: this.persistence.orgId, provider: source, token: fresh, actor: fresh.userId }),
      async () => await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source }) ?? undefined);
    return `Bearer ${tokens.access_token}`;
  }
  /** Refreshes an expired token. Another instance may have refreshed (and, for Atlassian, rotated the refresh token) first, so the stored copy is checked before and after. */
  private async fresh(source: Source, tokens: Tokens, key: string, save: (tokens: Tokens) => Promise<unknown>, reload: () => Promise<Tokens | undefined>): Promise<Tokens> {
    const valid = (value?: Tokens) => Boolean(value && value.expires_at > Date.now() + 30_000);
    if (!valid(tokens)) {
      const stored = await reload();
      if (stored && valid(stored)) tokens = stored;
      else {
        const latest = stored ?? tokens;
        if (!latest.refresh_token) throw new Error("Reconnect expired source");
        try {
          const fresh = await this.exchange(source, { grant_type: "refresh_token", refresh_token: latest.refresh_token });
          tokens = { ...latest, access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? latest.refresh_token,
            expires_at: Date.now() + Number(fresh.expires_in ?? 3600) * 1000 };
          await save(tokens);
        } catch (error) {
          const raced = await reload();
          if (!raced || !valid(raced) || raced.access_token === latest.access_token) throw error;
          tokens = raced;
        }
      }
    }
    this.cache.set(key, tokens);
    return tokens;
  }
  /** Disconnecting removes the shared connection, and any personal connection left over from before sharing. */
  async remove(source: Source): Promise<void> {
    for (const [key, flow] of this.refreshes) if (key === source || key.startsWith(`${source}/`)) await flow.catch(() => undefined);
    for (const key of [...this.cache.keys()]) if (key === source || key.startsWith(`${source}/`)) this.cache.delete(key);
    await this.persistence.request("rpc/remove_source_token", "POST", { organization: this.persistence.orgId, provider: source });
    await this.persistence.request("rpc/remove_user_source_tokens", "POST", { organization: this.persistence.orgId, person: null, provider: source });
  }
}
