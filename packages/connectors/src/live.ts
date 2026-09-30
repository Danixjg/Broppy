import { createHash } from "node:crypto";
import { MockConnector, type Change, type ImportScope } from "./index.js";
import type { Source, SourceDocument, SourcePermission, User } from "@brain/types";

export type LiveSettings = {
  ids: string[];
  serviceAuthorization: string;
  userAuthorizations: Record<string, string>;
  baseUrl?: string;
  cloudId?: string;
  discover?: boolean;
  authorization?: (userId?: string) => Promise<string | undefined>;
};

type LiveConfig = Record<Source, LiveSettings>;
const sources: Source[] = ["slack", "jira", "confluence", "drive"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live source response");
  return value as Record<string, unknown>;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function adf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  return [text(node.text), ...(Array.isArray(node.content) ? node.content.map(adf) : [])]
    .filter(Boolean).join(" ");
}

function plainHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function version(updatedAt: string, content: string): number {
  const digest = createHash("sha256").update(updatedAt).update("\0").update(content).digest();
  return digest.readUIntBE(0, 6) + 1;
}

/** A deliberately bounded live connector: configured IDs, delegated user credentials,
 * and a fresh provider request for each access check. No credential means no access. */
export class LiveConnector extends MockConnector {
  private pollCursor = 0;
  private scope: ImportScope = {};
  private readonly origin: string;

  constructor(source: Source, private readonly settings: LiveSettings,
    private readonly users: readonly User[], private readonly transport: typeof fetch = fetch) {
    super(source, []);
    if (!Array.isArray(settings.ids) || !settings.ids.every(id => typeof id === "string" && id.trim()) ||
      (!settings.serviceAuthorization && !settings.authorization) || !settings.userAuthorizations ||
      typeof settings.userAuthorizations !== "object") throw new Error(`Invalid ${source} live source configuration`);
    const base = source === "slack" ? "https://slack.com" :
      source === "drive" ? "https://www.googleapis.com" : settings.baseUrl;
    if (!base) throw new Error(`${source} baseUrl is required`);
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`${source} baseUrl must be an HTTPS origin`);
    }
    this.origin = url.origin;
  }

  private nativeId(docId: string): string {
    const prefix = `${this.source}:`;
    if (!docId.startsWith(prefix) || !this.settings.ids.includes(docId.slice(prefix.length))) {
      throw new Error("Unknown source item");
    }
    return docId.slice(prefix.length);
  }

  private async get(path: string, authorization: string, attempt = 0): Promise<unknown | undefined> {
    const requestOrigin = this.settings.cloudId ? `https://api.atlassian.com/ex/${this.source}/${encodeURIComponent(this.settings.cloudId)}` : this.origin;
    const response = await this.transport(`${requestOrigin}${path}`, {
      headers: { authorization, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(5000)
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const seconds = Number(response.headers.get("retry-after") ?? 2 ** attempt);
      if (!Number.isFinite(seconds) || seconds > 60) throw new Error("Source rate limited; import will resume on retry");
      await new Promise(resolve => setTimeout(resolve, Math.max(1, seconds) * 1000));
      return this.get(path, authorization, attempt + 1);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${this.source} source request failed (${response.status})`);
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? response.json() : response.text();
  }

  private async slackMessages(method: string, channel: string, authorization: string, ts?: string): Promise<Record<string, unknown>[]> {
    let cursor = "";
    const messages: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ channel, limit: "100", ...(cursor ? { cursor } : {}),
        ...(ts ? { ts } : {}), ...(this.scope.since ? { oldest: String(Date.parse(this.scope.since) / 1000) } : {}) });
      const page = object(await this.get(`/api/${method}?${params}`, authorization));
      if (page.ok !== true || !Array.isArray(page.messages)) throw new Error("Slack history unavailable");
      messages.push(...page.messages.map(object));
      cursor = text(object(page.response_metadata ?? {}).next_cursor);
      if (cursor && seen.has(cursor)) throw new Error("Repeated Slack page");
      seen.add(cursor);
    } while (cursor);
    return messages;
  }

  override async discover(scope: ImportScope = {}): Promise<string[]> {
    this.scope = scope;
    if (!this.settings.discover) return (await this.listIds()).filter(id => !scope.ids?.length || scope.ids.includes(id.split(":").slice(1).join(":")));
    if ((scope.containers?.length ?? 0) > 1) {
      const found: string[] = [];
      for (const container of scope.containers!) found.push(...await this.discover({ ...scope, containers: [container] }));
      this.scope = scope;
      this.settings.ids = [...new Set(found)].map(id => id.slice(this.source.length + 1));
      return [...new Set(found)];
    }
    const container = scope.containers?.[0];
    const ids: string[] = [];
    let cursor = "";
    const seen = new Set<string>();
    do {
      let path: string;
      if (this.source === "slack") path = `/api/conversations.list?limit=200&types=public_channel,private_channel&exclude_archived=false&cursor=${encodeURIComponent(cursor)}`;
      else if (this.source === "jira") path = `/rest/api/3/search/jql?maxResults=100&fields=key&jql=${encodeURIComponent(container ? `project = ${JSON.stringify(container)}` : "created IS NOT EMPTY")}&nextPageToken=${encodeURIComponent(cursor)}`;
      else if (this.source === "confluence") path = cursor || (container ? `/wiki/api/v2/spaces/${encodeURIComponent(container)}/pages?limit=100` : "/wiki/api/v2/pages?limit=100");
      else path = `/drive/v3/files?pageSize=1000&fields=nextPageToken,files(id)&q=trashed%3Dfalse&includeItemsFromAllDrives=true&supportsAllDrives=true&pageToken=${encodeURIComponent(cursor)}${container ? `&corpora=drive&driveId=${encodeURIComponent(container)}` : ""}`;
      const result = object(await this.get(path, await this.serviceAuthorization()));
      if (this.source === "slack" && result.ok !== true) throw new Error("Slack discovery failed");
      const items = result.channels ?? result.issues ?? result.results ?? result.files;
      if (!Array.isArray(items)) throw new Error("Invalid discovery page");
      ids.push(...items.map(item => text(object(item)[this.source === "jira" ? "key" : "id"])).filter(Boolean));
      cursor = this.source === "slack" ? text(object(result.response_metadata ?? {}).next_cursor) :
        this.source === "jira" ? text(result.nextPageToken) : this.source === "drive" ? text(result.nextPageToken) : text(object(result._links ?? {}).next);
      if (this.source === "confluence" && cursor) {
        const next = new URL(cursor, this.origin);
        const apiPrefix = `/ex/confluence/${encodeURIComponent(this.settings.cloudId ?? "")}`;
        if (this.settings.cloudId && next.origin === "https://api.atlassian.com" && next.pathname.startsWith(apiPrefix + "/wiki/api/v2/")) cursor = next.pathname.slice(apiPrefix.length) + next.search;
        else {
          if (next.origin !== this.origin || !next.pathname.startsWith("/wiki/api/v2/")) throw new Error("Invalid discovery link");
          cursor = next.pathname + next.search;
        }
      }
      if (cursor && seen.has(cursor)) throw new Error("Repeated discovery page");
      seen.add(cursor);
    } while (cursor);
    const selected = [...new Set(ids)].filter(id => (!scope.ids?.length || scope.ids.includes(id)) && (this.source !== "slack" || !container || id === container));
    this.settings.ids = selected;
    return selected.map(id => `${this.source}:${id}`);
  }

  private async serviceAuthorization(): Promise<string> {
    const value = await this.settings.authorization?.() ?? this.settings.serviceAuthorization;
    if (!value) throw new Error("Source is not connected");
    return value;
  }

  private async read(id: string, authorization: string): Promise<{ title: string; content: string; updatedAt: string; url: string; metadata: Record<string, string> } | undefined> {
    const escaped = encodeURIComponent(id);
    if (this.source === "slack") {
      const info = await this.get(`/api/conversations.info?channel=${escaped}`, authorization);
      if (!info || object(info).ok !== true) return undefined;
      const channel = object(object(info).channel);
      const messages = await this.slackMessages("conversations.history", id, authorization);
      const replies: Record<string, unknown>[] = [];
      for (const message of messages) if (Number(message.reply_count) > 0) {
        replies.push(...await this.slackMessages("conversations.replies", id, authorization, text(message.ts)));
      }
      const all = [...new Map([...messages, ...replies].map(message => [text(message.ts), message])).values()];
      const content = all.map(item => text(object(item).text)).filter(Boolean).join("\n");
      const updatedAt = new Date(Number(text(object(messages[0] ?? {}).ts) || 0) * 1000 ||
        Number(channel.created) * 1000 || Date.now()).toISOString();
      return { title: `#${text(channel.name) || id}`, content, updatedAt,
        url: `https://app.slack.com/client/${encodeURIComponent(text(channel.context_team_id) || "")}/${escaped}`,
        metadata: { channel: text(channel.name), sourceStatus: channel.is_private === true ? "private" : "public" } };
    }
    if (this.source === "jira") {
      const result = await this.get(`/rest/api/3/issue/${escaped}?fields=summary,description,updated,status,project`, authorization);
      if (!result) return undefined;
      const issue = object(result); const fields = object(issue.fields);
      const updatedAt = text(fields.updated);
      return { title: text(fields.summary) || id, content: adf(fields.description), updatedAt,
        url: `${this.origin}/browse/${escaped}`, metadata: { status: text(object(fields.status ?? {}).name), project: text(object(fields.project ?? {}).key) } };
    }
    if (this.source === "confluence") {
      const result = await this.get(`/wiki/api/v2/pages/${escaped}?body-format=storage`, authorization);
      if (!result) return undefined;
      const page = object(result); const body = object(page.body ?? {});
      const storage = object(body.storage ?? {});
      const changed = object(page.version ?? {});
      return { title: text(page.title) || id, content: plainHtml(text(storage.value)),
        updatedAt: text(changed.createdAt), url: `${this.origin}/wiki/pages/viewpage.action?pageId=${escaped}`,
        metadata: { status: text(page.status), space: text(page.spaceId) } };
    }
    const metadata = await this.get(`/drive/v3/files/${escaped}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`, authorization);
    if (!metadata) return undefined;
    const file = object(metadata); const mime = text(file.mimeType);
    let content: unknown;
    if (mime === "application/vnd.google-apps.document") {
      content = await this.get(`/drive/v3/files/${escaped}/export?mimeType=text%2Fplain`, authorization);
    } else if (mime.startsWith("text/")) {
      content = await this.get(`/drive/v3/files/${escaped}?alt=media`, authorization);
    } else {
      // Unsupported binary formats are never indexed as accidental JSON/text.
      return undefined;
    }
    if (typeof content !== "string") throw new Error("Drive returned non-text content");
    return { title: text(file.name) || id, content, updatedAt: text(file.modifiedTime),
      url: text(file.webViewLink) || `${this.origin}/drive/u/0/my-drive`, metadata: { mimeType: mime } };
  }

  override async listIds(): Promise<string[]> { return this.settings.ids.map(id => `${this.source}:${id}`); }
  override async listUpdatedSince(_cursor: number): Promise<{ ids: string[]; cursor: number }> {
    this.pollCursor++;
    return { ids: await this.listIds(), cursor: this.pollCursor };
  }
  override async listItems(): Promise<SourceDocument[]> {
    return (await Promise.all((await this.listIds()).map(id => this.fetchDocument(id))))
      .filter((doc): doc is SourceDocument => Boolean(doc));
  }
  override async fetchDocument(docId: string): Promise<SourceDocument | undefined> {
    const id = this.nativeId(docId);
    const read = await this.read(id, await this.serviceAuthorization());
    if (!read || (this.source !== "slack" && this.scope.since && read.updatedAt < this.scope.since)) return undefined;
    const permissions = await this.fetchPermissions(docId);
    if (!permissions?.users.length) return undefined;
    const content = read.content.trim();
    if (!content || !read.updatedAt || !Number.isFinite(Date.parse(read.updatedAt))) return undefined;
    return { docId, source: this.source, sourceNativeId: id, title: read.title,
      content, url: read.url, updatedAt: read.updatedAt, version: version(read.updatedAt, content),
      metadata: read.metadata, permissions, tier: "internal" };
  }
  override async fetchContent(docId: string): Promise<string | undefined> {
    return (await this.fetchDocument(docId))?.content;
  }
  override async fetchVersion(docId: string): Promise<number | undefined> {
    const read = await this.read(this.nativeId(docId), await this.serviceAuthorization());
    return read?.updatedAt ? version(read.updatedAt, read.content.trim()) : undefined;
  }
  override async fetchPermissions(docId: string): Promise<SourcePermission | undefined> {
    const id = this.nativeId(docId);
    const allowed: string[] = [];
    for (const user of this.users) {
      if (await this.checkAccess(user, docId)) allowed.push(user.email);
    }
    const native: SourcePermission["native"] = this.source === "slack"
      ? { source: "slack", channelId: id, visibility: "private", members: allowed }
      : this.source === "jira"
        ? { source: "jira", projectKey: id.split("-")[0], projectViewers: allowed, issueViewers: allowed }
        : this.source === "confluence"
          ? { source: "confluence", spaceKey: id, spaceViewers: allowed, pageViewers: allowed }
          : { source: "drive", fileId: id, owner: "", sharedUsers: allowed };
    return { users: allowed, groups: [], public: false, native };
  }
  override getPermissions(docId: string): Promise<SourcePermission | undefined> { return this.fetchPermissions(docId); }
  override async checkAccess(user: User, docId: string): Promise<boolean> {
    const authorization = await this.settings.authorization?.(user.id) ?? this.settings.userAuthorizations[user.id];
    if (!user.platformIdentities?.[this.source] || !authorization || user.active === false) return false;
    const id = this.nativeId(docId);
    // Every check uses the user's delegated credential against the live source.
    try { return Boolean(await this.read(id, authorization)); }
    catch { return false; }
  }
  override subscribe(_callback: (change: Change) => void): () => void { return () => undefined; }
  override subscribeToChanges(callback: (change: Change) => void): () => void { return this.subscribe(callback); }
}

export function liveConnectorsFromEnv(users: readonly User[], env: NodeJS.ProcessEnv = process.env): Record<Source, MockConnector> | undefined {
  if (!env.LIVE_SOURCES_JSON) return undefined;
  const config = JSON.parse(env.LIVE_SOURCES_JSON) as LiveConfig;
  if (!config || typeof config !== "object" || sources.some(source => !config[source])) {
    throw new Error("LIVE_SOURCES_JSON must configure all four sources");
  }
  return {
    slack: new LiveConnector("slack", config.slack, users),
    jira: new LiveConnector("jira", config.jira, users),
    confluence: new LiveConnector("confluence", config.confluence, users),
    drive: new LiveConnector("drive", config.drive, users)
  };
}
