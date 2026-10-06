import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack signs every request: HMAC-SHA256 of `v0:<timestamp>:<raw body>`, rejecting anything older than five minutes. */
export function verifySignature(secret: string, rawBody: string, timestamp: string | undefined, signature: string | undefined,
  now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface SlackApi {
  postEphemeral(args: { channel: string; user: string; text: string; blocks?: unknown[]; thread_ts?: string }): Promise<void>;
  postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string; client_msg_id?: string }): Promise<{ ts: string } | void>;
  respond(responseUrl: string, body: Record<string, unknown>): Promise<void>;
  /** The text of one message, for the Ask Broppy shortcut. */
  history(channel: string, ts: string): Promise<string | undefined>;
  /** The email Slack holds for a user (scope users:read.email). */
  userEmail(userId: string): Promise<string | undefined>;
  permalink?(channel: string, ts: string): Promise<string>;
  openView?(triggerId: string, view: Record<string, unknown>): Promise<void>;
  members?(channel: string): Promise<string[]>;
  findMessage?(channel: string, threadTs: string, clientMsgId: string): Promise<string | undefined>;
  botUserId?(): Promise<string>;
}

export class SlackDeliveryError extends Error {}

export class SlackWebApi implements SlackApi {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch) {}

  /** Read methods such as conversations.history only accept form encoding; write methods take JSON. */
  private async call(method: string, body: Record<string, unknown>, form = false): Promise<any> {
    const response = await this.transport(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8"
      },
      body: form ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    const payload: any = await response.json();
    if (payload.ok === false && response.status < 500) throw new SlackDeliveryError(`Slack ${method} failed: ${payload?.error ?? response.status}`);
    if (!response.ok || payload.ok !== true) throw new Error(`Slack ${method} outcome is uncertain`);
    return payload;
  }

  async postEphemeral(args: Parameters<SlackApi["postEphemeral"]>[0]) { await this.call("chat.postEphemeral", args); }
  async postMessage(args: Parameters<SlackApi["postMessage"]>[0]) { const result = await this.call("chat.postMessage", args); if (typeof result.ts !== "string") throw new Error("Slack returned no message timestamp"); return { ts: result.ts }; }
  async respond(responseUrl: string, body: Record<string, unknown>) {
    const url = new URL(responseUrl);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") throw new Error("Unexpected response_url");
    const response = await this.transport(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Slack response_url failed: ${response.status}`);
  }
  async userEmail(userId: string) {
    const payload = await this.call("users.info", { user: userId }, true);
    return typeof payload.user?.profile?.email === "string" ? payload.user.profile.email : undefined;
  }
  async history(channel: string, ts: string) {
    const payload = await this.call("conversations.history", { channel, latest: ts, inclusive: true, limit: 1 }, true);
    return payload.messages?.[0]?.text;
  }
  async permalink(channel: string, ts: string) {
    const result = await this.call("chat.getPermalink", { channel, message_ts: ts }, true);
    if (typeof result.permalink !== "string") throw new Error("Slack returned no permalink");
    return result.permalink;
  }
  async openView(triggerId: string, view: Record<string, unknown>) { await this.call("views.open", { trigger_id: triggerId, view }); }
  async members(channel: string) {
    const members: string[] = []; let cursor = "";
    for (let page = 0; page < 10; page++) {
      const result = await this.call("conversations.members", { channel, limit: 100, ...(cursor ? { cursor } : {}) }, true);
      if (!Array.isArray(result.members) || result.members.some((m: unknown) => typeof m !== "string")) throw new Error("Invalid Slack membership");
      members.push(...result.members); cursor = result.response_metadata?.next_cursor ?? "";
      if (!cursor) return members;
    }
    throw new Error("Slack membership exceeds bounded policy check");
  }
  async botUserId() { const result = await this.call("auth.test", {}, true); if (typeof result.user_id !== "string") throw new Error("Slack returned no bot identity"); return result.user_id; }
  async findMessage(channel: string, threadTs: string, clientMsgId: string) {
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const result = await this.call("conversations.replies", { channel, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}) }, true);
      const found = result.messages?.find((m: any) => m.client_msg_id === clientMsgId);
      if (typeof found?.ts === "string") return found.ts;
      cursor = result.response_metadata?.next_cursor ?? "";
      if (!cursor) return undefined;
    }
    return undefined;
  }
}
