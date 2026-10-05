export interface JiraIssueInput {
  project: string;
  summary: string;
  description: string;
  assigneeAccountId?: string;
  /** YYYY-MM-DD */
  dueDate?: string;
}

export interface JiraApi {
  createIssue(input: JiraIssueInput): Promise<{ key: string; url: string }>;
  addComment(key: string, text: string): Promise<void>;
}

const doc = (text: string) => ({
  type: "doc", version: 1,
  content: text.split("\n\n").map(paragraph => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] }))
});

/** Jira Cloud REST v3 with an API token (basic auth: account email and token). */
export class JiraClient implements JiraApi {
  constructor(private readonly baseUrl: string, private readonly email: string, private readonly token: string,
    private readonly transport: typeof fetch = fetch) {
    if (new URL(baseUrl).protocol !== "https:") throw new Error("JIRA_BASE_URL must be HTTPS");
  }

  private async request(path: string, body: unknown): Promise<any> {
    const response = await this.transport(`${this.baseUrl.replace(/\/$/, "")}/rest/api/3/${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}`,
        "content-type": "application/json", accept: "application/json"
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Jira ${path.split("/").slice(0, 2).join("/")} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async createIssue(input: JiraIssueInput) {
    const created = await this.request("issue", {
      fields: {
        project: { key: input.project }, summary: input.summary.slice(0, 250), issuetype: { name: "Task" },
        description: doc(input.description),
        ...(input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
        ...(input.dueDate ? { duedate: input.dueDate } : {})
      }
    });
    if (typeof created.key !== "string") throw new Error("Jira returned no issue key");
    return { key: created.key, url: `${this.baseUrl.replace(/\/$/, "")}/browse/${created.key}` };
  }

  async addComment(key: string, text: string) {
    await this.request(`issue/${encodeURIComponent(key)}/comment`, { body: doc(text) });
  }
}
