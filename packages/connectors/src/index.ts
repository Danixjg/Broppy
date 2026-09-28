import documents from "../../../data/mock/documents.json" with { type: "json" };
import users from "../../../data/mock/users.json" with { type: "json" };
import type { NativePermission, Source, SourceDocument, SourcePermission, User } from "@brain/types";

export type Change = {
  source: Source;
  docId: string;
  kind: "content" | "permission" | "deletion";
  cursor: number;
};

export interface Connector {
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
  if (user.contractor) return false;
  const brainAllows = permission.public ||
    permission.users.includes(user.email) ||
    permission.groups.some(group => user.groups.includes(group));
  if (!brainAllows || !permission.native) return false;

  const native = permission.native;
  const email = user.platformIdentities?.[native.source];
  if (!email) return false;
  switch (native.source) {
    case "slack":
      return native.visibility === "public" || native.members.includes(email);
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
    return doc ? copy(doc) : undefined;
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

export function loadMockCorpus(): {
  users: User[];
  connectors: Record<Source, MockConnector>;
} {
  const sourceDocs = documents as unknown as SourceDocument[];
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
