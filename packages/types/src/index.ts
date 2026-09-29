export type Source = "slack" | "jira" | "confluence" | "drive";
export type Tier = "open" | "internal" | "restricted";

export interface User {
  id: string;
  name: string;
  email: string;
  auth0Sub: string;
  supabaseAuthId?: string;
  platformIdentities?: Record<Source, string>;
  groups: string[];
  role: "member" | "admin" | "compliance";
  contractor?: boolean;
}

export type NativePermission =
  | { source: "slack"; channelId: string; visibility: "public" | "private"; members: string[] }
  | { source: "jira"; projectKey: string; projectViewers: string[]; issueViewers?: string[] }
  | { source: "confluence"; spaceKey: string; spaceViewers: string[]; pageViewers?: string[] }
  | { source: "drive"; fileId: string; owner: string; sharedUsers: string[] };

export interface SourcePermission {
  users: string[];
  groups: string[];
  public: boolean;
  native?: NativePermission;
}

export interface SourceDocument {
  docId: string;
  source: Source;
  sourceNativeId: string;
  title: string;
  content: string;
  url: string;
  version: number;
  updatedAt: string;
  metadata: Record<string, string>;
  permissions: SourcePermission;
  tier: Tier;
  deletedAt?: string;
}

export interface SourceChunk {
  chunkId: string;
  docId: string;
  text: string;
  embedding: Record<string, number>;
}

export interface IndexedDocument extends SourceDocument {
  contentHash: string;
  permissionHash: string;
  metadataHash: string;
  chunks: SourceChunk[];
  lastIndexedAt: string;
  lastPermissionSyncAt: string;
}

export interface ConnectorState {
  source: Source;
  cursor: number;
  lastSuccessfulSyncAt?: string;
}

export interface SyncRun {
  source: Source;
  cursorFrom: number;
  cursorTo: number;
  pendingIds: string[];
  status: "running" | "failed" | "complete";
  checkpoint?: string;
}

export interface SearchCandidate {
  docId: string;
  chunkId: string;
  score: number;
}

export interface AccessDecision {
  docId: string;
  allowed: boolean;
  reason: "fga" | "source" | "tier";
}

export interface AuditEntry {
  sequence: number;
  timestamp: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface MerkleBatch {
  firstSequence: number;
  lastSequence: number;
  root: string;
  sealedAt: string;
}

export interface MerkleProof {
  leaf: string;
  root: string;
  siblings: Array<{ hash: string; position: "left" | "right" }>;
}

export interface Citation {
  docId: string;
  chunkId: string;
  title: string;
  url: string;
  version: number;
  updatedAt: string;
  lastIndexedAt: string;
}

export interface QueryAnswer {
  text: string;
  citations: Citation[];
}
