import { timingSafeEqual } from "node:crypto";
import type { Deps } from "./config.js";
import type { SlackRequest, SlackResponse } from "./handler.js";
import { handleSlack } from "./handler.js";
import type { ActiveInstallation, InstallationRegistry } from "./installations.js";
import { SupabaseInstallationRegistry } from "./installations.js";
import { installedDeps, nonempty, record, type WorkspaceScope } from "./runtime.js";
import { verifySignature } from "./slack.js";

export interface GatewayConfig {
  appId: string;
  signingSecret: string;
  registry: InstallationRegistry;
  defer: Deps["defer"];
  workerToken?: string;
  now?: () => Date;
  transport?: typeof fetch;
  runtime?: (installation: ActiveInstallation, scope: WorkspaceScope) => Deps;
}
function bearerMatches(expected: string | undefined, authorization: string | undefined): boolean {
  const given = authorization?.replace(/^Bearer /, "");
  return Boolean(expected && expected.length >= 32 && given && Buffer.byteLength(given) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(given), Buffer.from(expected)));
}
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
export function workspaceIdentity(payload: unknown, expectedApp: string): string | undefined {
  if (!record(payload)) return undefined;
  const teams: unknown[] = [payload.team_id];
  const apps: unknown[] = [payload.api_app_id, payload.app_id];
  if (record(payload.team)) teams.push(payload.team.id);
  if (record(payload.user)) teams.push(payload.user.team_id);
  if (record(payload.view)) { teams.push(payload.view.team_id); apps.push(payload.view.app_id); }
  if (record(payload.event)) { teams.push(payload.event.team_id, payload.event.team); apps.push(payload.event.app_id); }
  if (Array.isArray(payload.authorizations)) for (const authorization of payload.authorizations) {
    if (!record(authorization) || authorization.is_enterprise_install === true) return undefined;
    teams.push(authorization.team_id);
  }
  const presentTeams = teams.filter(value => value !== undefined && value !== null);
  const presentApps = apps.filter(value => value !== undefined && value !== null);
  if (!presentTeams.length || !presentApps.length || !presentTeams.every(nonempty) || !presentApps.every(value => value === expectedApp)) return undefined;
  const team = presentTeams[0];
  return nonempty(team) && presentTeams.every(value => value === team) ? team : undefined;
}
function requestPayload(request: SlackRequest): unknown {
  if (request.path.endsWith("/events")) return parseJson(request.rawBody);
  const form = new URLSearchParams(request.rawBody);
  if (request.path.endsWith("/commands")) return Object.fromEntries(form.entries());
  if (request.path.endsWith("/interactions")) return parseJson(form.get("payload") ?? "");
  return undefined;
}
export class SlackGateway {
  constructor(private readonly config: GatewayConfig) {
    if (!config.appId || !config.signingSecret) throw new Error("SLACK_APP_ID and SLACK_SIGNING_SECRET are required");
  }
  static fromEnv(env: NodeJS.ProcessEnv, defer: Deps["defer"]): SlackGateway {
    return new SlackGateway({ appId: env.SLACK_APP_ID ?? "", signingSecret: env.SLACK_SIGNING_SECRET ?? "", workerToken: env.SLACK_WORKER_TOKEN,
      registry: SupabaseInstallationRegistry.fromEnv(env), defer });
  }
  async forTeam(teamId: string): Promise<Deps | undefined> {
    const installation = await this.config.registry.resolve(this.config.appId, teamId);
    if (!installation || installation.appId !== this.config.appId || installation.teamId !== teamId || installation.runtime.orgId !== installation.orgId) return undefined;
    const scope: WorkspaceScope = { appId: installation.appId, teamId, orgId: installation.orgId, generation: installation.generation,
      current: () => this.config.registry.current(installation.appId, teamId, installation.generation) };
    return this.config.runtime ? this.config.runtime(installation, scope) : installedDeps(installation.runtime, installation.accessToken, scope,
      this.config.signingSecret, this.config.defer, this.config.workerToken);
  }
  private async revoked(installation: ActiveInstallation): Promise<SlackResponse> {
    const response = await (this.config.transport ?? fetch)("https://slack.com/api/auth.test", { method: "POST", headers: {
      authorization: `Bearer ${installation.accessToken}`, "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => undefined);
    if (!response) return { status: 503 };
    const proof: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !record(proof)) return { status: 503 };
    if (proof.ok === true) return proof.team_id === installation.teamId && proof.user_id === installation.botUserId ? { status: 200 } : { status: 503 };
    if (proof.ok !== false || !["invalid_auth", "token_revoked", "account_inactive"].includes(String(proof.error))) return { status: 503 };
    await this.config.registry.deactivate(installation.orgId, installation.appId, installation.teamId, installation.generation, "uninstalled");
    return { status: 200 };
  }
  async handle(request: SlackRequest): Promise<SlackResponse> {
    const maintenance = request.path.endsWith("/feedback") || request.path.endsWith("/recovery");
    if (maintenance) {
      if (!bearerMatches(this.config.workerToken, request.headers.authorization)) return { status: 401 };
      if (request.method !== "POST") return { status: 405 };
      const body = parseJson(request.rawBody);
      if (!record(body) || !nonempty(body.teamId)) return { status: 400 };
      const deps = await this.forTeam(body.teamId);
      return deps ? handleSlack(deps, request) : { status: 403 };
    }
    if (request.method !== "POST") return { status: 405 };
    if (!verifySignature(this.config.signingSecret, request.rawBody, request.headers["x-slack-request-timestamp"], request.headers["x-slack-signature"],
      (this.config.now?.() ?? new Date()).getTime())) return { status: 401 };
    if (!["/events", "/commands", "/interactions"].some(path => request.path.endsWith(path))) return { status: 404 };
    const payload = requestPayload(request);
    if (request.path.endsWith("/events") && record(payload) && payload.type === "url_verification" && nonempty(payload.challenge)) return { status: 200, body: { challenge: payload.challenge } };
    const teamId = workspaceIdentity(payload, this.config.appId);
    if (!teamId) return { status: 400 };
    if (record(payload) && record(payload.event) && ["app_uninstalled", "tokens_revoked"].includes(String(payload.event.type))) {
      const installation = await this.config.registry.resolve(this.config.appId, teamId);
      if (!installation) return { status: 200 };
      if (payload.event.type === "tokens_revoked") {
        const tokens = payload.event.tokens;
        if (!record(tokens) || !Array.isArray(tokens.bot) || !tokens.bot.includes(installation.botUserId)) return { status: 200 };
      }
      return this.revoked(installation);
    }
    const deps = await this.forTeam(teamId);
    if (deps) return handleSlack(deps, request);
    // A workspace with no current installation: a person running /broppy gets a plain answer, not Slack's dispatch error.
    if (request.path.endsWith("/commands")) return { status: 200, body: { response_type: "ephemeral",
      text: "Broppy isn't connected to this Slack workspace right now. Your company's Broppy admin can add it again from Broppy's Connectors page." } };
    return { status: 403 };
  }
}
