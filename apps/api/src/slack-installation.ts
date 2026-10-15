import { createHash, randomBytes } from "node:crypto";
import type { User } from "@brain/types";
import type { BotGrant, InstallationRegistry, InstallationStatus } from "../../slack/src/installations.js";
import { SupabaseInstallationRegistry } from "../../slack/src/installations.js";
import { nonempty, parseRuntime, record, runtimeFromEnv, type TrustedRuntime } from "../../slack/src/runtime.js";
import { DEFAULT_THRESHOLD } from "../../slack/src/score.js";
import { companyServiceToken } from "./service-actor.js";

import { SLACK_BOT_SCOPES } from "../../slack/src/app-manifest.js";
export type CallbackOutcome = "installed" | "denied" | "failed" | "unsupported" | "conflict" | "email_mismatch";
export class SlackSetupError extends Error {}
class SlackGrantError extends Error {}
class SlackInstallerMismatch extends SlackGrantError {}
export interface SlackOAuthConfig { appId: string; clientId: string; clientSecret: string; orgId: string; apiOrigin: string; webOrigin: string }
function secureOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new SlackSetupError("Slack onboarding requires HTTPS API and web origins");
  return url.origin;
}
/** The admin's own Slack token, handed back with the install when the same consent also connects Slack as a source. */
export interface UserGrant { access_token: string; scope?: string }
export interface SlackSourceLink {
  /** User scopes requested with the install; the one consent then installs the bot and connects Slack as a source. */
  scopes: string[];
  /** Stores the admin's Slack token as the organization's shared source connection. */
  store(admin: User, grant: UserGrant): Promise<void>;
  /** Called when the install was refused after the token was stored. */
  discard(): Promise<void>;
}
/**
 * What the shared Slack app is told about a company that signed itself up: where to reach the API, the task store, and
 * a service secret for that company alone. The people, channel projects and Jira destinations a company's Slack setup
 * may later declare start empty, so the bot answers questions and offers nothing to Jira until they are set.
 */
export function companyRuntime(env: NodeJS.ProcessEnv, orgId: string, jiraBaseUrl?: string): TrustedRuntime {
  if (!env.SLACK_SERVICE_TOKEN) throw new SlackSetupError("Slack for other companies needs SLACK_SERVICE_TOKEN");
  return parseRuntime({ orgId, apiUrl: env.API_ORIGIN, webUrl: env.WEB_ORIGIN, storeUrl: env.SUPABASE_URL, storeKey: env.SUPABASE_SECRET_KEY,
    serviceToken: companyServiceToken(env.SLACK_SERVICE_TOKEN, orgId), people: [], channelProjects: {}, defaultProject: "",
    threshold: env.TASK_SCORE_THRESHOLD ? Number(env.TASK_SCORE_THRESHOLD) : DEFAULT_THRESHOLD,
    ...(jiraBaseUrl ? { jiraBaseUrl } : {}), destinations: [], completionPolicies: [] });
}

export class SlackInstallationOAuth {
  readonly redirectUri: string;
  link?: SlackSourceLink;
  readonly returnUrl: string;
  constructor(readonly config: SlackOAuthConfig, private readonly registry: InstallationRegistry, private readonly runtime: () => TrustedRuntime | Promise<TrustedRuntime>,
    private readonly directory: (sub: string) => Promise<User | undefined>, private readonly transport: typeof fetch = fetch) {
    this.redirectUri = `${secureOrigin(config.apiOrigin)}/v1/admin/slack-installation/callback`;
    this.returnUrl = `${secureOrigin(config.webOrigin)}/workspace/connectors.html`;
    if (!config.appId || !config.clientId || !config.clientSecret || !config.orgId) throw new SlackSetupError("Incomplete Slack OAuth configuration");
  }
  static fromEnv(env: NodeJS.ProcessEnv, directory: (sub: string) => Promise<User | undefined>): SlackInstallationOAuth | undefined {
    if (!env.SLACK_APP_ID && !env.SLACK_CLIENT_ID && !env.SLACK_CLIENT_SECRET) return undefined;
    return new SlackInstallationOAuth({ appId: env.SLACK_APP_ID ?? "", clientId: env.SLACK_CLIENT_ID ?? "", clientSecret: env.SLACK_CLIENT_SECRET ?? "",
      orgId: env.AUTH0_ORG_ID ?? "", apiOrigin: env.API_ORIGIN ?? "", webOrigin: env.WEB_ORIGIN ?? "" }, SupabaseInstallationRegistry.fromEnv(env), () => runtimeFromEnv(env), directory);
  }
  /** The same Slack app, installed by a company that signed itself up. Undefined when the app isn't configured. */
  static forCompany(env: NodeJS.ProcessEnv, orgId: string, directory: (sub: string) => Promise<User | undefined>,
    jiraSite: () => Promise<string | undefined>): SlackInstallationOAuth | undefined {
    if (!env.SLACK_APP_ID || !env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.SLACK_SERVICE_TOKEN) return undefined;
    return new SlackInstallationOAuth({ appId: env.SLACK_APP_ID, clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET,
      orgId, apiOrigin: env.API_ORIGIN ?? "", webOrigin: env.WEB_ORIGIN ?? "" }, SupabaseInstallationRegistry.fromEnv(env),
      async () => companyRuntime(env, orgId, await jiraSite()), directory);
  }
  private async admin(actor: User): Promise<User> {
    if (!actor.auth0Sub) throw new Error("Forbidden");
    const current = await this.directory(actor.auth0Sub);
    if (!current || current.active !== true || current.role !== "admin" || current.orgId !== this.config.orgId || current.id !== actor.id || current.auth0Sub !== actor.auth0Sub) throw new Error("Forbidden");
    return current;
  }
  async begin(actor: User): Promise<string> {
    const admin = await this.admin(actor);
    if (!nonempty(admin.platformIdentities?.slack)) throw new Error("Your Broppy profile needs a Slack email before you can add Broppy to Slack. Ask your administrator to update it.");
    await this.runtime();
    const state = randomBytes(32).toString("base64url");
    await this.registry.begin(this.config.orgId, this.config.appId, this.hash(state), admin.id, admin.auth0Sub!);
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", this.config.clientId); url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    if (this.link?.scopes.length) url.searchParams.set("user_scope", this.link.scopes.join(","));
    url.searchParams.set("state", state); url.searchParams.set("redirect_uri", this.redirectUri);
    return url.href;
  }
  private hash(state: string): string { return createHash("sha256").update(state).digest("hex"); }
  private async slack(method: string, token: string, body: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const response = await this.transport(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => { throw new SlackGrantError("Slack request unavailable"); });
    const value: unknown = await response.json().catch(() => { throw new SlackGrantError("Invalid Slack response"); });
    if (!response.ok || !record(value) || value.ok !== true) throw new SlackGrantError("Slack could not validate this installation");
    return value;
  }
  private async grant(code: string, admin: User): Promise<{ bot: BotGrant; user?: UserGrant }> {
    const response = await this.transport("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {
      authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, redirect_uri: this.redirectUri }).toString(), signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => { throw new SlackGrantError("Slack request unavailable"); });
    const value: unknown = await response.json().catch(() => { throw new SlackGrantError("Invalid Slack response"); });
    if (!response.ok || !record(value) || value.ok !== true || value.app_id !== this.config.appId || value.token_type !== "bot"
      || !nonempty(value.access_token) || !value.access_token.startsWith("xoxb-") || !nonempty(value.bot_user_id) || !record(value.team) || !nonempty(value.team.id)
      || !record(value.authed_user) || !nonempty(value.authed_user.id) || typeof value.scope !== "string") throw new SlackGrantError("Invalid Slack bot grant");
    if (value.is_enterprise_install !== false || value.expires_in !== undefined || value.refresh_token !== undefined) throw new SlackSetupError("Workspace installs require Slack token rotation to be disabled");
    const scopes = value.scope.split(",").map(scope => scope.trim()).filter(Boolean);
    // The app may ask for more than Broppy needs (scopes added in Slack's settings); what Broppy needs must all be there.
    if (!SLACK_BOT_SCOPES.every(scope => scopes.includes(scope))) throw new SlackGrantError(`Slack did not grant ${SLACK_BOT_SCOPES.filter(scope => !scopes.includes(scope)).join(", ")}`);
    const proof = await this.slack("auth.test", value.access_token);
    if (proof.team_id !== value.team.id || proof.user_id !== value.bot_user_id || !nonempty(proof.bot_id)
      || (proof.app_id !== undefined && proof.app_id !== this.config.appId) || proof.is_enterprise_install === true) throw new SlackGrantError("Slack bot identity did not match");
    const installer = await this.slack("users.info", value.access_token, { user: value.authed_user.id });
    if (!record(installer.user) || installer.user.id !== value.authed_user.id || installer.user.deleted === true || installer.user.is_bot === true
      || !record(installer.user.profile) || !nonempty(installer.user.profile.email)) throw new SlackGrantError("Slack installer identity unavailable");
    const email = installer.user.profile.email.trim().toLowerCase();
    if (!nonempty(admin.platformIdentities?.slack) || email !== admin.email.trim().toLowerCase() || email !== admin.platformIdentities.slack.trim().toLowerCase()) throw new SlackInstallerMismatch("Slack installer does not match the Broppy admin");
    const bot = { accessToken: value.access_token, appId: this.config.appId, teamId: value.team.id, teamName: typeof value.team.name === "string" ? value.team.name : value.team.id, botUserId: value.bot_user_id, scopes };
    if (!this.link?.scopes.length) return { bot };
    const authed = value.authed_user;
    if (!nonempty(authed.access_token) || !authed.access_token.startsWith("xoxp-") || authed.refresh_token !== undefined || authed.expires_in !== undefined) throw new SlackGrantError("Slack returned no usable admin token");
    // The token must belong to the admin who started the install, in the workspace that was just installed.
    const owner = await this.slack("auth.test", authed.access_token);
    if (owner.team_id !== value.team.id || owner.user_id !== authed.id) throw new SlackGrantError("Slack admin token did not match");
    return { bot, user: { access_token: authed.access_token, scope: typeof authed.scope === "string" ? authed.scope : undefined } };
  }
  async callback(input: { state: string; code: string; error: string }): Promise<CallbackOutcome> {
    const refuse = (reason: string): CallbackOutcome => { console.warn(JSON.stringify({ event: "slack_install_refused", org: this.config.orgId, reason })); return "failed"; };
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return refuse("malformed state");
    const attempt = await this.registry.consume(this.config.orgId, this.config.appId, this.hash(input.state));
    if (!attempt) return refuse("unknown, used or expired install attempt");
    if (input.error) return "denied";
    if (!input.code) return refuse("Slack returned no code");
    const actor = await this.directory(attempt.personSub);
    if (!actor || actor.id !== attempt.person || actor.auth0Sub !== attempt.personSub || actor.orgId !== attempt.orgId || actor.active !== true || actor.role !== "admin" || !nonempty(actor.platformIdentities?.slack)) return refuse("installing admin is no longer an active admin with a Slack identity");
    try {
      const grant = await this.grant(input.code, actor);
      if (grant.user) await this.link!.store(actor, grant.user);
      if (await this.registry.publish(attempt, grant.bot, await this.runtime())) return "installed";
      if (grant.user) await this.link!.discard();
      return "conflict";
    } catch (error) {
      // Which check refused it, never a token, so a failed install can be diagnosed from the logs.
      if (error instanceof SlackSetupError || error instanceof SlackGrantError) console.warn(JSON.stringify({ event: "slack_install_refused", org: this.config.orgId, reason: error.message }));
      if (error instanceof SlackSetupError) return "unsupported";
      if (error instanceof SlackInstallerMismatch) return "email_mismatch";
      if (error instanceof SlackGrantError) return "failed";
      throw error;
    }
  }
  async status(actor: User): Promise<InstallationStatus> { await this.admin(actor); return this.registry.status(this.config.orgId, this.config.appId); }
  async refresh(actor: User, generation: number): Promise<boolean> { await this.admin(actor); return this.registry.refresh(this.config.orgId, this.config.appId, generation, await this.runtime()); }
  async disconnect(actor: User, generation: number): Promise<boolean> {
    await this.admin(actor);
    const status = await this.registry.status(this.config.orgId, this.config.appId);
    if (status.state === "not_installed" || status.state !== "active") return true;
    return this.registry.deactivate(this.config.orgId, this.config.appId, status.teamId, generation, "disconnected");
  }
}
