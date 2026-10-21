import { createHash } from "node:crypto";
import type { AccessDecision, SourceDocument, User } from "@brain/types";
import { CommandRejection, type CommandIntent, CommandResult, type EditFields, type TransitionMeta, type TransitionChoices,
  commandEnvelope, parseCommandIdentity, parseEditFields, parseTransitionCommand, revisionOf } from "./task-commands.js";
import { categoryOf, columnize, filterRows, pageOf, presetRows, priorityRank, sortRows, summarize,
  type DataGeneration, type JiraStatusCategory, type TaskQuery, type TaskRow, type TaskSnapshot } from "./tasks-lens.js";

/** The ONLY data surface the list path sees: the synced corpus and the synced permission index, as one frozen view.
 *  Nothing on it can perform a per-document live permission call — that is the C2 list-side discipline. */
export interface TaskCatalogAccess {
  readonly orgId: string;
  readonly liveMode: boolean;
  /** Everything indexed, tombstones included; assembly selects the Jira rows and drops tombstones. */
  readonly docs: () => readonly SourceDocument[];
  readonly generation: () => DataGeneration;
  /** Synced authorization only; the decisions come from the FGA core, never from a provider round trip. */
  readonly checkSynced: (user: User, docIds: readonly string[]) => Promise<AccessDecision[]>;
  /** Doc ids of issues Broppy created for this person's reviewed commitments. */
  readonly mineDocIds: (user: User) => Promise<readonly string[]>;
  readonly refreshPending: boolean;
  /** Whether task writes exist for this company at all: demo always, live only through its shared Jira grant. */
  readonly writeCapable: boolean;
}

/** The detail's return shape: the fresh document, whether it is a task Broppy created for this person,
 * and linked documents the synced index now allows. Authorization of all of it happened in Brain. */
export interface TaskDetail {
  readonly document: SourceDocument;
  readonly mine: boolean;
  readonly links: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/** The ONLY fresh surface, wired by server.ts to Brain.taskDetail. undefined covers missing, hidden,
 * tombstoned, and fresh-check-failed alike — every one resolves to the same 404 bytes. */
export interface DetailPort {
  readonly get: (user: User, docId: string) => Promise<TaskDetail | undefined>;
}

export interface GetTaskRoutesInput {
  readonly url: URL;
  readonly user: User;
  readonly list: TaskCatalogAccess;
  readonly detail: DetailPort;
}

export type Routed = { status: number; body: unknown };

const TASK_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const ISSUE_ID_PATH = /^\/v1\/tasks\/jira\/([A-Z][A-Z0-9]{1,9}-\d+)$/;
const COLUMN_IDS = ["todo", "in-progress", "done", "unmapped"] as const;
const DUE_VALUES = ["any", "today", "throughToday", "thisWeek", "overdue", "none"] as const;
const PRESET_VALUES = ["open", "dueThisWeek", "overdue", "doneThisWeek"] as const;
const SORT_VALUES = ["dueAsc", "updatedDesc", "priorityDesc", "keyAsc"] as const;
const PARSED_KEYS = ["view", "projectIds", "assigneeIds", "priorityIds", "statusIds", "mine", "due",
  "summaryPreset", "q", "sort", "timezone", "limit", "cursor", "snapshotId", "columnId"] as const;
const FIVE_MINUTES = 5 * 60_000;
const THIRTY_SECONDS = 30 * 1000;

/** Parse at the boundary. All field problems are collected into one rejection. `q` is plain words with a
 * length cap; the id lists are bounded comma-separated names. No id triggers a provider call anywhere. */
export function parseTaskQuery(url: URL): TaskQuery {
  const fieldErrors: Record<string, string> = {};
  const unknownFields: Record<string, string> = {};
  url.searchParams.forEach((_value, key) => {
    if (!PARSED_KEYS.includes(key as (typeof PARSED_KEYS)[number])) unknownFields[key] = "Not a supported query field.";
  });

  const idList = (key: string): string[] => {
    const raw = url.searchParams.getAll(key);
    if (raw.length === 0) return [];
    const values = [...new Set(raw.flatMap(value => value.split(","))).values()]
      .map(value => value.trim()).filter(value => value !== "");
    if (!values.every(value => value.length <= 80)) fieldErrors[key] = "Each value may have up to 80 characters.";
    else if (values.length > 50) fieldErrors[key] = "Use up to 50 values.";
    return values;
  };

  const view = parseChoice<("board" | "list" | "personal")>(url, "view", ["board", "list", "personal"], fieldErrors) ?? "list";
  const due = parseChoice(url, "due", [...DUE_VALUES], fieldErrors) ?? "any";
  const summaryPreset = parseChoice(url, "summaryPreset", [...PRESET_VALUES], fieldErrors);
  const sort = parseChoice(url, "sort", [...SORT_VALUES], fieldErrors) ?? "dueAsc";
  const projectIds = idList("projectIds");
  const statusIds = idList("statusIds");
  const priorityIds = idList("priorityIds");

  const mineRaw = url.searchParams.get("mine");
  if (mineRaw !== null && mineRaw !== "true" && mineRaw !== "false") fieldErrors.mine = "Use true or false.";

  let limit = 50;
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) fieldErrors.limit = "Use a whole number.";
    else limit = Math.min(100, Math.max(1, Number(limitRaw)));
  }

  let qTokens: string[] = [];
  const qRaw = url.searchParams.get("q");
  if (qRaw !== null) {
    if (qRaw.length > 200) fieldErrors.q = "Use up to 200 characters of plain words.";
    else qTokens = qRaw.toLowerCase().split(/\s+/).filter(Boolean);
  }

  let timezone = "UTC";
  const timezoneRaw = url.searchParams.get("timezone");
  if (timezoneRaw !== null) {
    timezone = timezoneRaw;
    try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone }); }
    catch { fieldErrors.timezone = "Use an IANA time zone name."; }
  }

  if (url.searchParams.has("assigneeIds")) {
    fieldErrors.assigneeIds = "Filtering by assignee is not available. Use mine=true.";
  }

  if (Object.keys(fieldErrors).length === 0 && Object.keys(unknownFields).length) {
    throw new TaskQueryError(unknownFields, "unknown_field");
  }
  if (Object.keys(fieldErrors).length) throw new TaskQueryError({ ...unknownFields, ...fieldErrors });
  const query: TaskQuery = { view, projectIds, statusIds, priorityIds, mine: mineRaw === "true", due,
    ...(summaryPreset ? { summaryPreset } : {}), q: qTokens, sort, timezone, limit };
  if (view === "personal") return { ...query, mine: true, due: "throughToday", summaryPreset: query.summaryPreset ?? "open" };
  return query;
}

function parseChoice<T extends string>(url: URL, key: string, values: readonly T[], fieldErrors: Record<string, string>): T | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  if (!values.includes(raw as T)) { fieldErrors[key] = `Use one of ${values.join(", ")}.`; return undefined; }
  return raw as T;
}

export class TaskQueryError extends Error {
  override name = "TaskQueryError";
  constructor(readonly fieldErrors: Record<string, string>, readonly kind: "invalid_query" | "unknown_field" = "invalid_query") {
    super("The task query is not valid.");
  }
}

/** The single authorized-row choke point: the only place synced documents become TaskRows, and the only
 * place a row later counted could ever have come from. It never touches the fresh-check seam. */
export async function assembleSnapshot(catalog: TaskCatalogAccess, actor: User, now: Date): Promise<TaskSnapshot> {
  const jiraDocs = catalog.docs().filter(doc => doc.source === "jira" && !doc.deletedAt);
  const mine = new Set(await catalog.mineDocIds(actor));
  const built = jiraDocs.map(doc => toRow(doc, mine, catalog.liveMode));
  const decisions = await catalog.checkSynced(actor, built.map(row => row.id));
  const allowed = new Set(decisions.filter(decision => decision.allowed).map(decision => decision.docId));
  return { gen: catalog.generation(), builtAt: now.toISOString(), rows: built.filter(row => allowed.has(row.id)) };
}

function toRow(doc: SourceDocument, mineDocIds: ReadonlySet<string>, liveMode: boolean): TaskRow {
  const key = doc.docId.slice("jira:".length);
  const project = doc.metadata.project || key.split("-")[0] || "";
  const status = doc.metadata.status ?? "";
  const priority = doc.metadata.priority || null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(doc.metadata.dueDate ?? "") ? doc.metadata.dueDate! : null;
  return {
    id: doc.docId, key, title: doc.title, projectKey: project, projectName: project, status,
    category: categoryOf(doc.metadata, liveMode), dueDate: due, priority, priorityRank: priorityRank(priority),
    updatedAt: doc.updatedAt, url: doc.url, mine: mineDocIds.has(doc.docId)
  };
}

/** A filter id is validated against the authorized snapshot's own facet set. An unknown value is a client
 * bug (400), not an existence hint (C12): it must never produce a distinct "no such filter" emptiness. */
function rejectUnknownFacets(query: TaskQuery, snapshot: TaskSnapshot): void {
  const fieldErrors: Record<string, string> = {};
  const known = {
    projectIds: new Set(snapshot.rows.map(row => row.projectKey)),
    statusIds: new Set(snapshot.rows.map(row => row.status).filter(name => name !== "")),
    priorityIds: new Set(snapshot.rows.map(row => row.priority).filter((name): name is string => name !== null))
  };
  for (const [facet, values] of [["projectIds", query.projectIds], ["statusIds", query.statusIds],
    ["priorityIds", query.priorityIds]] as const) {
    const unknown = values.filter(value => !known[facet].has(value));
    if (unknown.length) fieldErrors[facet] = `Unknown value${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`;
  }
  if (Object.keys(fieldErrors).length) throw new TaskQueryError(fieldErrors);
}

function appliedFiltersOf(query: TaskQuery): Record<string, unknown> {
  return {
    view: query.view, projectIds: [...query.projectIds], statusIds: [...query.statusIds],
    priorityIds: [...query.priorityIds], mine: query.mine, due: query.due,
    summaryPreset: query.summaryPreset ?? null,
    q: [...query.q], sort: query.sort, timezone: query.timezone, limit: query.limit
  };
}

interface CursorToken {
  readonly v: 1;
  readonly generation: string;
  readonly queryHash: string;
  readonly actor: string;
  readonly offset: number;
  readonly column?: { readonly id: string; readonly offset: number };
}

/** Unsigned on purpose: every field resolves only against the issuer's own actor, query and current
 * generation, so a forged cursor degrades to 400/409 and can never admit a page. */
function cursorFor(query: TaskQuery, snapshot: TaskSnapshot, actor: User, offset: number,
  column?: { id: string; offset: number }): string {
  const body: Record<string, unknown> = {
    v: 1, generation: snapshot.gen.id,
    queryHash: queryHash(query, snapshot), actor: actorFingerprint(actor), offset, ...(column ? { column } : {})
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function queryHash(query: TaskQuery, snapshot: TaskSnapshot): string {
  return createHash("sha256").update(JSON.stringify(appliedFiltersOf(query))).digest("hex");
}

function actorFingerprint(actor: User): string {
  return `${actor.orgId ?? ""}|${actor.id}`;
}

function decodeCursor(raw: string, query: TaskQuery, snapshot: TaskSnapshot, actor: User): CursorToken | undefined {
  let body: unknown;
  try { body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { return undefined; }
  if (!body || typeof body !== "object" || (body as Record<string, unknown>).v !== 1) return undefined;
  const token = body as Record<string, unknown>;
  const offset = token.offset;
  const column = token.column as { id: unknown; offset: unknown } | undefined;
  if (typeof token.generation !== "string" || typeof token.queryHash !== "string" || typeof token.actor !== "string" ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return undefined;
  if (column && (typeof column.id !== "string" || typeof column.offset !== "number" ||
    !Number.isSafeInteger(column.offset) || column.offset < 0)) return undefined;
  if ((query.view === "board") !== Boolean(column)) return undefined;
  if (column && !COLUMN_IDS.includes(column.id as (typeof COLUMN_IDS)[number])) return undefined;
  if (token.queryHash !== queryHash(query, snapshot) || token.actor !== actorFingerprint(actor)) return undefined;
  if (token.generation !== snapshot.gen.id) throw new SnapshotExpired();
  return {
    v: 1, generation: token.generation, queryHash: token.queryHash, actor: token.actor, offset,
    ...(column ? { column: { id: column.id as string, offset: column.offset as number } } : {})
  };
}

export class SnapshotExpired extends Error {
  override name = "SnapshotExpired";
  constructor() { super("The data generation this cursor belongs to has ended. Fetch the first page again."); }
}

interface Card {
  readonly id: string; readonly key: string; readonly title: string;
  readonly projectKey: string; readonly projectName: string;
  readonly status: { readonly name: string; readonly category: JiraStatusCategory | null };
  readonly dueDate: string | null; readonly priority: string | null;
  readonly updatedAt: string; readonly url: string;
  readonly mine: boolean;
}

function toCard(row: TaskRow): Card {
  return {
    id: row.id, key: row.key, title: row.title, projectKey: row.projectKey, projectName: row.projectName,
    status: { name: row.status, category: row.category ?? null },
    dueDate: row.dueDate, priority: row.priority, updatedAt: row.updatedAt, url: row.url, mine: row.mine
  };
}

function envelopeBase(query: TaskQuery, snapshot: TaskSnapshot, catalog: TaskCatalogAccess, now: Date,
  filtered: readonly TaskRow[]) {
  return {
    snapshotId: snapshot.gen.id,
    dataSnapshotId: snapshot.gen.id,
    dataGenerationExpiresAt: new Date(Date.parse(snapshot.gen.observedAt) + FIVE_MINUTES).toISOString(),
    summary: summarize(filtered, query, now),
    summaryScope: "explicitFiltersBeforeSummaryPreset" as const,
    appliedFilters: appliedFiltersOf(query),
    freshness: {
      observedAt: snapshot.gen.observedAt,
      authorizedAt: now.toISOString(),
      authorizationExpiresAt: new Date(now.getTime() + THIRTY_SECONDS).toISOString(),
      dataComplete: snapshot.gen.dataComplete,
      refreshPending: catalog.refreshPending
    }
  };
}

async function listRoute(input: GetTaskRoutesInput, now: Date): Promise<Routed> {
  const query = parseTaskQuery(input.url);
  const snapshot = await assembleSnapshot(input.list, input.user, now);
  rejectUnknownFacets(query, snapshot);
  const bound = boundCursor(input.url, query, snapshot, input.user);
  const filtered = filterRows(snapshot.rows, query, now);
  const display = query.summaryPreset ? presetRows(filtered, query.summaryPreset, query, now) : filtered;
  const sorted = sortRows(display, query.sort);
  if (query.view === "board") return boardEnvelope(query, snapshot, input.list, input.user, now, filtered, sorted, bound);
  const shown = pageOf(sorted, query.limit, bound?.offset ?? 0);
  return {
    status: 200,
    body: {
      ...envelopeBase(query, snapshot, input.list, now, filtered),
      items: shown.items.map(toCard),
      page: {
        nextCursor: shown.hasMore ? cursorFor(query, snapshot, input.user, shown.nextOffset) : null,
        hasMore: shown.hasMore,
        total: sorted.length
      },
      columns: []
    }
  };
}

function boardEnvelope(query: TaskQuery, snapshot: TaskSnapshot, catalog: TaskCatalogAccess, actor: User,
  now: Date, filtered: readonly TaskRow[], sorted: readonly TaskRow[],
  bound: CursorToken | undefined): Routed {
  const columns = columnize(sorted);
  const boundColumnId = bound?.column?.id;
  const boundOffset = bound?.column ? bound.column.offset : 0;
  const served = boundColumnId ? columns.filter(column => column.id === boundColumnId) : columns;
  return {
    status: 200,
    body: {
      ...envelopeBase(query, snapshot, catalog, now, filtered),
      items: [],
      page: { nextCursor: null, hasMore: false, total: sorted.length },
      columns: served.map(column => {
        const shown = pageOf(column.rows, query.limit, column.id === boundColumnId ? boundOffset : 0);
        return {
          id: column.id, name: column.name, total: column.rows.length,
          items: shown.items.map(toCard),
          nextCursor: shown.hasMore ? cursorFor(query, snapshot, actor, shown.nextOffset,
            { id: column.id, offset: shown.nextOffset }) : null
        };
      })
    }
  };
}

function boundCursor(url: URL, query: TaskQuery, snapshot: TaskSnapshot, actor: User): CursorToken | undefined {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return undefined;
  const token = decodeCursor(raw, query, snapshot, actor);
  if (!token) throw new TaskQueryError({ cursor: "The cursor does not fit this query, actor, view or cell." });
  return token;
}

async function projectsRoute(input: GetTaskRoutesInput, now: Date): Promise<Routed> {
  const snapshot = await assembleSnapshot(input.list, input.user, now);
  const projects = [...new Set(snapshot.rows.map(row => row.projectKey).filter(Boolean))]
    .sort().map(key => ({ key, name: key }));
  return { status: 200, body: { projects } };
}

async function detailRoute(user: User, docId: string, detail: DetailPort, catalog: TaskCatalogAccess): Promise<Routed> {
  const shot = await detail.get(user, docId);
  if (!shot) return taskUnavailable();
  const row = toRow(shot.document, new Set(shot.mine ? [shot.document.docId] : []), catalog.liveMode);
  return {
    status: 200,
    body: {
      ...toCard(row),
      revision: revisionOf(shot.document.version),
      description: shot.document.content,
      links: shot.links.map(link => ({ id: link.id, title: link.title })),
      capabilities: { edit: catalog.writeCapable }
    }
  };
}

async function resolveRoute(url: URL, user: User, detail: DetailPort): Promise<Routed> {
  const raw = url.searchParams.get("docId") ?? "";
  const key = raw.startsWith("jira:") ? raw.slice("jira:".length) : raw;
  if (!TASK_KEY.test(key)) return taskUnavailable();
  const shot = await detail.get(user, `jira:${key}`);
  if (!shot) return taskUnavailable();
  return { status: 200, body: { id: shot.document.docId } };
}

/** The one canonical unavailable body for hidden and missing alike (C12): one constant, so every path
 * that resolves to it emits identical bytes. */
const UNAVAILABLE: Routed = {
  status: 404,
  body: { error: { code: "TASK_UNAVAILABLE", message: "Task unavailable.", retryable: false } }
};

export function taskUnavailable(): Routed {
  return UNAVAILABLE;
}

/** Owns every well-formed-error transformation for task GETs, so the server's legacy error path never rewraps
 * them. Returns undefined for paths outside /v1/tasks. */
export async function getTaskRoutes(input: GetTaskRoutesInput): Promise<Routed | undefined> {
  const { url } = input;
  if (url.pathname !== "/v1/tasks" && !url.pathname.startsWith("/v1/tasks/")) return undefined;
  return await routeBody(input, new Date());
}

async function routeBody(input: GetTaskRoutesInput, now: Date): Promise<Routed> {
  const { url, user, list: catalog, detail } = input;
  try {
    const detailMatch = ISSUE_ID_PATH.exec(url.pathname);
    if (detailMatch) return await detailRoute(user, `jira:${detailMatch[1]}`, detail, catalog);
    if (url.pathname === "/v1/tasks/resolve") return await resolveRoute(url, user, detail);
    if (url.pathname === "/v1/tasks/projects") return await projectsRoute(input, now);
    if (url.pathname === "/v1/tasks") return await listRoute(input, now);
    return taskUnavailable();
  } catch (error) {
    if (error instanceof TaskQueryError) {
      return {
        status: 400,
        body: { error: { code: error.kind === "unknown_field" ? "UNKNOWN_FIELD" : "INVALID_QUERY",
          message: error.message, fieldErrors: error.fieldErrors, retryable: false } }
      };
    }
    if (error instanceof SnapshotExpired) {
      return {
        status: 409,
        body: { error: { code: "SNAPSHOT_EXPIRED", message: error.message, retryable: false } }
      };
    }
    throw error;
  }
}

/** What the executor offers the write routes. Brain satisfies it; the interfaces keep tasks.ts ignorant of Brain. */
export interface TaskCommandPort {
  readonly taskEdit: (actor: User, docId: string, intent: CommandIntent, fields: EditFields) => Promise<CommandResult>;
  readonly taskTransition: (actor: User, docId: string, intent: CommandIntent, command: { transitionId: string; fields: Record<string, string> }) => Promise<CommandResult>;
  readonly taskTransitionChoices: (actor: User, docId: string) => Promise<TransitionChoices>;
  readonly taskOperationReceipt: (actor: User, operationId: string) => Promise<OperationReceipt>;
  readonly settleUncertain: (actor: User, operationId: string) => Promise<OperationReceipt>;
}

/** An operation receipt plus the fresh task document the viewer's own access allows; the task part drops when
 * that access is gone, leaving the receipt itself readable. */
export type OperationReceipt =
  Extract<CommandResult, { status: "applied" | "rejected" | "uncertain" | "unavailable" }>
  & { readonly document?: SourceDocument; readonly taskUnavailable?: boolean };

const COMMAND_WRITE = /^\/v1\/tasks\/jira\/([A-Z][A-Z0-9]{1,9}-\d+)$/;
const COMMAND_TRANSITIONS = /^\/v1\/tasks\/jira\/([A-Z][A-Z0-9]{1,9}-\d+)\/transitions$/;
const COMMAND_RECEIPT = /^\/v1\/task-operations\/([A-Za-z0-9-]{1,64})(\/check)?$/;
const POLL_AFTER_MS = 5_000;
const INVALID_BODY = (message: string): Routed => ({ status: 400, body: { error: { code: "INVALID_BODY", message, retryable: false } } });

export interface TaskCommandRouteInput {
  readonly method: "PUT" | "POST" | "GET";
  readonly url: URL;
  readonly user: User;
  readonly body?: unknown;
  readonly headers: Record<string, string | undefined>;
  readonly list: TaskCatalogAccess;
  readonly commands: TaskCommandPort;
}

/** The write half of the task routes: one place turns executor results into envelopes and receipts, so no caller
 * rewraps a refusal into a legacy error string. Undefined means this method and path aren't one of ours. */
export async function taskCommandRoutes(input: TaskCommandRouteInput): Promise<Routed | undefined> {
  const { method, url, user, list, commands } = input;
  const transitions = COMMAND_TRANSITIONS.exec(url.pathname);
  if (transitions) {
    const docId = `jira:${transitions[1]}`;
    if (method === "GET") {
      const choices = await commands.taskTransitionChoices(user, docId);
      return choices.status === "unavailable" ? taskUnavailable()
        : { status: 200, body: { taskRevision: choices.revision, transitions: choices.transitions } };
    }
    if (method === "POST") return await submitCommand(input, raw => parseTransitionCommand(raw),
      (user2, docId, intent, command) => commands.taskTransition(user2, docId, intent, command));
    return undefined;
  }
  const issue = COMMAND_WRITE.exec(url.pathname);
  if (issue && method === "PUT") {
    return await submitCommand(input, raw => parseEditFields(raw),
      (user2, docId, intent, fields) => commands.taskEdit(user2, docId, intent, fields));
  }
  const receipt = COMMAND_RECEIPT.exec(url.pathname);
  if (receipt && (method === "GET" || method === "POST")) {
    return { status: 200, body: receiptBody(await (method === "GET"
      ? commands.taskOperationReceipt(user, receipt[1])
      : commands.settleUncertain(user, receipt[1])), list.liveMode) };
  }
  return undefined;
}

/** Parse identity and payload at the boundary, then hand the executor one clean command. */
async function submitCommand<T>(input: TaskCommandRouteInput, parse: (raw: Record<string, unknown>) => T,
  run: (user: User, docId: string, intent: CommandIntent, command: T) => Promise<CommandResult>): Promise<Routed> {
  const { url, user, list } = input;
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) return INVALID_BODY("The request body must be a JSON object.");
  try {
    const intent = parseCommandIdentity(url, input.headers["if-match"], input.headers["idempotency-key"], input.body as Record<string, unknown>);
    const command = parse(input.body as Record<string, unknown>);
    const docId = `jira:${(COMMAND_TRANSITIONS.exec(url.pathname) ?? COMMAND_WRITE.exec(url.pathname))![1]}`;
    return commandRouted(await run(user, docId, intent, command), list);
  } catch (rejection) {
    if (!(rejection instanceof CommandRejection)) throw rejection;
    return { status: rejection.status, body: commandEnvelope(rejection) };
  }
}

function commandRouted(result: CommandResult, list: TaskCatalogAccess): Routed {
  switch (result.status) {
    case "unavailable": return taskUnavailable();
    case "forbidden": return { status: 403, body: { error: { code: "FORBIDDEN", message: "Your Jira access does not allow this change.", retryable: false } } };
    case "refused": return { status: result.rejection.status,
      body: { ...commandEnvelope(result.rejection),
        ...(result.rejection.extra.operationId !== undefined ? { operationId: result.rejection.extra.operationId } : {}),
        ...("transitions" in result.rejection.extra ? { transitions: result.rejection.extra.transitions } : {}),
        ...(result.rejection.extra.currentRevision !== undefined ? { currentRevision: result.rejection.extra.currentRevision } : {}) } };
    case "uncertain": return { status: 202, body: { operationId: result.operation.id, state: "uncertain", pollAfterMs: POLL_AFTER_MS } };
    case "rejected": return rejectedReceipt(result);
    case "applied": {
      const document = result.document;
      return { status: 200, body: {
        operationId: result.operation.id, state: "applied", outcome: result.operation.outcome,
        ...(document ? { task: taskWithRevision(document, list.liveMode) } : { taskUnavailable: true }),
        invalidate: ["task", "taskQueries", "personalTasks", "workspaceLinkedTask"], requiresSnapshotReload: true } };
    }
  }
}

const REJECTED_STATUS: Record<string, number> = {
  TASK_CHANGED: 412, TRANSITION_UNAVAILABLE: 409, FIELD_VALIDATION_FAILED: 422, UNSUPPORTED_REQUIRED_FIELD: 422,
  FORBIDDEN: 403, JIRA_UNAVAILABLE: 503
};

function rejectedReceipt(result: Extract<CommandResult, { status: "rejected" }>): Routed {
  const code = result.operation.outcomeCode ?? "FIELD_VALIDATION_FAILED";
  const status = REJECTED_STATUS[code] ?? 422;
  return { status, body: { ...commandEnvelope(new CommandRejection(status, code, result.fieldErrors)),
    operationId: result.operation.id, state: "rejected" } };
}

function receiptBody(result: OperationReceipt, liveMode: boolean): unknown {
  if (result.status === "unavailable") return UNAVAILABLE.body;
  const document = result.document;
  return {
    operationId: result.operation.id, state: result.operation.state,
    ...(result.operation.outcome ? { outcome: result.operation.outcome } : {}),
    ...(result.operation.fieldErrors && Object.keys(result.operation.fieldErrors).length ? { fieldErrors: result.operation.fieldErrors } : {}),
    ...(document && result.taskUnavailable !== true
      ? { task: taskWithRevision(document, liveMode) } : { taskUnavailable: true })
  };
}
const taskWithRevision = (document: SourceDocument, liveMode: boolean) =>
  ({ ...toCard(toRow(document, new Set<string>(), liveMode)), revision: revisionOf(document.version) });
