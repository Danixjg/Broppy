import documents from "../../../data/mock/documents.json" with { type: "json" };
import users from "../../../data/mock/users.json" with { type: "json" };
import type { Source, SourceDocument, SourcePermission, User } from "@brain/types";

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
  return permission.public ||
    permission.users.includes(user.email) ||
    permission.groups.some(group => user.groups.includes(group));
}

function copy<T>(value: T): T {
  return structuredClone(value);
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
    this.docs.set(id, { ...doc, permissions: copy(permissions) });
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
