export interface BroppyAnswer {
  text: string;
  citations: Array<{ title: string; url: string }>;
}

export interface BroppyApi {
  ask(brainUserId: string, question: string): Promise<BroppyAnswer>;
}

/**
 * Asks the Broppy API as the Slack user's own Broppy account, so the answer is only what that person may read. The API
 * checks permissions per user; this client never widens them. Sign-in here is the API's demo header (x-demo-user);
 * a deployment with Auth0 needs a per-user token exchange, which is not built yet.
 */
export class BroppyClient implements BroppyApi {
  constructor(private readonly apiUrl: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("BROPPY_API_URL must be HTTPS");
    }
  }

  async ask(brainUserId: string, question: string): Promise<BroppyAnswer> {
    const response = await this.transport(`${this.apiUrl.replace(/\/$/, "")}/v1/query`, {
      method: "POST", headers: { "content-type": "application/json", "x-demo-user": brainUserId },
      body: JSON.stringify({ question }), signal: AbortSignal.timeout(25_000), redirect: "error"
    });
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
