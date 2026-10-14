import { BroppyClient } from "./broppy.js";
import type { Deps } from "./config.js";
import { DEFAULT_THRESHOLD, type Person } from "./score.js";
import { SlackWebApi } from "./slack.js";
import { SupabaseTaskStore } from "./store.js";

export interface TrustedRuntime {
  orgId: string;
  apiUrl: string;
  serviceToken: string;
  webUrl: string;
  storeUrl: string;
  storeKey: string;
  people: Person[];
  channelProjects: Record<string, string>;
  /** Empty for a company that hasn't chosen one: suggestions then carry no project until someone picks it. */
  defaultProject: string;
  threshold: number;
  /** The company's Jira site. A company that hasn't connected Jira has none, and no Jira destination can be declared. */
  jiraBaseUrl?: string;
  destinations: NonNullable<Deps["destinations"]>;
  completionPolicies: NonNullable<Deps["completionPolicies"]>;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function origin(value: unknown): string {
  if (!nonempty(value)) throw new Error("Slack runtime needs a trusted HTTPS origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("Slack runtime needs a trusted HTTPS origin");
  return url.origin;
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
export function parseRuntime(input: unknown): TrustedRuntime {
  if (!record(input) || !nonempty(input.orgId) || !nonempty(input.serviceToken) || input.serviceToken.length < 32 || !nonempty(input.storeKey)
    || typeof input.defaultProject !== "string" || (input.jiraBaseUrl !== undefined && !nonempty(input.jiraBaseUrl)) || typeof input.threshold !== "number" || !Number.isFinite(input.threshold)
    || input.threshold < 0 || input.threshold > 1 || !Array.isArray(input.people) || !record(input.channelProjects)
    || !Array.isArray(input.destinations) || !Array.isArray(input.completionPolicies)) throw new Error("Invalid trusted Slack runtime");
  const people: Person[] = input.people.map(person => {
    if (!record(person) || !nonempty(person.slackId) || !nonempty(person.name)
      || (person.brainUserId !== undefined && !nonempty(person.brainUserId)) || (person.jiraAccountId !== undefined && !nonempty(person.jiraAccountId))) throw new Error("Invalid Slack people");
    return { slackId: person.slackId, name: person.name, ...(nonempty(person.brainUserId) ? { brainUserId: person.brainUserId } : {}), ...(nonempty(person.jiraAccountId) ? { jiraAccountId: person.jiraAccountId } : {}) };
  });
  const channelProjects: Record<string, string> = {};
  for (const [channel, project] of Object.entries(input.channelProjects)) {
    if (!nonempty(project)) throw new Error("Invalid Slack channel project");
    channelProjects[channel] = project;
  }
  const completionPolicies = input.completionPolicies.map(policy => {
    if (!record(policy) || !nonempty(policy.channel) || !nonempty(policy.project) || !stringList(policy.allowedSlackIds)) throw new Error("Invalid Slack completion policy");
    return { channel: policy.channel, project: policy.project, allowedSlackIds: policy.allowedSlackIds };
  });
  const destinations = input.destinations.map(policy => {
    if (!record(policy) || !nonempty(policy.channel) || !nonempty(policy.project) || !stringList(policy.allowedSlackIds) || !Array.isArray(policy.disclosureFields)) throw new Error("Invalid Slack destination policy");
    const disclosureFields: Array<"summary" | "permalink"> = policy.disclosureFields.map(field => {
      if (field !== "summary" && field !== "permalink") throw new Error("Invalid Slack disclosure field");
      return field;
    });
    return { channel: policy.channel, project: policy.project, allowedSlackIds: policy.allowedSlackIds, disclosureFields };
  });
  // Declaring where Jira issues go only makes sense once there is a Jira site to check their links against.
  if ((destinations.length || completionPolicies.length) && input.jiraBaseUrl === undefined) throw new Error("Slack Jira destinations need a Jira site");
  return { orgId: input.orgId, apiUrl: origin(input.apiUrl), webUrl: origin(input.webUrl), storeUrl: origin(input.storeUrl),
    ...(input.jiraBaseUrl === undefined ? {} : { jiraBaseUrl: origin(input.jiraBaseUrl) }), serviceToken: input.serviceToken, storeKey: input.storeKey, people, channelProjects, defaultProject: input.defaultProject, threshold: input.threshold, destinations, completionPolicies };
}
function json(env: NodeJS.ProcessEnv, key: string, fallback: unknown): unknown { return env[key] ? JSON.parse(env[key]) : fallback; }
export function runtimeFromEnv(env: NodeJS.ProcessEnv): TrustedRuntime {
  return parseRuntime({ orgId: env.AUTH0_ORG_ID, apiUrl: env.API_ORIGIN, webUrl: env.WEB_ORIGIN, storeUrl: env.SUPABASE_URL, storeKey: env.SUPABASE_SECRET_KEY,
    serviceToken: env.SLACK_SERVICE_TOKEN, people: json(env,"SLACK_USERS_JSON",[]), channelProjects: json(env,"SLACK_CHANNEL_PROJECTS_JSON",{}),
    defaultProject: env.JIRA_DEFAULT_PROJECT, threshold: env.TASK_SCORE_THRESHOLD ? Number(env.TASK_SCORE_THRESHOLD) : DEFAULT_THRESHOLD,
    jiraBaseUrl: env.JIRA_BASE_URL, destinations: json(env,"SLACK_JIRA_DESTINATIONS_JSON",[]), completionPolicies: json(env,"SLACK_COMPLETION_POLICY_JSON",[]) });
}
export interface WorkspaceScope { appId: string; teamId: string; orgId: string; generation: number; current: () => Promise<boolean> }
export class InactiveInstallationError extends Error {}
export async function requireCurrent(scope?: WorkspaceScope): Promise<void> {
  if (scope && !await scope.current()) throw new InactiveInstallationError("Slack installation changed");
}
export const sameTeam = (scope: WorkspaceScope | undefined, teamId: string | undefined): boolean => !scope || teamId === scope.teamId;
export function installedDeps(runtime: TrustedRuntime, token: string, scope: WorkspaceScope, signingSecret: string, defer: Deps["defer"], workerToken?: string): Deps {
  const transport: typeof fetch = async (input, init) => {
    await requireCurrent(scope);
    return fetch(input, init);
  };
  return { ...runtime, signingSecret, slack: new SlackWebApi(token, transport), broppy: new BroppyClient(runtime.apiUrl, runtime.serviceToken, transport, runtime.orgId),
    store: new SupabaseTaskStore(scope.orgId, runtime.storeUrl, runtime.storeKey), workspace: scope,
    webUrl: runtime.webUrl, defer, workerToken, now: () => new Date() };
}
