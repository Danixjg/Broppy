import type { User } from "@brain/types";
import type { SourceOAuth } from "./source-oauth.js";
import { CommandRejection, type EditFields, type TransitionMeta } from "./task-commands.js";

export interface IssueInput {
  project: string;
  summary: string;
  description: string;
  assigneeAccountId?: string;
  /** The owner's email, when the caller knows the person but not their Jira account; resolved here. */
  assigneeEmail?: string;
  dueDate?: string;
}

/** A reviewed field the new issue went without, so the person can be told instead of finding out in Jira. */
export type OmittedField = "owner" | "due date";

/** Jira answered with an error. A 400 is a definite refusal: nothing was created, so trying again cannot duplicate. */
export class JiraRequestError extends Error {
  constructor(readonly status: number, readonly fields: string[]) { super(`Jira request failed (${status})`); }
}

const PROVIDER_FIELD_IDS: Record<string, string> = {
  summary: "summary", duedate: "dueDate", assignee: "assignee", priority: "priority", labels: "labels"
};
const PROVIDER_FIELD_MESSAGES: Record<string, string> = {
  summary: "Jira will not accept this summary for this issue.",
  dueDate: "Jira will not accept this due date for this issue.",
  assignee: "Jira will not assign that account to this issue.",
  priority: "Jira will not accept this priority for this issue.",
  labels: "Jira will not accept these labels for this issue."
};

function transitionMeta(item: any): TransitionMeta {
  const fields = Object.entries((item?.fields ?? {}) as Record<string, any>).map(([providerFieldId, meta]) => {
    const supported = providerFieldId === "resolution";
    return {
      id: supported ? "resolutionId" : providerFieldId,
      name: `${meta?.name ?? providerFieldId}`,
      type: `${meta?.schema?.type ?? "string"}`,
      required: Boolean(meta?.required),
      supported,
      ...(meta?.allowedValues && Array.isArray(meta.allowedValues) && supported
        ? { allowedValues: meta.allowedValues.map((value: any) => ({ id: `${value?.id}`, name: `${value?.name ?? ""}` })) } : {})
    };
  });
  return {
    id: `${item?.id}`, name: `${item?.name ?? ""}`,
    target: { name: `${item?.to?.name ?? ""}`, category: item?.to?.statusCategory?.key },
    fields
  };
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
  const { project, summary, description, assigneeAccountId, assigneeEmail, dueDate } = input;
  if (typeof project !== "string" || !/^[A-Z][A-Z0-9]{0,9}$/.test(project)) throw new Error("Invalid issue");
  if (typeof summary !== "string" || !summary.trim() || summary.length > 250) throw new Error("Invalid issue");
  if (typeof description !== "string" || description.length > 5000) throw new Error("Invalid issue");
  if (assigneeAccountId !== undefined && (typeof assigneeAccountId !== "string" || !/^[\w:.-]{1,128}$/.test(assigneeAccountId))) throw new Error("Invalid issue");
  if (assigneeEmail !== undefined && (typeof assigneeEmail !== "string" || assigneeEmail.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(assigneeEmail))) throw new Error("Invalid issue");
  if (dueDate !== undefined && (typeof dueDate !== "string" || !validDate(dueDate))) throw new Error("Invalid issue");
  return { project, summary, description, ...(assigneeAccountId ? { assigneeAccountId } : {}), ...(assigneeEmail ? { assigneeEmail } : {}), ...(dueDate ? { dueDate } : {}) };
}

/** A real calendar date in Jira's YYYY-MM-DD form; 2026-02-30 is not one. */
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

  /** Whether the person's own Jira account holds this permission, for a project or an issue. Without a Jira identity, no. */
  private async holds(user: User, permission: "CREATE_ISSUES" | "TRANSITION_ISSUES" | "EDIT_ISSUES", target: { projectKey: string } | { issueKey: string }): Promise<boolean> {
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return false;
    const email = (user.platformIdentities?.jira ?? "").trim().toLowerCase();
    const accountId = email && await this.accountId?.(email);
    if (!accountId) return false;
    const [name, value] = "projectKey" in target ? ["projectKey", target.projectKey] : ["issueKey", target.issueKey];
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/user/permission/search?accountId=${encodeURIComponent(accountId)}&permissions=${permission}&${name}=${encodeURIComponent(value)}&maxResults=10`,
      { headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (response.status === 403 || response.status === 404) return false;
    if (!response.ok) throw new Error(`Jira access check failed (${response.status})`);
    const list: unknown = await response.json();
    return Array.isArray(list) && list.some((item: any) => item?.accountId === accountId);
  }

  /** The shared connection can create in any project the admin can, so the person must be allowed to create there too. */
  canCreate(user: User, project: string): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(project) || user.active === false) return Promise.resolve(false);
    return this.holds(user, "CREATE_ISSUES", { projectKey: project });
  }

  /**
   * Moves an issue to a done status, when the person may both see it and change its status in Jira. Returns false when
   * they may not, or the workflow has no transition into done from where the issue is.
   */
  async markDone(user: User, key: string): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(key) || user.active === false) return false;
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return false;
    if (!await this.mayView(user, key, authorization, site) || !await this.holds(user, "TRANSITION_ISSUES", { issueKey: key })) return false;
    const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
    const listed = await this.transport(base, { headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!listed.ok) throw new Error(`Jira transitions failed (${listed.status})`);
    const transitions: unknown = (await listed.json() as { transitions?: unknown }).transitions;
    const done = Array.isArray(transitions) ? transitions.find((item: any) => item?.to?.statusCategory?.key === "done" && typeof item.id === "string") : undefined;
    if (!done) return false;
    const moved = await this.transport(base, { method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ transition: { id: (done as { id: string }).id } }), signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!moved.ok) throw new Error(`Jira transition failed (${moved.status})`);
    return true;
  }

  private async mayEdit(user: User, key: string): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(key) || user.active === false) return false;
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return false;
    return await this.mayView(user, key, authorization, site) && await this.holds(user, "EDIT_ISSUES", { issueKey: key });
  }

  async editFields(user: User, key: string, fields: EditFields): Promise<Record<string, unknown>> {
    if (!await this.mayEdit(user, key)) throw new CommandRejection(403, "FORBIDDEN");
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) throw new CommandRejection(403, "FORBIDDEN");
    const [assignee, summary, dueDate, priority, labels] = await Promise.all([
      fields.assignee === undefined ? undefined : fields.assignee === null ? null : await this.accountId?.(fields.assignee.toLowerCase()),
      fields.summary, fields.dueDate, fields.priority, fields.labels]);
    if (fields.assignee && typeof assignee !== "string") {
      throw new CommandRejection(422, "FIELD_VALIDATION_FAILED", { assignee: "Nobody with that Jira identity can be assigned here." });
    }
    const body = { fields: {
      ...(summary === undefined ? {} : { summary }),
      ...(dueDate === undefined ? {} : { duedate: dueDate }),
      ...(priority === undefined ? {} : { priority: { name: priority } }),
      ...(labels === undefined ? {} : { labels }),
      ...(fields.assignee === undefined ? {} : assignee === null ? { assignee: null } : { assignee: { accountId: assignee } })
    } };
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT", headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" });
    return await this.writeOutcome(response, { ...fields });
  }

  async transitionIssue(user: User, key: string, command: { transitionId: string; fields: Record<string, string> }): Promise<Record<string, unknown>> {
    if (!await this.mayEdit(user, key)) throw new CommandRejection(403, "FORBIDDEN");
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) throw new CommandRejection(403, "FORBIDDEN");
    const body = { transition: { id: command.transitionId },
      ...Object.keys(command.fields).length ? { fields: { resolution: { id: command.fields.resolutionId } } } : {} };
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" });
    return await this.writeOutcome(response, { ...command.fields });
  }

  async settleUncertainEdit(user: User, key: string, intended: Record<string, unknown>): Promise<boolean> {
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return false;
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,duedate,priority,labels,assignee`, {
      headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) return false;
    const payload = await response.json() as { fields?: Record<string, any> };
    const fields = payload.fields ?? {};
    const matches = (name: string, value: unknown): boolean => {
      if (value === undefined) return false;
      if (name === "assignee") return !value ? fields.assignee === null : fields.assignee?.accountId === value;
      if (name === "dueDate") return fields.duedate === value;
      if (name === "priority") return fields.priority?.name === value || fields.priority?.id === value;
      if (name === "labels") return Array.isArray(value) && JSON.stringify(fields.labels) === JSON.stringify(value);
      return fields[name] === value;
    };
    return intended instanceof Object && Object.entries(intended).every(([name, value]) => value === null ? fields[name] === null || fields[name] === undefined : matches(name, value));
  }

  private async writeOutcome(response: Response, accepted: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (response.ok) return { ...accepted };
    if (response.status === 403) throw new CommandRejection(403, "FORBIDDEN");
    if (response.status === 400 || response.status === 404 || response.status === 422) {
      const refusal: any = await response.json().catch(() => undefined);
      const fieldErrors: Record<string, string> = {};
      for (const field of Object.keys(refusal?.errors ?? {})) {
        const ours = PROVIDER_FIELD_IDS[field];
        if (ours) fieldErrors[ours] = PROVIDER_FIELD_MESSAGES[ours];
        else fieldErrors._base = "Jira refused this change.";
      }
      throw new CommandRejection(422, "FIELD_VALIDATION_FAILED", fieldErrors);
    }
    throw new Error(`Jira request failed (${response.status})`);
  }

  async legalTransitions(user: User, key: string): Promise<TransitionMeta[]> {
    if (user.active === false) return [];
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return [];
    if (!await this.mayView(user, key, authorization, site) || !await this.holds(user, "TRANSITION_ISSUES", { issueKey: key })) return [];
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`, {
      headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`Jira transitions failed (${response.status})`);
    const payload = await response.json() as { transitions?: unknown };
    return (Array.isArray(payload.transitions) ? payload.transitions : []).map((item: any) => transitionMeta(item));
  }


  private async request(user: User, path: string, body: unknown) {
    const [authorization, site] = await Promise.all([this.oauth.authorization("jira"), this.oauth.siteFor("jira")]);
    if (!authorization || !site) return undefined;
    const response = await this.transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/${path}`, {
      method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (!response.ok) {
      const refusal: any = response.status === 400 ? await response.json().catch(() => undefined) : undefined;
      throw new JiraRequestError(response.status, refusal?.errors && typeof refusal.errors === "object" ? Object.keys(refusal.errors) : []);
    }
    const text = await response.text();
    return { site, data: text ? JSON.parse(text) : {} };
  }

  /**
   * Creates the issue with the reviewed owner and due date when Jira will take them. An owner with no Jira account, or a
   * field Jira refuses (not on the project's create screen, owner not assignable), is left out and listed in `omitted`.
   */
  async createIssue(user: User, input: IssueInput): Promise<{ key: string; url: string; omitted: OmittedField[] } | undefined> {
    const omitted: OmittedField[] = [];
    let assignee = input.assigneeAccountId;
    if (!assignee && input.assigneeEmail) {
      assignee = await this.accountId?.(input.assigneeEmail.trim().toLowerCase()).catch(() => undefined);
      if (!assignee) omitted.push("owner");
    }
    let dueDate = input.dueDate;
    const fields = () => ({
      project: { key: input.project }, summary: input.summary, issuetype: { name: "Task" }, description: adf(`${input.description}\n\nTracked in Broppy for ${user.name}.`),
      ...(assignee ? { assignee: { accountId: assignee } } : {}), ...(dueDate ? { duedate: dueDate } : {})
    });
    let result;
    try { result = await this.request(user, "issue", { fields: fields() }); }
    catch (error) {
      // Only a refusal that names the optional fields is retried, once, without them; anything else is the caller's to report.
      if (!(error instanceof JiraRequestError) || error.status !== 400 || !error.fields.length) throw error;
      const refused = new Set(error.fields);
      if ([...refused].some(field => field !== "assignee" && field !== "duedate")) throw error;
      if (refused.has("assignee") && assignee) { assignee = undefined; omitted.push("owner"); }
      if (refused.has("duedate") && dueDate) { dueDate = undefined; omitted.push("due date"); }
      result = await this.request(user, "issue", { fields: fields() });
    }
    if (!result) return undefined;
    if (typeof result.data.key !== "string") throw new Error("Jira returned no issue key");
    return { key: result.data.key, url: `${result.site.baseUrl}/browse/${result.data.key}`, omitted };
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
