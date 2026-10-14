export interface BroppyAnswer {
  text: string;
  citations: Array<{ title: string; url: string }>;
}

export interface JiraIssueRequest {
  project: string;
  summary: string;
  description: string;
  assigneeAccountId?: string;
  dueDate?: string;
}

export interface BroppyApi {
  /** Creates the issue through the organization's shared Jira connection, for this person; undefined when the admin hasn't connected Jira. */
  createIssue(slackEmail: string, issue: JiraIssueRequest): Promise<{ key: string; url: string } | undefined>;
  /** Comments through the shared Jira connection, for this person; false when the admin hasn't connected Jira. */
  comment(slackEmail: string, key: string, text: string): Promise<boolean>;
  ask(slackEmail: string, question: string): Promise<BroppyAnswer>;
  actor(slackEmail: string): Promise<{ active: true }>;
  issueAccess(slackEmail: string, key: string): Promise<{ key: string; url: string; statusCategory: "new" | "indeterminate" | "done"; providerVersion: string; operationMarker?: string }>;
}

/** The API found no active Broppy user for this Slack user. */
export class NotLinkedError extends Error {}
export class JiraRefusedError extends Error {}

/**
 * Asks the Broppy API as the Slack user's own Broppy user. It sends the shared service secret and the email Slack holds for the user;
 * the API maps it through its directory and runs the question with that person's permissions, so the answer is
 * only what they may read. Slack gives no Auth0 token, which is why there is no per-user sign-in here.
 */
export class BroppyClient implements BroppyApi {
  /** orgId names the company the installation belongs to; the API checks the service secret was issued for that company. */
  constructor(private readonly apiUrl: string, private readonly serviceToken: string, private readonly transport: typeof fetch = fetch,
    private readonly orgId?: string) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("BROPPY_API_URL must be HTTPS");
    }
  }

  private post(path: string, slackEmail: string, body: unknown, timeout = 25_000): Promise<Response> {
    return this.transport(`${this.apiUrl.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-broppy-service": this.serviceToken, "x-act-as-slack-email": slackEmail,
        ...(this.orgId ? { "x-broppy-org": this.orgId } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: "error"
    });
  }

  async createIssue(slackEmail: string, issue: JiraIssueRequest) {
    const response = await this.post("/v1/service/jira/issue", slackEmail, issue, 15_000);
    if (response.status === 409) return undefined;
    if (response.status === 401) throw new NotLinkedError();
    if (!response.ok && response.status >= 400 && response.status < 500) throw new JiraRefusedError(`Broppy Jira issue refused (${response.status})`);
    if (!response.ok) throw new Error(`Broppy Jira issue failed (${response.status})`);
    const payload: any = await response.json();
    if (typeof payload.key !== "string" || typeof payload.url !== "string") throw new Error("Broppy returned no issue");
    return { key: payload.key, url: payload.url };
  }

  async comment(slackEmail: string, key: string, text: string) {
    const response = await this.post("/v1/service/jira/comment", slackEmail, { key, text }, 15_000);
    if (response.status === 409) return false;
    if (response.status === 401) throw new NotLinkedError();
    if (!response.ok) throw new Error(`Broppy Jira comment failed (${response.status})`);
    return true;
  }

  async actor(slackEmail: string): Promise<{ active: true }> {
    const response = await this.post("/v1/service/actor", slackEmail, {});
    if (response.status === 401) throw new NotLinkedError();
    if (!response.ok) throw new JiraRefusedError(`Broppy actor refused (${response.status})`);
    const payload: any = await response.json();
    if (payload.active !== true) throw new NotLinkedError();
    return { active: true };
  }

  async issueAccess(slackEmail: string, key: string) {
    const response = await this.post("/v1/service/jira/access", slackEmail, { key });
    if (response.status === 401) throw new NotLinkedError();
    if (!response.ok) throw new JiraRefusedError(`Broppy Jira access refused (${response.status})`);
    const payload: any = await response.json();
    if (payload.key !== key || typeof payload.url !== "string" || typeof payload.providerVersion !== "string" || !["new", "indeterminate", "done"].includes(payload.statusCategory)) throw new Error("Invalid Jira access result");
    return { key, url: payload.url as string, providerVersion: payload.providerVersion as string, statusCategory: payload.statusCategory as "new" | "indeterminate" | "done", ...(typeof payload.operationMarker === "string" ? { operationMarker: payload.operationMarker } : {}) };
  }

  async ask(slackEmail: string, question: string): Promise<BroppyAnswer> {
    const response = await this.post("/v1/query", slackEmail, { question });
    if (response.status === 401) throw new NotLinkedError();
    if (!response.ok) throw new Error(`Broppy query failed (${response.status})`);
    const payload: any = await response.json();
    if (typeof payload.text !== "string") throw new Error("Broppy returned no answer");
    const citations = Array.isArray(payload.citations) ? payload.citations : [];
    return {
      text: payload.text,
      citations: citations.filter((c: any) => typeof c?.title === "string" && typeof c?.url === "string")
        .map((c: any) => ({ title: c.title, url: c.url }))
    };
  }
}
