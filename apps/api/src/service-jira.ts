import type { User } from "@brain/types";
import type { SourceOAuth } from "./source-oauth.js";

export interface IssueInput {
  project: string;
  summary: string;
  description: string;
  assigneeAccountId?: string;
  dueDate?: string;
}

const adf = (text: string) => ({
  type: "doc", version: 1,
  content: text.split("\n\n").map(paragraph => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] }))
});

/** Checks a request body before it goes to Jira; throws on anything the Slack app would never send. */
export function parseIssue(input: Record<string, unknown>): IssueInput {
  const { project, summary, description, assigneeAccountId, dueDate } = input;
  if (typeof project !== "string" || !/^[A-Z][A-Z0-9]{0,9}$/.test(project)) throw new Error("Invalid issue");
  if (typeof summary !== "string" || !summary.trim() || summary.length > 250) throw new Error("Invalid issue");
  if (typeof description !== "string" || description.length > 5000) throw new Error("Invalid issue");
  if (assigneeAccountId !== undefined && (typeof assigneeAccountId !== "string" || !/^[\w:.-]{1,128}$/.test(assigneeAccountId))) throw new Error("Invalid issue");
  if (dueDate !== undefined && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) throw new Error("Invalid issue");
  return { project, summary, description, ...(assigneeAccountId ? { assigneeAccountId } : {}), ...(dueDate ? { dueDate } : {}) };
}

export function parseComment(input: Record<string, unknown>): { key: string; text: string } {
  if (typeof input.key !== "string" || !/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(input.key) ||
    typeof input.text !== "string" || !input.text.trim() || input.text.length > 5000) throw new Error("Invalid comment");
  return { key: input.key, text: input.text };
}

/**
 * Jira writes made with the person's own connection, so they are the creator and Jira applies their permissions.
 * Their token never leaves the API. Returns undefined when they haven't connected Jira, so the caller can fall back.
 */
export class JiraAsUser {
  constructor(private readonly oauth: Pick<SourceOAuth, "authorizationFor" | "siteFor">, private readonly transport: typeof fetch = fetch) {}

  private async request(user: User, path: string, body: unknown) {
    const [authorization, site] = await Promise.all([this.oauth.authorizationFor(user.id, "jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return undefined;
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/${path}`, {
      method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Jira request failed (${response.status})`);
    const text = await response.text();
    return { site, data: text ? JSON.parse(text) : {} };
  }

  async createIssue(user: User, input: IssueInput): Promise<{ key: string; url: string } | undefined> {
    const result = await this.request(user, "issue", {
      fields: {
        project: { key: input.project }, summary: input.summary, issuetype: { name: "Task" }, description: adf(input.description),
        ...(input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
        ...(input.dueDate ? { duedate: input.dueDate } : {})
      }
    });
    if (!result) return undefined;
    if (typeof result.data.key !== "string") throw new Error("Jira returned no issue key");
    return { key: result.data.key, url: `${result.site.baseUrl}/browse/${result.data.key}` };
  }

  async comment(user: User, key: string, text: string): Promise<boolean> {
    return Boolean(await this.request(user, `issue/${encodeURIComponent(key)}/comment`, { body: adf(text) }));
  }
}
