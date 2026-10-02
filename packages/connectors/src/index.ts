import documents from "../../../data/mock/documents.json" with { type: "json" };
import users from "../../../data/mock/users.json" with { type: "json" };
import type { NativePermission, Source, SourceDocument, SourcePermission, User } from "@brain/types";
import { withLinks } from "./links.js";

export { linkFromUrl, linksIn, withLinks } from "./links.js";

export type Change = {
  source: Source;
  docId: string;
  kind: "content" | "permission" | "deletion";
  cursor: number;
};

/** What a company lets the Brain import from one source.
 * `none` imports nothing, `all` everything the credential can see, and `selected` only the listed containers
 * (channels, projects, spaces, shared drives) and item IDs. A scope with no mode keeps the older meaning, where
 * empty meant all. `futureOnly` limits the import to what is new or changed after `since`, which the API fixes to the
 * moment it was chosen. */
export type ImportMode = "all" | "selected" | "none";
export interface ImportScope { mode?: ImportMode; containers?: string[]; ids?: string[]; since?: string; futureOnly?: boolean; }

/** True when the scope selects nothing, so no request to the provider is needed. */
export function selectsNothing(scope: ImportScope = {}): boolean {
  return scope.mode === "none" || (scope.mode === "selected" && !scope.containers?.length && !scope.ids?.length);
}

export interface Container { id: string; name: string; }

export interface Connector {
  discover(scope?: ImportScope): Promise<string[]>;
  /** What an admin can pick from: Slack channels, Jira projects, Confluence spaces, shared drives. */
  listContainers(): Promise<Container[]>;
  readonly source: Source;
  listItems(): Promise<SourceDocument[]>;
  listIds(): Promise<string[]>;
  listUpdatedSince(cursor: number): Promise<{ ids: string[]; cursor: number }>;
  fetchContent(id: string): Promise<string | undefined>;
  fetchDocument(id: string): Promise<SourceDocument | undefined>;
  fetchPermissions(id: string): Promise<SourcePermission | undefined>;
  getPermissions(id: string): Promise<SourcePermission | undefined>;
  checkAccess(user: User, id: string): Promise<boolean>;
  fetchVersion(id: string): Promise<number | undefined>;
  subscribe(callback: (change: Change) => void): () => void;
  subscribeToChanges(callback: (change: Change) => void): () => void;
}

export function nativeAllows(user: User, permission: SourcePermission): boolean {
  if (user.contractor && !permission.users.includes(user.email)) return false;
  const brainAllows = permission.public ||
    permission.users.includes(user.email) ||
    permission.groups.some(group => user.groups.includes(group));
  if (!brainAllows || !permission.native) return false;

  const native = permission.native;
  const email = user.platformIdentities?.[native.source];
  if (!email) return false;
  switch (native.source) {
    case "slack":
      return (!user.contractor && native.visibility === "public") || native.members.includes(email);
    case "jira":
      return native.projectViewers.includes(email) &&
        (!native.issueViewers || native.issueViewers.includes(email));
    case "confluence":
      return native.spaceViewers.includes(email) &&
        (!native.pageViewers || native.pageViewers.includes(email));
    case "drive":
      return native.owner === email || native.sharedUsers.includes(email);
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function subset(next: string[], current: string[]): boolean {
  return next.every(value => current.includes(value));
}

function restrictionSubset(next: string[] | undefined, current: string[] | undefined): boolean {
  return current === undefined || (next !== undefined && subset(next, current));
}

function nativeSubset(next: NativePermission, current: NativePermission): boolean {
  if (next.source !== current.source) return false;
  switch (current.source) {
    case "slack":
      return next.source === "slack" && next.channelId === current.channelId &&
        (current.visibility === "public" ||
          (next.visibility === "private" && subset(next.members, current.members)));
    case "jira":
      return next.source === "jira" && next.projectKey === current.projectKey &&
        subset(next.projectViewers, current.projectViewers) &&
        restrictionSubset(next.issueViewers, current.issueViewers);
    case "confluence":
      return next.source === "confluence" && next.spaceKey === current.spaceKey &&
        subset(next.spaceViewers, current.spaceViewers) &&
        restrictionSubset(next.pageViewers, current.pageViewers);
    case "drive":
      return next.source === "drive" && next.fileId === current.fileId &&
        next.owner === current.owner && subset(next.sharedUsers, current.sharedUsers);
  }
}

export class MockConnector implements Connector {
  readonly source: Source;
  private docs = new Map<string, SourceDocument>();
  private events: Change[] = [];
  private listeners = new Set<(change: Change) => void>();
  private cursor = 0;

  constructor(source: Source, seed: SourceDocument[]) {
    this.source = source;
    for (const doc of seed) {
      if (doc.source !== source) throw new Error("Source mismatch");
      if (doc.permissions.native?.source !== source) throw new Error("Native permission source mismatch");
      this.docs.set(doc.docId, copy(doc));
      this.emit(doc.docId, "content");
    }
  }

  private containerOf(doc: SourceDocument): string {
    const native = doc.permissions.native;
    return doc.metadata.space ?? doc.metadata.project ?? (native?.source === "slack" ? native.channelId :
      native?.source === "jira" ? native.projectKey : native?.source === "confluence" ? native.spaceKey : doc.sourceNativeId);
  }

  async discover(scope: ImportScope = {}): Promise<string[]> {
    if (selectsNothing(scope)) return [];
    return [...this.docs.values()].filter(doc =>
      (!scope.containers?.length || scope.containers.includes(this.containerOf(doc))) &&
      (!scope.ids?.length || scope.ids.includes(doc.sourceNativeId)) &&
      (!scope.since || doc.updatedAt >= scope.since)).map(doc => doc.docId);
  }

  async listContainers(): Promise<Container[]> {
    const names = new Map<string, string>();
    for (const doc of this.docs.values()) {
      const id = this.containerOf(doc);
      if (!names.has(id)) names.set(id, this.source === "slack" ? doc.title : id);
    }
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async listItems(): Promise<SourceDocument[]> {
    return [...this.docs.values()].map(copy);
  }

  async listIds(): Promise<string[]> {
    return [...this.docs.keys()].sort();
  }

  async listUpdatedSince(cursor: number): Promise<{ ids: string[]; cursor: number }> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Invalid cursor");
    return {
      ids: [...new Set(this.events.filter(event => event.cursor > cursor)
        .map(event => event.docId))],
      cursor: this.cursor
    };
  }

  async fetchContent(id: string): Promise<string | undefined> {
    return this.docs.get(id)?.content;
  }

  async fetchDocument(id: string): Promise<SourceDocument | undefined> {
    const doc = this.docs.get(id);
    return doc ? withLinks(copy(doc)) : undefined;
  }

  async fetchPermissions(id: string): Promise<SourcePermission | undefined> {
    const permissions = this.docs.get(id)?.permissions;
    return permissions ? copy(permissions) : undefined;
  }

  getPermissions(id: string): Promise<SourcePermission | undefined> {
    return this.fetchPermissions(id);
  }

  async checkAccess(user: User, id: string): Promise<boolean> {
    const doc = this.docs.get(id);
    return Boolean(doc && nativeAllows(user, doc.permissions));
  }

  async fetchVersion(id: string): Promise<number | undefined> {
    return this.docs.get(id)?.version;
  }

  subscribe(callback: (change: Change) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  subscribeToChanges(callback: (change: Change) => void): () => void {
    return this.subscribe(callback);
  }

  updateContent(id: string, content: string): void {
    const doc = this.require(id);
    const updated = {
      ...doc,
      content,
      version: doc.version + 1,
      updatedAt: new Date().toISOString()
    };
    this.docs.set(id, updated);
    this.emit(id, "content");
  }

  updatePermissions(id: string, permissions: SourcePermission): void {
    const doc = this.require(id);
    const native = doc.permissions.native;
    if (!native || (permissions.native && !nativeSubset(permissions.native, native))) {
      throw new Error("Native permissions may only narrow access");
    }
    this.docs.set(id, {
      ...doc,
      permissions: copy({ ...permissions, native: permissions.native ?? native })
    });
    this.emit(id, "permission");
  }

  delete(id: string): void {
    this.require(id);
    this.docs.delete(id);
    this.emit(id, "deletion");
  }

  /** A new item, as when someone creates it at the source. */
  create(doc: SourceDocument): void {
    if (doc.source !== this.source || doc.permissions.native?.source !== this.source) throw new Error("Source mismatch");
    if (this.docs.has(doc.docId)) throw new Error("Source item exists");
    this.docs.set(doc.docId, copy(doc));
    this.emit(doc.docId, "content");
  }

  /** Changes fields such as an issue's status, as a new version of the item. */
  updateMetadata(id: string, fields: Record<string, string>): void {
    const doc = this.require(id);
    this.docs.set(id, { ...doc, metadata: { ...doc.metadata, ...fields }, version: doc.version + 1,
      updatedAt: new Date().toISOString() });
    this.emit(id, "content");
  }

  private emit(docId: string, kind: Change["kind"]): void {
    const change = { source: this.source, docId, kind, cursor: this.cursor + 1 };
    this.cursor = change.cursor;
    this.events = [...this.events, change];
    for (const listener of this.listeners) listener(change);
  }

  private require(id: string): SourceDocument {
    const doc = this.docs.get(id);
    if (!doc) throw new Error("Unknown source item");
    return doc;
  }
}

// The fixture dates are written as of this moment. Loading moves them forward by the whole days since, keeping their
// spacing and times of day, so questions such as "last week" keep finding the demo data.
const FIXTURE_NOW = Date.parse("2026-09-30T00:00:00.000Z");
const DAY = 86_400_000;

export function loadMockCorpus(now = new Date()): {
  users: User[];
  connectors: Record<Source, MockConnector>;
} {
  const shift = Math.floor((now.getTime() - FIXTURE_NOW) / DAY) * DAY;
  const sourceDocs = (documents as unknown as SourceDocument[]).map(doc => ({
    ...doc,
    updatedAt: new Date(Date.parse(doc.updatedAt) + shift).toISOString()
  }));
  return {
    users: copy(users as User[]),
    connectors: {
      slack: new MockConnector("slack", sourceDocs.filter(doc => doc.source === "slack")),
      jira: new MockConnector("jira", sourceDocs.filter(doc => doc.source === "jira")),
      confluence: new MockConnector("confluence", sourceDocs.filter(doc => doc.source === "confluence")),
      drive: new MockConnector("drive", sourceDocs.filter(doc => doc.source === "drive"))
    }
  };
}
