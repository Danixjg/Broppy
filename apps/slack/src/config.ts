import type { BroppyApi } from "./broppy.js";
import type { JiraApi } from "./jira.js";
import type { SlackApi } from "./slack.js";
import type { Person } from "./score.js";
import type { TaskStore } from "./store.js";
import type { WorkspaceScope } from "./runtime.js";

export interface Deps {
  signingSecret: string;
  workspace?: WorkspaceScope;
  slack: SlackApi;
  jira?: JiraApi;
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
  destinations?: Array<{ channel: string; project: string; allowedSlackIds: string[]; disclosureFields: Array<"summary" | "permalink"> }>;
  completionPolicies?: Array<{ channel: string; project: string; allowedSlackIds: string[] }>;
  workerToken?: string;
  jiraBaseUrl?: string;
}
