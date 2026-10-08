import type { User } from "@brain/types";
import type { SourceOAuth } from "./source-oauth.js";

export interface IssueInput {
  project: string;
  summary: string;
  description: string;
  assigneeAccountId?: string;
  dueDate?: string;
}

export interface JiraIssueAccess {
  key: string;
  url: string;
  statusCategory: "new" | "indeterminate" | "done";
  providerVersion: string;
  operationMarker?: string;
}

function descriptionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  return [typeof node.text === "string" ? node.text : "",
    ...(Array.isArray(node.content) ? node.content.map(descriptionText) : [])].filter(Boolean).join("\n");
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
 * Jira writes made with the organization's shared connection (the admin's). Jira shows the admin as the creator, so each
 * issue and comment names the Broppy user it was made for, and the audit log records them. The token never leaves the API.
 * Returns undefined when the admin has not connected Jira.
 */
export class JiraAsUser {
  constructor(private readonly oauth: Pick<SourceOAuth, "authorization" | "siteFor">, private readonly accountId?: (email: string) => Promise<string | undefined>, private readonly transport: typeof fetch = fetch) {}

  /** The shared connection can open any issue the admin can, so the person's own right to see it is checked first. */
  private async mayView(user: User, key: string, authorization: string, site: { cloudId: string }): Promise<boolean> {
    const email = (user.platformIdentities?.jira ?? "").trim().toLowerCase();
    const accountId = email && await this.accountId?.(email);
    if (!accountId) return false;
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/user/permission/search?accountId=${encodeURIComponent(accountId)}&permissions=BROWSE_PROJECTS&issueKey=${encodeURIComponent(key)}&maxResults=10`,
      { headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (response.status === 403 || response.status === 404) return false;
    if (!response.ok) throw new Error(`Jira access check failed (${response.status})`);
    const list: unknown = await response.json();
    return Array.isArray(list) && list.some((item: any) => item?.accountId === accountId);
  }

  private async request(user: User, path: string, body: unknown) {
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
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
        project: { key: input.project }, summary: input.summary, issuetype: { name: "Task" }, description: adf(`${input.description}\n\nTracked in Broppy for ${user.name}.`),
        ...(input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
        ...(input.dueDate ? { duedate: input.dueDate } : {})
      }
    });
    if (!result) return undefined;
    if (typeof result.data.key !== "string") throw new Error("Jira returned no issue key");
    return { key: result.data.key, url: `${result.site.baseUrl}/browse/${result.data.key}` };
  }

  async comment(user: User, key: string, text: string): Promise<boolean> {
    return Boolean(await this.request(user, `issue/${encodeURIComponent(key)}/comment`, { body: adf(`${text}\n\nAdded in Broppy for ${user.name}.`) }));
  }

  async access(user: User, key: string): Promise<JiraIssueAccess | undefined> {
    if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(key) || user.active === false) throw new Error("Invalid issue");
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return undefined;
    if (!await this.mayView(user, key, authorization, site)) return undefined;
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,updated,description`, {
      headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (response.status === 403 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Jira access check failed (${response.status})`);
    const payload = await response.json();
    const category = payload?.fields?.status?.statusCategory?.key;
    const providerVersion = payload?.fields?.updated;
    if (!["new", "indeterminate", "done"].includes(category) || typeof providerVersion !== "string" ||
      !Number.isFinite(Date.parse(providerVersion))) throw new Error("Invalid Jira status");
    const operationMarker = descriptionText(payload.fields.description).match(/Broppy operation: ([a-f\d-]{36})\b/i)?.[1];
    return { key, url: `${site.baseUrl}/browse/${key}`, statusCategory: category, providerVersion,
      ...(operationMarker ? { operationMarker } : {}) };
  }
}
