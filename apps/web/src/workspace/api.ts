// The one client the workspace surface talks to the API with. Every call carries the identity the page
// is showing: the demo persona when the page is in the demo, the session otherwise.

import { ApiError, call } from "../tasks/api";

export { ApiError };

export type WorkspaceDocument = {
  docId: string;
  source: string;
  title: string;
  content: string;
  url: string;
  updatedAt: string;
  version: number;
  tier?: string;
  lastIndexedAt?: string;
  lastPermissionSyncAt?: string;
  metadata: Record<string, string>;
  links: string[];
};

export type WorkspaceProject = { key: string; name: string; masterDocId: string; docIds: string[] };

export type WorkspaceLatest = { project?: string; docId: string; score: number; reasons: string[] };

export type WorkspaceDuplicate = {
  keep: string;
  other: string;
  reasons: string[];
  onlyInKeep: string[];
  onlyInOther: string[];
};

export type CommitmentCandidate = { docId: string; title: string; url: string };

export type Commitment = {
  id: string;
  revision: number;
  status: string;
  threadDocId: string;
  sentence: string;
  project: string;
  summary: string;
  ownerSlackId?: string;
  dueDate?: string;
  canCreate: boolean;
  permalink?: string;
  notice?: string;
  importNotice?: string;
  jiraUrl?: string;
  issueDocId?: string;
  issueTitle?: string;
  candidates?: CommitmentCandidate[];
};

export type WorkspaceOwner = { slackId: string; name: string };

export type WorkspaceCapabilities = { mode?: string; createTask?: boolean; markDone?: boolean };

export type WorkspacePayload = {
  documents: WorkspaceDocument[];
  projects: WorkspaceProject[];
  latest: WorkspaceLatest[];
  duplicates: WorkspaceDuplicate[];
  suggestions: Commitment[];
  commitments: Commitment[];
  owners: WorkspaceOwner[];
  capabilities: WorkspaceCapabilities;
  importNotice?: string;
};

export type Citation = {
  docId: string;
  chunkId: string;
  title: string;
  url: string;
  version: number;
  updatedAt: string;
  lastIndexedAt?: string;
  linkedFrom?: string;
  number: number;
};

export type AnswerCheck = {
  lines: { kind: "quoted" | "reworded"; support: string[] }[];
  removed: { reason: string }[];
};

export type QueryScope = { sources: string[]; from?: string; to?: string; project?: string };

export type AnswerResult = {
  text: string;
  citations: Citation[];
  check?: AnswerCheck;
  scope?: QueryScope;
  traceId?: string;
  importNotice?: string;
};

export type QueryResponse = AnswerResult & {
  kind?: "chat" | "action" | "answer";
  proposal?: { id: string; project: string; summary: string; description: string; dueDate?: string };
};

export type CatchUpResponse =
  | { kind: "audit"; lines: string[]; importNotice?: string }
  | { kind: "question"; question: string; answer: AnswerResult; traceId?: string; importNotice?: string };

export type CreatedTask = { docId: string; title: string; omitted?: ("owner" | "due date")[] };

export type TraceEntry = {
  type: string;
  sequence: number;
  timestamp: string;
  actor?: string;
  data?: Record<string, unknown>;
};

export type TraceResult = { traceId: string; entries: TraceEntry[] };

export type ChatTurn = { role: "user" | "assistant"; text: string };

export async function loadWorkspace(): Promise<WorkspacePayload> {
  return call<WorkspacePayload>("/v1/workspace");
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", body });
}

export async function askApi(question: string, history: ChatTurn[], project?: string): Promise<QueryResponse> {
  return post<QueryResponse>("/v1/query", {
    question,
    ...(history.length ? { history } : {}),
    ...(project ? { project } : {})
  });
}

export async function catchUpApi(project?: string): Promise<CatchUpResponse> {
  return post<CatchUpResponse>("/v1/catch-up", project ? { project } : {});
}

export async function reviewCommitment(command: {
  id: string;
  revision: number;
  action: "edit" | "dismiss" | "link";
  summary?: string;
  ownerSlackId?: string;
  dueDate?: string;
  issueDocId?: string;
}): Promise<{ id: string; revision: number; status: string }> {
  return post("/v1/commitments/review", command);
}

export async function createTaskApi(command: {
  threadDocId: string;
  sentence: string;
  proposalId: string;
  revision: number;
}): Promise<CreatedTask> {
  return post<CreatedTask>("/v1/tasks", command);
}

export async function markDoneApi(docId: string): Promise<{ ok: boolean }> {
  return post("/v1/tasks/done", { docId });
}

export async function traceApi(traceId: string): Promise<TraceResult> {
  return call<TraceResult>(`/v1/trace?traceId=${encodeURIComponent(traceId)}`);
}
