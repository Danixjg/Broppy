import { SAME_TASK, similarity } from "./fingerprint.js";

export interface TaskLink {
  fingerprint: string;
  project: string;
  title: string;
  tokens: string[];
  issueKey: string;
  issueUrl: string;
  assigneeSlackId: string;
  trackedBy: string;
  channel: string;
  messageTs: string;
  mentionCount: number;
}

/** What Slack and Jira need remembered between requests. A serverless instance keeps nothing, so it lives in Supabase. */
export interface TaskStore {
  /** The existing issue for the same task in a project, by exact fingerprint first and near-match tokens second. */
  findTask(project: string, fingerprint: string, tokens: string[]): Promise<TaskLink | undefined>;
  saveTask(link: TaskLink): Promise<void>;
  /** Records another sighting of a task already tracked. */
  recordRepeat(link: TaskLink, channel: string, messageTs: string): Promise<void>;
  /** True the first time a key is claimed, false after. Slack retries events and buttons are clickable twice. */
  claim(key: string): Promise<boolean>;
  /** Gives a claim back when the work it guarded failed, so the click can be retried. */
  release(key: string): Promise<void>;
}

export function bestMatch(links: TaskLink[], project: string, fingerprint: string, tokens: string[]): TaskLink | undefined {
  const inProject = links.filter(link => link.project === project);
  const exact = inProject.find(link => link.fingerprint === fingerprint);
  if (exact) return exact;
  let best: { link: TaskLink; score: number } | undefined;
  for (const link of inProject) {
    const score = similarity(link.tokens, tokens);
    if (score >= SAME_TASK && (!best || score > best.score)) best = { link, score };
  }
  return best?.link;
}

export class MemoryTaskStore implements TaskStore {
  readonly links: TaskLink[] = [];
  private readonly claims = new Set<string>();
  async findTask(project: string, fingerprint: string, tokens: string[]) {
    return bestMatch(this.links, project, fingerprint, tokens);
  }
  async saveTask(link: TaskLink) { this.links.push({ ...link }); }
  async recordRepeat(link: TaskLink) {
    const stored = this.links.find(candidate => candidate.fingerprint === link.fingerprint && candidate.project === link.project);
    if (stored) stored.mentionCount += 1;
  }
  async claim(key: string) {
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }
  async release(key: string) { this.claims.delete(key); }
}

/** Supabase REST with the server key, the same way the API's persistence talks to it. Tables: infra/supabase/migrations/006. */
export class SupabaseTaskStore implements TaskStore {
  constructor(private readonly orgId: string, private readonly url: string, private readonly key: string,
    private readonly transport: typeof fetch = fetch) {
    if (!orgId || new URL(url).protocol !== "https:") throw new Error("Invalid Supabase configuration");
  }

  private async request(path: string, method = "GET", data?: unknown, prefer?: string): Promise<any> {
    const response = await this.transport(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json",
        ...(prefer ? { prefer } : {})
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private static fromRow(row: any): TaskLink {
    return {
      fingerprint: row.fingerprint, project: row.project, title: row.title, tokens: row.tokens, issueKey: row.issue_key,
      issueUrl: row.issue_url, assigneeSlackId: row.assignee_slack_id, trackedBy: row.tracked_by, channel: row.channel,
      messageTs: row.message_ts, mentionCount: row.mention_count
    };
  }

  async findTask(project: string, fingerprint: string, tokens: string[]) {
    const org = encodeURIComponent(this.orgId);
    const rows = await this.request(
      `slack_task_links?org_id=eq.${org}&project=eq.${encodeURIComponent(project)}&order=updated_at.desc&limit=500`);
    if (!Array.isArray(rows)) throw new Error("Invalid stored tasks");
    return bestMatch(rows.map(SupabaseTaskStore.fromRow), project, fingerprint, tokens);
  }

  async saveTask(link: TaskLink) {
    await this.request("slack_task_links?on_conflict=org_id,project,fingerprint", "POST", {
      org_id: this.orgId, fingerprint: link.fingerprint, project: link.project, title: link.title, tokens: link.tokens,
      issue_key: link.issueKey, issue_url: link.issueUrl, assignee_slack_id: link.assigneeSlackId,
      tracked_by: link.trackedBy, channel: link.channel, message_ts: link.messageTs, mention_count: link.mentionCount
    }, "resolution=merge-duplicates");
  }

  async recordRepeat(link: TaskLink, channel: string, messageTs: string) {
    await this.request("rpc/record_slack_task_repeat", "POST", {
      organization: this.orgId, project_key: link.project, task_fingerprint: link.fingerprint, repeat_channel: channel,
      repeat_ts: messageTs
    });
  }

  async claim(key: string) {
    const rows = await this.request("slack_claims?on_conflict=org_id,key", "POST", { org_id: this.orgId, key },
      "resolution=ignore-duplicates,return=representation");
    return Array.isArray(rows) && rows.length > 0;
  }

  async release(key: string) {
    await this.request(`slack_claims?org_id=eq.${encodeURIComponent(this.orgId)}&key=eq.${encodeURIComponent(key)}`, "DELETE");
  }
}
