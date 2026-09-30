import { createHash, randomBytes } from "node:crypto";
import type { Source, User } from "@brain/types";
import type { Persistence } from "./persistence.js";

type ProviderConfig = { clientId: string; clientSecret: string; scopes: string[]; baseUrl?: string; cloudId?: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at: number; userId: string };
const endpoints = {
  slack: { authorize: "https://slack.com/oauth/v2/authorize", token: "https://slack.com/api/oauth.v2.access" },
  jira: { authorize: "https://auth.atlassian.com/authorize", token: "https://auth.atlassian.com/oauth/token" },
  confluence: { authorize: "https://auth.atlassian.com/authorize", token: "https://auth.atlassian.com/oauth/token" },
  drive: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" }
};
/** OAuth state is single use and bound to the initiating organization admin. Tokens stay in Vault. */
export class SourceOAuth {
  private readonly pending = new Map<string, { source: Source; user: User; verifier: string; expiresAt: number }>();
  private readonly refreshes = new Map<Source, Promise<string | undefined>>();
  private readonly cache = new Map<Source, Tokens>();
  constructor(readonly configs: Partial<Record<Source, ProviderConfig>>, private readonly callbackOrigin: string,
    private readonly persistence: Persistence, private readonly transport: typeof fetch = fetch) {
    const origin = new URL(callbackOrigin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) throw new Error("Invalid OAuth callback origin");
  }
  private callback(source: Source) { return `${this.callbackOrigin.replace(/\/$/, "")}/v1/admin/connections/${source}/callback`; }
  begin(source: Source, user: User): string {
    if (user.role !== "admin" || user.orgId !== this.persistence.orgId || user.active !== true) throw new Error("Forbidden");
    const config = this.configs[source]; if (!config) throw new Error("Source OAuth is not configured");
    for (const [state, flow] of this.pending) if (flow.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { source, user, verifier, expiresAt: Date.now() + 600_000 });
    const url = new URL(endpoints[source].authorize);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.callback(source), state,
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
  async complete(source: Source, state: string, code: string, currentUser: (sub: string) => Promise<User | undefined>): Promise<User> {
    const flow = this.pending.get(state); this.pending.delete(state);
    if (!flow || flow.source !== source || flow.expiresAt <= Date.now() || !code) throw new Error("Invalid OAuth state");
    const user = await currentUser(flow.user.auth0Sub);
    if (!user || user.active !== true || user.role !== "admin" || user.orgId !== this.persistence.orgId || user.id !== flow.user.id) throw new Error("Forbidden");
    const result = await this.exchange(source, { grant_type: "authorization_code", code, redirect_uri: this.callback(source),
      ...(source === "drive" ? { code_verifier: flow.verifier } : {}) });
    // Confirm that the source account belongs to the signed-in administrator.
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
    await this.persistence.request("rpc/store_source_token", "POST", { organization: this.persistence.orgId, provider: source, token: tokens, actor: user.id });
    this.cache.set(source, tokens);
    return user;
  }
  async authorization(source: Source, userId?: string): Promise<string | undefined> {
    const active = this.refreshes.get(source);
    if (active) { await active; return this.authorization(source, userId); }
    const next = this.resolveAuthorization(source, userId);
    this.refreshes.set(source, next);
    try { return await next; } finally { this.refreshes.delete(source); }
  }
  private async resolveAuthorization(source: Source, userId?: string): Promise<string | undefined> {
    let tokens = this.cache.get(source);
    if (!tokens) tokens = await this.persistence.request("rpc/read_source_token", "POST", { organization: this.persistence.orgId, provider: source });
    if (!tokens || (userId && tokens.userId !== userId)) return undefined;
    if (tokens.expires_at <= Date.now() + 30_000) {
      if (!tokens.refresh_token) throw new Error("Reconnect expired source");
      const fresh = await this.exchange(source, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      tokens = { ...tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? tokens.refresh_token,
        expires_at: Date.now() + Number(fresh.expires_in ?? 3600) * 1000 };
      await this.persistence.request("rpc/store_source_token", "POST", { organization: this.persistence.orgId, provider: source, token: tokens, actor: tokens.userId });
    }
    this.cache.set(source, tokens);
    return `Bearer ${tokens.access_token}`;
  }
  async remove(source: Source): Promise<void> {
    await this.refreshes.get(source)?.catch(() => undefined);
    this.cache.delete(source);
    await this.persistence.request("rpc/remove_source_token", "POST", { organization: this.persistence.orgId, provider: source });
  }
}
