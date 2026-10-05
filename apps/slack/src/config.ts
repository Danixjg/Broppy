import { BroppyClient, type BroppyApi } from "./broppy.js";
import { JiraClient, type JiraApi } from "./jira.js";
import { SlackWebApi, type SlackApi } from "./slack.js";
import { DEFAULT_THRESHOLD, type Person } from "./score.js";
import { MemoryTaskStore, SupabaseTaskStore, type TaskStore } from "./store.js";

export interface Deps {
  signingSecret: string;
  slack: SlackApi;
  jira: JiraApi;
  broppy: BroppyApi;
  store: TaskStore;
  people: Person[];
  /** Channel ID to Jira project key. */
  channelProjects: Record<string, string>;
  defaultProject: string;
  threshold: number;
  webUrl: string;
  /** Runs work after the HTTP response is sent (Vercel's waitUntil). */
  defer: (work: Promise<unknown>) => void;
  now: () => Date;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json<T>(env: NodeJS.ProcessEnv, name: string, fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { throw new Error(`${name} must be valid JSON`); }
}

/** Reads the Slack app's settings. Anything missing fails startup, not the first Slack request. */
export function depsFromEnv(env: NodeJS.ProcessEnv, defer: Deps["defer"]): Deps {
  const people = json<Person[]>(env, "SLACK_USERS_JSON", []);
  if (!Array.isArray(people) || people.some(p => typeof p?.slackId !== "string" || typeof p?.name !== "string")) {
    throw new Error("SLACK_USERS_JSON must be a list of { slackId, name, brainUserId?, jiraAccountId? }");
  }
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const store = supabaseUrl
    ? new SupabaseTaskStore(env.AUTH0_ORG_ID?.trim() || "demo-company-a", supabaseUrl, required(env, "SUPABASE_SECRET_KEY"))
    : new MemoryTaskStore();
  if (!supabaseUrl && env.NODE_ENV === "production") throw new Error("SUPABASE_URL is required in production");
  return {
    signingSecret: required(env, "SLACK_SIGNING_SECRET"),
    slack: new SlackWebApi(required(env, "SLACK_BOT_TOKEN")),
    jira: new JiraClient(required(env, "JIRA_BASE_URL"), required(env, "JIRA_EMAIL"), required(env, "JIRA_API_TOKEN")),
    broppy: new BroppyClient(required(env, "BROPPY_API_URL")),
    store, people,
    channelProjects: json<Record<string, string>>(env, "SLACK_CHANNEL_PROJECTS_JSON", {}),
    defaultProject: required(env, "JIRA_DEFAULT_PROJECT"),
    threshold: env.TASK_SCORE_THRESHOLD ? Number(env.TASK_SCORE_THRESHOLD) : DEFAULT_THRESHOLD,
    webUrl: required(env, "BROPPY_WEB_URL").replace(/\/$/, ""),
    defer, now: () => new Date()
  };
}
