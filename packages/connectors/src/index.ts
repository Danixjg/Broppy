import generatedDocuments from "../../../data/generated/documents.json" with { type: "json" };
import generatedGroups from "../../../data/generated/persona-groups.json" with { type: "json" };
import documents from "../../../data/mock/documents.json" with { type: "json" };
import users from "../../../data/mock/users.json" with { type: "json" };
import type { NativePermission, ProviderCheckpoint, Source, SourceDocument, SourcePermission, User } from "@brain/types";
import { core } from "@brain/rust-core";
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
  return core<boolean>("policy.selectsNothing", { scope });
}

export interface Container { id: string; name: string; }

export interface Connector {
  discover(scope?: ImportScope): Promise<string[]>;
  /** What an admin can pick from: Slack channels, Jira projects, Confluence spaces, shared drives. */
  listContainers(): Promise<Container[]>;
  readonly source: Source;
  listItems(): Promise<SourceDocument[]>;
  listIds(): Promise<string[]>;
  listUpdatedSince(cursor: number, checkpoint?: ProviderCheckpoint): Promise<{ ids: string[]; cursor: number; checkpoint?: ProviderCheckpoint }>;
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
  return core<boolean>("policy.nativeAllows", { user, permission });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function nativeSubset(next: NativePermission, current: NativePermission): boolean {
  return core<boolean>("policy.nativeSubset", { next, current });
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

  async listUpdatedSince(cursor: number, _checkpoint?: ProviderCheckpoint): Promise<{ ids: string[]; cursor: number; checkpoint?: ProviderCheckpoint }> {
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
    this.updateDocument(id, { metadata: fields });
  }

  /** One provider-side write: top-level fields and metadata together, one version bump. */
  updateDocument(id: string, patch: { metadata?: Record<string, string>; title?: string; description?: string }): void {
    const doc = this.require(id);
    this.docs.set(id, { ...doc, ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      metadata: { ...doc.metadata, ...(patch.metadata ?? {}) },
      version: doc.version + 1, updatedAt: new Date().toISOString() });
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

/** A generated company held in memory, such as the brief's scale, with the extra groups its six people belong to. */
export interface GeneratedItems {
  documents: SourceDocument[];
  personaGroups: Record<string, string[]>;
}

/**
 * The demo company. By default, the 28 hand-written items the scenarios and tests use. With `generated`, the generated
 * company (`pnpm dataset`) joins them: about 500 more items, and the extra groups its six people belong to there. A
 * company generated in memory joins them the same way.
 */
export function loadMockCorpus(now = new Date(), options: { generated?: boolean | GeneratedItems } = {}): {
  users: User[];
  connectors: Record<Source, MockConnector>;
} {
  const shift = Math.floor((now.getTime() - FIXTURE_NOW) / DAY) * DAY;
  const handWritten = documents as unknown as SourceDocument[];
  const generated: GeneratedItems | undefined = options.generated === true
    ? { documents: generatedDocuments as unknown as SourceDocument[], personaGroups: generatedGroups }
    : options.generated || undefined;
  const extra = generated?.documents ?? [];
  const ids = new Set(handWritten.map(doc => doc.docId));
  for (const doc of extra) if (ids.has(doc.docId)) throw new Error(`Generated item ${doc.docId} has a hand-written item's id`);
  const sourceDocs = [...handWritten, ...extra].map(doc => ({
    ...doc,
    updatedAt: new Date(Date.parse(doc.updatedAt) + shift).toISOString()
  }));
  const groups = generated?.personaGroups ?? {};
  return {
    users: copy(users as User[]).map(user => ({ ...user, groups: [...new Set([...user.groups, ...(groups[user.id] ?? [])])].sort() })),
    connectors: {
      slack: new MockConnector("slack", sourceDocs.filter(doc => doc.source === "slack")),
      jira: new MockConnector("jira", sourceDocs.filter(doc => doc.source === "jira")),
      confluence: new MockConnector("confluence", sourceDocs.filter(doc => doc.source === "confluence")),
      drive: new MockConnector("drive", sourceDocs.filter(doc => doc.source === "drive"))
    }
  };
}
