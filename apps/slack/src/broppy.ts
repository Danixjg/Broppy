export interface BroppyAnswer {
  text: string;
  citations: Array<{ title: string; url: string }>;
}

export interface BroppyApi {
  ask(slackEmail: string, question: string): Promise<BroppyAnswer>;
}

/** The API found no active Broppy user for this Slack user. */
export class NotLinkedError extends Error {}

/**
 * Asks the Broppy API as the Slack user's own Broppy user. It sends the shared service secret and the email Slack holds for the user;
 * the API maps it through its directory and runs the question with that person's permissions, so the answer is
 * only what they may read. Slack gives no Auth0 token, which is why there is no per-user sign-in here.
 */
export class BroppyClient implements BroppyApi {
  constructor(private readonly apiUrl: string, private readonly serviceToken: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("BROPPY_API_URL must be HTTPS");
    }
  }

  async ask(slackEmail: string, question: string): Promise<BroppyAnswer> {
    const response = await this.transport(`${this.apiUrl.replace(/\/$/, "")}/v1/query`, {
      method: "POST", headers: { "content-type": "application/json", "x-broppy-service": this.serviceToken, "x-act-as-slack-email": slackEmail },
      body: JSON.stringify({ question }), signal: AbortSignal.timeout(25_000), redirect: "error"
    });
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
