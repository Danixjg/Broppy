// The seams between the React surfaces and the legacy controller. The workspace surface announces what it
// loaded and who is looking; the controller asks for a reload, an audit search or a trace.

export const WORKSPACE_LOADED = "broppy:workspace-loaded";
export const WORKSPACE_DATA = "broppy:workspace-data";
export const WORKSPACE_RELOAD = "broppy:workspace-reload";
export const IDENTITY_CHANGED = "broppy:identity-changed";
export const TASKS_CHANGED = "broppy:tasks-changed";
export const OPEN_TASK = "broppy:open-task";
export const SHOW_ALL_TASKS = "broppy:show-all-tasks";
export const OPEN_DOC = "broppy:open-doc";
export const SHOW_TRACE = "broppy:show-trace";
export const SEARCH_AUDIT = "broppy:search-audit";

export type OpenTaskDetail = { id: string; element?: HTMLElement };
export type WorkspaceIdentity = { role: "member" | "admin" | "compliance"; mode: string; signedIn: boolean };
export type TraceRequest = { traceId: string };
export type AuditSearch = { question: string };
