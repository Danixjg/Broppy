import { createHash } from "node:crypto";
import { MockConnector, selectsNothing, type Change, type Container, type ImportScope } from "./index.js";
import { linkFromUrl, withLinks, type LinkOrigins } from "./links.js";
import type { AuthorizationProvider, ProviderCheckpoint, SlackMessageEvidence, Source, SourceDocument, SourcePermission, User } from "@brain/types";

/** The provider refused our own credential. That says nothing about the item, so it must never read as "deleted". */
export class CredentialRejected extends Error {
  constructor(source: Source) { super(`${source} credential was rejected; reconnect the source`); }
}

/** The company holds no credential for this source: it was never connected here, which is not a failure to report. */
export class SourceNotConnected extends Error {
  constructor() { super("Source is not connected"); }
}

export class SourceAccessUnavailable extends Error {
  constructor(source: Source, cause: unknown) {
    super(`${source} access check is unavailable`, { cause });
  }
}

type SourceAccess = { kind: "allowed" } | { kind: "denied" } | { kind: "unavailable"; cause: unknown };

// A full pass every twelfth poll; and at most five requests at a time per item, to stay inside providers' rate limits.
const FULL_POLL_EVERY = 12;
const CHECKS_AT_ONCE = 5;
const slackAuthErrors = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
/** Slack answers for a channel the credential can no longer see with one of these; anything else is not "gone". */
const slackGone = new Set(["channel_not_found", "not_in_channel"]);
const transientCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const cause = (error as { cause?: { code?: string } }).cause;
  return error instanceof TypeError && (!cause?.code || transientCodes.has(cause.code));
}

export type LiveSettings = {
  ids: string[];
  serviceAuthorization: string;
  userAuthorizations: Record<string, string>;
  baseUrl?: string;
  cloudId?: string;
  discover?: boolean;
  authorization?: AuthorizationProvider;
  /** Atlassian account ID for an email, so access can be checked for someone who has not connected anything themselves. */
  atlassianAccountId?: (email: string) => Promise<string | undefined>;
  linkOrigins?: LinkOrigins;
};

type LiveConfig = Record<Source, LiveSettings>;
const sources: Source[] = ["slack", "jira", "confluence", "drive"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live source response");
  return value as Record<string, unknown>;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

// Optional fields, such as links and labels, are skipped rather than failing the item when they're malformed.
function optional(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * What Broppy keeps about an issue besides its text. The status name is for display; `statusCategory` (new, indeterminate,
 * done) is what decides whether a task is finished, since a workflow may call done "Closed" or "Released". The assignee is
 * deliberately not kept: it is Atlassian account data, which Broppy stores none of.
 */
export function jiraMetadata(fields: Record<string, unknown>): Record<string, string> {
  const status = optional(fields.status);
  const category = text(optional(status.statusCategory).key);
  const due = text(fields.duedate);
  return {
    status: text(status.name), project: text(optional(fields.project).key),
    ...(["new", "indeterminate", "done"].includes(category) ? { statusCategory: category } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(due) ? { dueDate: due } : {}),
    ...(text(optional(fields.priority).name) ? { priority: text(optional(fields.priority).name) } : {})
  };
}

function adf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  return [text(node.text), ...(Array.isArray(node.content) ? node.content.map(adf) : [])]
    .filter(Boolean).join(" ");
}

// Links in a Jira description: link marks on text, and inline, block or embedded cards.
function adfLinks(value: unknown, origins: LinkOrigins): string[] {
  const node = optional(value);
  const marks = Array.isArray(node.marks) ? node.marks.map(optional) : [];
  const urls = [text(optional(node.attrs).url), ...marks.filter(mark => mark.type === "link").map(mark => text(optional(mark.attrs).href))];
  return [...urls.filter(Boolean).map(value => linkFromUrl(value, origins)).filter((link): link is string => Boolean(link)),
    ...(Array.isArray(node.content) ? node.content.flatMap(value => adfLinks(value, origins)) : [])];
}

// Links in a Confluence page's storage format, read before the markup is stripped: hrefs and Jira issue macros.
function storageLinks(value: string, origins: LinkOrigins): string[] {
  const hrefs = [...value.matchAll(/href="([^"]+)"/g)].map(match => linkFromUrl(match[1].replace(/&amp;/g, "&"), origins));
  const keys = [...value.matchAll(/<ac:parameter ac:name="key">([A-Z][A-Z0-9]{1,9}-\d+)<\/ac:parameter>/g)]
    .map(match => `jira:${match[1]}`);
  return [...hrefs.filter((link): link is string => Boolean(link)), ...keys];
}

function plainHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function version(updatedAt: string, content: string, messages?: SlackMessageEvidence[]): number {
  const hash = createHash("sha256").update(updatedAt).update("\0").update(content);
  if (messages) hash.update(JSON.stringify(messages.map(({ permalink: _permalink, ...message }) => message)));
  return hash.digest().readUIntBE(0, 6) + 1;
}

/** A deliberately bounded live connector: configured IDs, delegated user credentials,
 * and a fresh provider request for each access check. No credential means no access. */
export class LiveConnector extends MockConnector {
  private pollCursor = 0;
  private scope: ImportScope = {};
  private origin = "";
  private seen = new Map<string, number>();
  private jiraVersions = new Map<string, string>();
  private readonly permalinks = new Map<string, string>();

  constructor(source: Source, private readonly settings: LiveSettings,
    private readonly users: readonly User[], private readonly transport: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    super(source, []);
    if (!Array.isArray(settings.ids) || !settings.ids.every(id => typeof id === "string" && id.trim()) ||
      (!settings.serviceAuthorization && !settings.authorization) || !settings.userAuthorizations ||
      typeof settings.userAuthorizations !== "object") throw new Error(`Invalid ${source} live source configuration`);
    const base = source === "slack" ? "https://slack.com" :
      source === "drive" ? "https://www.googleapis.com" : settings.baseUrl;
    // With OAuth, an Atlassian site can arrive after sign-in through useSite instead of configuration.
    if (!base && !(settings.authorization && (source === "jira" || source === "confluence"))) throw new Error(`${source} baseUrl is required`);
    if (base) this.origin = LiveConnector.httpsOrigin(source, base);
  }

  private static httpsOrigin(source: Source, base: string): string {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`${source} baseUrl must be an HTTPS origin`);
    }
    return url.origin;
  }

  /** Points an Atlassian connector at the site discovered when its owner signed in. */
  useSite(site: { baseUrl: string; cloudId: string }): void {
    if (this.source !== "jira" && this.source !== "confluence") throw new Error("Only Atlassian sources have a site");
    if (!site.cloudId) throw new Error("Atlassian site needs a cloud ID");
    this.origin = LiveConnector.httpsOrigin(this.source, site.baseUrl);
    this.settings.cloudId = site.cloudId;
  }

  /**
   * Items this company already read, loaded from storage. Another server instance did the reading, so without this a
   * fresh instance would refuse to check or refresh any of them until it ran a sync itself.
   */
  remember(docIds: readonly string[]): void {
    const prefix = `${this.source}:`;
    const known = new Set(this.settings.ids);
    for (const docId of docIds) if (docId.startsWith(prefix) && docId.length > prefix.length) known.add(docId.slice(prefix.length));
    this.settings.ids = [...known];
  }

  private nativeId(docId: string): string {
    const prefix = `${this.source}:`;
    if (!docId.startsWith(prefix) || !this.settings.ids.includes(docId.slice(prefix.length))) {
      throw new Error("Unknown source item");
    }
    return docId.slice(prefix.length);
  }

  private linkOrigins(): LinkOrigins {
    return { ...this.settings.linkOrigins,
      ...(["jira", "confluence"].includes(this.source) ? { jira: [this.origin], confluence: [this.origin] } : {}) };
  }

  private async get(path: string, authorization: string, attempt = 0, init?: { method: "POST"; body: unknown }): Promise<unknown | undefined> {
    if (!this.origin) throw new Error(`${this.source} site is not connected`);
    const requestOrigin = this.settings.cloudId ? `https://api.atlassian.com/ex/${this.source}/${encodeURIComponent(this.settings.cloudId)}` : this.origin;
    let response: Response;
    try {
      response = await this.transport(`${requestOrigin}${path}`, {
        headers: { authorization, accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
        ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
    } catch (error) {
      if (transient(error) && attempt < 3) {
        await this.sleep(250 * 2 ** attempt);
        return this.get(path, authorization, attempt + 1, init);
      }
      throw error;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const seconds = Number(response.headers.get("retry-after") ?? 2 ** attempt);
      if (!Number.isFinite(seconds) || seconds > 60) throw new Error("Source rate limited; import will resume on retry");
      await this.sleep(Math.max(1, seconds) * 1000);
      return this.get(path, authorization, attempt + 1, init);
    }
    if (response.status === 401) throw new CredentialRejected(this.source);
    if (response.status === 403) {
      // Google reports a rate limit as a 403 (userRateLimitExceeded and similar). That is not a permission answer.
      if (/rate.?limit/i.test(await response.text())) {
        if (attempt < 3) { await this.sleep(1000 * 2 ** attempt); return this.get(path, authorization, attempt + 1, init); }
        throw new Error(`${this.source} rate limited; import will resume on retry`);
      }
      return undefined;
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${this.source} source request failed (${response.status})`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return response.text();
    const body = await response.json();
    // Slack can report a rate limit inside a 200 response.
    if (this.source === "slack" && body && typeof body === "object" && (body as { error?: unknown }).error === "ratelimited") {
      if (attempt < 3) { await this.sleep(1000 * 2 ** attempt); return this.get(path, authorization, attempt + 1, init); }
      throw new Error("slack rate limited; import will resume on retry");
    }
    return body;
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
    if (selectsNothing(scope)) { this.settings.ids = []; return []; }
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

  override async listContainers(): Promise<Container[]> {
    const authorization = await this.serviceAuthorization();
    const found: Container[] = [];
    let cursor = "";
    const seen = new Set<string>();
    do {
      let path: string;
      if (this.source === "slack") path = `/api/conversations.list?limit=200&types=public_channel,private_channel&exclude_archived=true&cursor=${encodeURIComponent(cursor)}`;
      else if (this.source === "jira") path = `/rest/api/3/project/search?maxResults=100&startAt=${cursor || 0}`;
      else if (this.source === "confluence") path = cursor || "/wiki/api/v2/spaces?limit=100";
      else path = `/drive/v3/drives?pageSize=100&fields=nextPageToken,drives(id,name)&pageToken=${encodeURIComponent(cursor)}`;
      const result = object(await this.get(path, authorization));
      if (this.source === "slack" && result.ok !== true) throw new Error("Slack channel list failed");
      const items = result.channels ?? result.values ?? result.results ?? result.drives;
      if (!Array.isArray(items)) throw new Error("Invalid container list");
      for (const raw of items) {
        const item = object(raw);
        const id = text(this.source === "jira" ? item.key : item.id);
        if (id) found.push({ id, name: text(item.name) || id });
      }
      if (this.source === "jira") cursor = result.isLast === false ? String(found.length) : "";
      else if (this.source === "confluence") {
        const next = text(object(result._links ?? {}).next);
        cursor = next ? new URL(next, this.origin).pathname.replace(/^\/ex\/confluence\/[^/]+/, "") + new URL(next, this.origin).search : "";
      } else cursor = this.source === "slack" ? text(object(result.response_metadata ?? {}).next_cursor) : text(result.nextPageToken);
      if (cursor && seen.has(cursor)) throw new Error("Repeated container page");
      seen.add(cursor);
    } while (cursor);
    return found;
  }

  private async serviceAuthorization(): Promise<string> {
    const value = await this.settings.authorization?.() ?? this.settings.serviceAuthorization;
    if (!value) throw new SourceNotConnected();
    return value;
  }

  private async read(id: string, authorization: string, includePermalinks = false): Promise<{ title: string; content: string; updatedAt: string; url: string; metadata: Record<string, string>; links?: string[]; slackMessages?: SlackMessageEvidence[] } | undefined> {
    const escaped = encodeURIComponent(id);
    if (this.source === "slack") {
      const info = await this.get(`/api/conversations.info?channel=${escaped}`, authorization);
      if (!info) return undefined;
      if (object(info).ok !== true) {
        const error = text(object(info).error);
        if (slackAuthErrors.has(error)) throw new CredentialRejected("slack");
        if (slackGone.has(error)) return undefined;
        throw new Error(`Slack channel lookup failed (${error || "unknown"})`);
      }
      const channel = object(object(info).channel);
      const messages = await this.slackMessages("conversations.history", id, authorization);
      const replies: Record<string, unknown>[] = [];
      for (const message of messages) if (Number(message.reply_count) > 0) {
        replies.push(...(await this.slackMessages("conversations.replies", id, authorization, text(message.ts)))
          .map(reply => ({ ...reply, thread_ts: text(reply.thread_ts) || text(message.ts) })));
      }
      const all = [...new Map([...messages, ...replies].map(message => [text(message.ts), message])).values()]
        .filter(message => /^\d+(?:\.\d+)?$/.test(text(message.ts)) && text(message.text))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const teamId = text(channel.context_team_id) || text(channel.team_id);
      const evidence: SlackMessageEvidence[] = all.map(message => ({
        teamId, channelId: id, threadTs: text(message.thread_ts) || text(message.ts), messageTs: text(message.ts),
        authorSlackId: text(message.user), text: text(message.text),
        updatedAt: new Date(Math.max(Number(message.ts), Number(optional(message.edited).ts) || 0) * 1000).toISOString()
      }));
      if (includePermalinks) {
        for (let start = 0; start < evidence.length; start += CHECKS_AT_ONCE) {
          await Promise.all(evidence.slice(start, start + CHECKS_AT_ONCE).map(async message => {
            const cacheKey = `${teamId}:${id}:${message.messageTs}`;
            let permalink = this.permalinks.get(cacheKey);
            if (!permalink) {
              const result = optional(await this.get(`/api/chat.getPermalink?${new URLSearchParams({ channel: id, message_ts: message.messageTs })}`, authorization));
              const value = text(result.permalink);
              if (result.ok === true && /^https:\/\/[^/]+\.slack\.com\/archives\//.test(value)) {
                permalink = value;
                this.permalinks.set(cacheKey, value);
              }
            }
            if (permalink) message.permalink = permalink;
          }));
        }
      }
      const content = evidence.map(message => message.text).join("\n");
      const updatedAt = new Date(Math.max(Number(channel.created) * 1000 || 0,
        ...evidence.map(message => Date.parse(message.updatedAt)))).toISOString();
      return { title: `#${text(channel.name) || id}`, content, updatedAt,
        url: `https://app.slack.com/client/${encodeURIComponent(text(channel.context_team_id) || "")}/${escaped}`,
        metadata: { channel: text(channel.name), slackTeamId: teamId, sourceStatus: channel.is_private === true ? "private" : "public" },
        slackMessages: evidence };
    }
    if (this.source === "jira") {
      const result = await this.get(`/rest/api/3/issue/${escaped}?fields=summary,description,updated,status,project,issuelinks,duedate,priority`, authorization);
      if (!result) return undefined;
      const issue = object(result); const fields = object(issue.fields);
      const updatedAt = text(fields.updated);
      // Issue links name the other issue by key; links in the description point anywhere.
      const issueLinks = (Array.isArray(fields.issuelinks) ? fields.issuelinks : []).map(link => {
        const entry = optional(link);
        return text(optional(entry.outwardIssue ?? entry.inwardIssue).key);
      }).filter(key => /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)).map(key => `jira:${key}`);
      return { title: text(fields.summary) || id, content: adf(fields.description), updatedAt,
        url: `${this.origin}/browse/${escaped}`, metadata: jiraMetadata(fields),
        links: [...issueLinks, ...adfLinks(fields.description, this.linkOrigins())] };
    }
    if (this.source === "confluence") {
      const result = await this.get(`/wiki/api/v2/pages/${escaped}?body-format=storage&include-labels=true`, authorization);
      if (!result) return undefined;
      const page = object(result); const body = object(page.body ?? {});
      const storage = object(body.storage ?? {});
      const changed = object(page.version ?? {});
      // A trashed, archived or draft page can still be fetched by ID; it is not something to answer from.
      if (text(page.status) && text(page.status) !== "current") return undefined;
      // A page labelled "master" is a project's source of truth.
      const labels = optional(page.labels).results;
      const master = Array.isArray(labels) && labels.some(label => text(optional(label).name).toLowerCase() === "master");
      return { title: text(page.title) || id, content: plainHtml(text(storage.value)),
        updatedAt: text(changed.createdAt), url: `${this.origin}/wiki/pages/viewpage.action?pageId=${escaped}`,
        metadata: { status: text(page.status), space: text(page.spaceId), ...(master ? { label: "master" } : {}) },
        links: storageLinks(text(storage.value), this.linkOrigins()) };
    }
    const metadata = await this.get(`/drive/v3/files/${escaped}?fields=id,name,mimeType,modifiedTime,webViewLink,trashed&supportsAllDrives=true`, authorization);
    if (!metadata) return undefined;
    const file = object(metadata); const mime = text(file.mimeType);
    if (file.trashed === true) return undefined;
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
  /** Only items whose version moved since the last poll, except on the first poll and every twelfth, which report every
   * item. A share or restriction changes no version, so that full pass is what brings permission changes into the index
   * (within an hour at five-minute polls); every answer still rechecks access at the source. Removed items are found by
   * sync's ID pass. */
  override async listUpdatedSince(cursor: number, checkpoint?: ProviderCheckpoint): Promise<{ ids: string[]; cursor: number; checkpoint?: ProviderCheckpoint }> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Invalid cursor");
    this.pollCursor = cursor + 1;
    const ids = await this.listIds();
    if (this.source === "jira") {
      const previous = checkpoint?.source === "jira" ? new Map(Object.entries(checkpoint.observedVersions)) : this.jiraVersions;
      const reconcile = cursor === 0 || this.pollCursor % FULL_POLL_EVERY === 0;
      const next = new Map<string, string>();
      const changed = new Set<string>();
      const authorization = await this.serviceAuthorization();
      for (let i = 0; i < ids.length; i += CHECKS_AT_ONCE) {
        await Promise.all(ids.slice(i, i + CHECKS_AT_ONCE).map(async docId => {
          const result = await this.get(`/rest/api/3/issue/${encodeURIComponent(this.nativeId(docId))}?fields=updated`, authorization);
          if (!result) { changed.add(docId); return; }
          const updated = text(optional(object(result).fields).updated);
          if (!Number.isFinite(Date.parse(updated))) throw new Error("Invalid Jira change metadata");
          next.set(docId, updated);
          if (reconcile || previous.get(docId) !== updated) changed.add(docId);
        }));
      }
      this.jiraVersions = next;
      return { ids: ids.filter(id => changed.has(id)), cursor: this.pollCursor,
        checkpoint: { source: "jira", observedVersions: Object.fromEntries(next) } };
    }
    const previous = cursor === 0 || this.pollCursor % FULL_POLL_EVERY === 0 ? new Map<string, number>() : this.seen;
    const next = new Map<string, number>();
    const changed: string[] = [];
    for (let i = 0; i < ids.length; i += CHECKS_AT_ONCE) {
      await Promise.all(ids.slice(i, i + CHECKS_AT_ONCE).map(async id => {
        const current = await this.fetchVersion(id);
        if (current !== undefined) next.set(id, current);
        // An unreadable item is reported too, so sync can tombstone it or fail loudly.
        if (current === undefined || previous.get(id) !== current) changed.push(id);
      }));
    }
    this.seen = next;
    return { ids: ids.filter(id => changed.includes(id)), cursor: this.pollCursor };
  }
  override async listItems(): Promise<SourceDocument[]> {
    return (await Promise.all((await this.listIds()).map(id => this.fetchDocument(id))))
      .filter((doc): doc is SourceDocument => Boolean(doc));
  }
  override async fetchDocument(docId: string): Promise<SourceDocument | undefined> {
    const id = this.nativeId(docId);
    const read = await this.read(id, await this.serviceAuthorization(), true);
    if (!read || (this.source !== "slack" && this.scope.since && read.updatedAt < this.scope.since)) return undefined;
    const permissions = await this.fetchPermissions(docId);
    if (!permissions?.users.length) return undefined;
    const content = read.content.trim();
    if (!content || !read.updatedAt || !Number.isFinite(Date.parse(read.updatedAt))) return undefined;
    return withLinks({ docId, source: this.source, sourceNativeId: id, title: read.title,
      content, url: read.url, updatedAt: read.updatedAt, version: version(read.updatedAt, content, read.slackMessages),
      metadata: read.metadata, permissions, tier: "internal", links: read.links ?? [],
      ...(read.slackMessages ? { slackMessages: read.slackMessages } : {}) }, this.linkOrigins());
  }
  override async fetchContent(docId: string): Promise<string | undefined> {
    return (await this.fetchDocument(docId))?.content;
  }
  override async fetchVersion(docId: string): Promise<number | undefined> {
    const read = await this.read(this.nativeId(docId), await this.serviceAuthorization());
    return read?.updatedAt ? version(read.updatedAt, read.content.trim(), read.slackMessages) : undefined;
  }
  override async fetchPermissions(docId: string): Promise<SourcePermission | undefined> {
    const id = this.nativeId(docId);
    const allowed: string[] = [];
    // The policy compares a person's account at this source, which is their work email unless the admin set another.
    const accounts: string[] = [];
    for (let i = 0; i < this.users.length; i += CHECKS_AT_ONCE) {
      const batch = this.users.slice(i, i + CHECKS_AT_ONCE);
      const checks = await Promise.all(batch.map(user => this.access(user, docId)));
      const unavailable = checks.find(check => check.kind === "unavailable");
      if (unavailable?.kind === "unavailable") throw new SourceAccessUnavailable(this.source, unavailable.cause);
      const passed = batch.filter((_, index) => checks[index].kind === "allowed");
      allowed.push(...passed.map(user => user.email));
      accounts.push(...passed.map(user => user.platformIdentities?.[this.source] ?? user.email));
    }
    const native: SourcePermission["native"] = this.source === "slack"
      ? { source: "slack", channelId: id, visibility: "private", members: accounts }
      : this.source === "jira"
        ? { source: "jira", projectKey: id.split("-")[0], projectViewers: accounts, issueViewers: accounts }
        : this.source === "confluence"
          ? { source: "confluence", spaceKey: id, spaceViewers: accounts, pageViewers: accounts }
          : { source: "drive", fileId: id, owner: "", sharedUsers: accounts };
    return { users: allowed, groups: [], public: false, native };
  }
  override getPermissions(docId: string): Promise<SourcePermission | undefined> { return this.fetchPermissions(docId); }
  /**
   * Whether the source knows this email, so a mismatch shows when someone is added and not as an answer that is
   * quietly empty. Drive has no such lookup: a share names an email, and either it is the person's or it isn't.
   */
  async lookupIdentity(identity: string): Promise<"found" | "not_found" | "not_connected" | "unavailable" | "not_checked"> {
    const email = identity.trim().toLowerCase();
    if (this.source === "drive" || (this.source !== "slack" && !this.settings.atlassianAccountId)) return "not_checked";
    try {
      const authorization = this.settings.authorization ? await this.settings.authorization() : undefined;
      if (!authorization) return "not_connected";
      if (this.source === "slack") {
        const found = optional(await this.get(`/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, authorization));
        if (found.ok === true) return text(optional(found.user).id) ? "found" : "not_found";
        return text(found.error) === "users_not_found" ? "not_found" : "unavailable";
      }
      return await this.settings.atlassianAccountId!(email) ? "found" : "not_found";
    } catch { return "unavailable"; }
  }

  override async checkAccess(user: User, docId: string): Promise<boolean> {
    const result = await this.access(user, docId);
    if (result.kind === "unavailable") throw new SourceAccessUnavailable(this.source, result.cause);
    return result.kind === "allowed";
  }

  private async access(user: User, docId: string): Promise<SourceAccess> {
    const id = this.nativeId(docId);
    if (!user.platformIdentities?.[this.source] || user.active === false) return { kind: "denied" };
    try {
      // With a shared connection nobody but the admin has a token of their own, so the source is asked who may see the item.
      if (this.settings.authorization) {
        const authorization = await this.settings.authorization();
        if (!authorization) return { kind: "denied" };
        return { kind: await this.canView(user, id, authorization) ? "allowed" : "denied" };
      }
      const authorization = this.settings.userAuthorizations[user.id];
      if (!authorization) return { kind: "denied" };
      return { kind: await this.read(id, authorization) ? "allowed" : "denied" };
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
  }

  private readonly lists = new Map<string, { at: number; value: unknown }>();
  /** A source's answer reused for a short while, so checking many people against one item asks the source once. */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.lists.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.value as T;
    const value = await load();
    this.lists.set(key, { at: Date.now(), value });
    if (this.lists.size > 500) this.lists.delete(this.lists.keys().next().value!);
    return value;
  }

  /** Whether this person may see the item at the source, read with the shared connection. Anything unclear is a no. */
  private async canView(user: User, id: string, authorization: string): Promise<boolean> {
    const email = user.platformIdentities![this.source]!.trim().toLowerCase();
    const escaped = encodeURIComponent(id);
    if (this.source === "slack") {
      const found = optional(await this.get(`/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, authorization));
      if (found.ok !== true) {
        if (text(found.error) === "users_not_found") return false;
        if (slackAuthErrors.has(text(found.error))) throw new CredentialRejected("slack");
        throw new Error(`Slack user lookup failed (${text(found.error) || "unknown"})`);
      }
      const slackId = text(optional(found.user).id);
      if (!slackId) return false;
      const info = optional(await this.get(`/api/conversations.info?channel=${escaped}`, authorization));
      if (info.ok !== true) {
        if (slackAuthErrors.has(text(info.error))) throw new CredentialRejected("slack");
        if (slackGone.has(text(info.error))) return false;
        throw new Error(`Slack channel lookup failed (${text(info.error) || "unknown"})`);
      }
      if (optional(info.channel).is_private !== true) return true;
      const members = await this.cached(`slack-members:${id}`, async () => {
        const ids = new Set<string>(); let cursor = "";
        do {
          const page = optional(await this.get(`/api/conversations.members?channel=${escaped}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, authorization));
          if (page.ok !== true) throw new Error(`Slack member list failed (${text(page.error) || "unknown"})`);
          for (const member of Array.isArray(page.members) ? page.members : []) ids.add(text(member));
          cursor = text(optional(page.response_metadata).next_cursor);
        } while (cursor);
        return ids;
      });
      return members.has(slackId);
    }
    if (this.source === "drive") {
      const grants = await this.cached(`drive-permissions:${id}`, async () => {
        const all: Record<string, unknown>[] = []; let token = "";
        do {
          const page = await this.get(`/drive/v3/files/${escaped}/permissions?supportsAllDrives=true&pageSize=100&fields=${encodeURIComponent("nextPageToken,permissions(type,role,emailAddress,domain)")}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, authorization);
          if (!page) return [];
          const body = object(page);
          all.push(...(Array.isArray(body.permissions) ? body.permissions.map(optional) : []));
          token = text(body.nextPageToken);
        } while (token);
        return all;
      });
      // Group shares are not expanded, so someone who is only in a group that has the file is not shown it.
      return grants.some(grant => grant.type === "anyone" || (grant.type === "user" && text(grant.emailAddress).toLowerCase() === email) ||
        (grant.type === "domain" && email.endsWith(`@${text(grant.domain).toLowerCase()}`)));
    }
    const accountId = await this.settings.atlassianAccountId?.(email);
    if (!accountId) return false;
    if (this.source === "jira") {
      // Jira answers for the issue itself, so project roles and issue security levels both count.
      const result = await this.get(`/rest/api/3/user/permission/search?accountId=${encodeURIComponent(accountId)}&permissions=BROWSE_PROJECTS&issueKey=${escaped}&maxResults=10`, authorization);
      return Array.isArray(result) && result.some(item => optional(item).accountId === accountId);
    }
    const result = await this.get(`/wiki/rest/api/content/${escaped}/permission/check`, authorization, 0,
      { method: "POST", body: { subject: { type: "user", identifier: accountId }, operation: "read" } });
    return optional(result).hasPermission === true;
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
  const linkOrigins: LinkOrigins = { jira: config.jira.baseUrl ? [config.jira.baseUrl] : [],
    confluence: config.confluence.baseUrl ? [config.confluence.baseUrl] : [], slack: config.slack.linkOrigins?.slack ?? [] };
  return {
    slack: new LiveConnector("slack", { ...config.slack, linkOrigins }, users),
    jira: new LiveConnector("jira", { ...config.jira, linkOrigins }, users),
    confluence: new LiveConnector("confluence", { ...config.confluence, linkOrigins }, users),
    drive: new LiveConnector("drive", { ...config.drive, linkOrigins }, users)
  };
}
