import type { TrustedRuntime } from "./runtime.js";
import { nonempty, parseRuntime, record } from "./runtime.js";

export type InstallationStatus = { state: "not_installed"; configured: boolean } |
  { state: "active" | "disconnected" | "uninstalled"; teamId: string; teamName: string; generation: number; installedAt: string };
export interface InstallAttempt { attemptId: number; orgId: string; appId: string; person: string; personSub: string }
export interface BotGrant { accessToken: string; appId: string; teamId: string; teamName: string; botUserId: string; scopes: string[] }
export interface ActiveInstallation { appId: string; teamId: string; orgId: string; botUserId: string; generation: number; accessToken: string; runtime: TrustedRuntime }
export interface InstallationRegistry {
  begin(orgId: string, appId: string, hash: string, person: string, personSub: string): Promise<void>;
  consume(orgId: string, appId: string, hash: string): Promise<InstallAttempt | undefined>;
  publish(attempt: InstallAttempt, grant: BotGrant, runtime: TrustedRuntime): Promise<boolean>;
  status(orgId: string, appId: string): Promise<InstallationStatus>;
  resolve(appId: string, teamId: string): Promise<ActiveInstallation | undefined>;
  current(appId: string, teamId: string, generation: number): Promise<boolean>;
  refresh(orgId: string, appId: string, generation: number, runtime: TrustedRuntime): Promise<boolean>;
  deactivate(orgId: string, appId: string, teamId: string, generation: number, reason: "disconnected" | "uninstalled"): Promise<boolean>;
}
export function parseStatus(value: unknown): InstallationStatus {
  if (value === null || value === undefined) return { state: "not_installed", configured: true };
  if (!record(value) || (value.state !== "active" && value.state !== "disconnected" && value.state !== "uninstalled")
    || !nonempty(value.teamId) || typeof value.teamName !== "string" || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation)
    || value.generation < 1 || !nonempty(value.installedAt)) throw new Error("Invalid Slack installation status");
  return { state: value.state, teamId: value.teamId, teamName: value.teamName, generation: value.generation, installedAt: value.installedAt };
}
export class SupabaseInstallationRegistry implements InstallationRegistry {
  private readonly url: string;
  constructor(url: string, private readonly key: string, private readonly transport: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash || !key) throw new Error("Invalid Slack registry configuration");
    this.url = parsed.origin;
  }
  static fromEnv(env: NodeJS.ProcessEnv): SupabaseInstallationRegistry {
    if (Boolean(env.SLACK_REGISTRY_URL) !== Boolean(env.SLACK_REGISTRY_SECRET_KEY)) throw new Error("Slack registry requires both URL and secret key");
    return new SupabaseInstallationRegistry(env.SLACK_REGISTRY_URL ?? env.SUPABASE_URL ?? "", env.SLACK_REGISTRY_SECRET_KEY ?? env.SUPABASE_SECRET_KEY ?? "");
  }
  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.transport(`${this.url}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`Slack installation registry unavailable (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  async begin(orgId: string, appId: string, hash: string, person: string, personSub: string): Promise<void> {
    await this.rpc("begin_slack_install", { organization: orgId, application: appId, state_hash: hash, person, person_sub: personSub });
  }
  async consume(orgId: string, appId: string, hash: string): Promise<InstallAttempt | undefined> {
    const value = await this.rpc("consume_slack_install", { organization: orgId, application: appId, state_hash: hash });
    if (value === null || value === undefined) return undefined;
    if (!record(value) || typeof value.attemptId !== "number" || !Number.isSafeInteger(value.attemptId) || value.attemptId < 1
      || value.orgId !== orgId || value.appId !== appId || !nonempty(value.person) || !nonempty(value.personSub)) throw new Error("Invalid Slack install attempt");
    return { attemptId: value.attemptId, orgId, appId, person: value.person, personSub: value.personSub };
  }
  async publish(attempt: InstallAttempt, grant: BotGrant, runtime: TrustedRuntime): Promise<boolean> {
    if (attempt.appId !== grant.appId || runtime.orgId !== attempt.orgId) return false;
    return await this.rpc("publish_slack_install", { organization: attempt.orgId, application: attempt.appId, attempt: attempt.attemptId, workspace: grant.teamId,
      workspace_name: grant.teamName, bot_user: grant.botUserId, granted_scopes: grant.scopes, bundle: { accessToken: grant.accessToken, runtime } }) === true;
  }
  async status(orgId: string, appId: string): Promise<InstallationStatus> { return parseStatus(await this.rpc("slack_install_status", { organization: orgId, application: appId })); }
  async resolve(appId: string, teamId: string): Promise<ActiveInstallation | undefined> {
    const value = await this.rpc("resolve_slack_install", { application: appId, workspace: teamId });
    if (value === null || value === undefined) return undefined;
    if (!record(value) || value.appId !== appId || value.teamId !== teamId || !nonempty(value.orgId) || !nonempty(value.botUserId) || !nonempty(value.accessToken)
      || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error("Invalid active Slack installation");
    const runtime = parseRuntime(value.runtime);
    if (runtime.orgId !== value.orgId) throw new Error("Slack runtime organization mismatch");
    return { appId, teamId, orgId: value.orgId, botUserId: value.botUserId, generation: value.generation, accessToken: value.accessToken, runtime };
  }
  async current(appId: string, teamId: string, generation: number): Promise<boolean> { return await this.rpc("current_slack_install", { application: appId, workspace: teamId, expected_generation: generation }) === true; }
  async refresh(orgId: string, appId: string, generation: number, runtime: TrustedRuntime): Promise<boolean> {
    if (runtime.orgId !== orgId) return false;
    return await this.rpc("refresh_slack_runtime", { organization: orgId, application: appId, expected_generation: generation, runtime }) === true;
  }
  async deactivate(orgId: string, appId: string, teamId: string, generation: number, reason: "disconnected" | "uninstalled"): Promise<boolean> {
    return await this.rpc("deactivate_slack_install", { organization: orgId, application: appId, workspace: teamId, expected_generation: generation, reason }) === true;
  }
}
