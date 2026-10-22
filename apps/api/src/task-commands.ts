import { createHash } from "node:crypto";
import type { SourceDocument } from "@brain/types";

export type CommandState = "reserved" | "executing" | "applied" | "rejected" | "uncertain";
export type CommandOutcome = "providerReceipt" | "desiredStateObserved";

export interface CommandOperation {
  id: string;
  orgId: string;
  actorId: string;
  idempotencyKey: string;
  intentId: string;
  payloadHash: string;
  issueKey: string;
  state: CommandState;
  outcome?: CommandOutcome;
  /** The safe outcome code a rejection is replayed with, so its HTTP status never drifts. */
  outcomeCode?: string;
  fieldErrors?: Record<string, string>;
  intendedFields?: Record<string, unknown>;
}

export interface CommandReservation {
  orgId: string;
  actorId: string;
  idempotencyKey: string;
  intentId: string;
  payloadHash: string;
  issueKey: string;
}

export type ReserveResult =
  | { kind: "new"; operation: CommandOperation }
  | { kind: "replay"; operation: CommandOperation }
  | { kind: "payload-conflict"; operation: CommandOperation };

export interface TaskCommandStore {
  reserve(input: CommandReservation): Promise<ReserveResult>;
  getCommand(id: string): Promise<CommandOperation | undefined>;
  advanceCommand(id: string, expected: CommandState, patch: Partial<CommandOperation>): Promise<CommandOperation | undefined>;
  claimLease(issueKey: string, operationId: string, now: number): Promise<CommandLeaseResult>;
  releaseLease(issueKey: string, operationId: string): Promise<void>;
  resolveUncertain(operationId: string, outcome: CommandOutcome): Promise<CommandOperation | undefined>;
  barrierFor(issueKey: string): Promise<CommandOperation | undefined>;
}

export type CommandLeaseResult = { kind: "claimed" } | { kind: "busy"; operation: CommandOperation };

const LEASE_MS = 60_000;

export class MemoryTaskCommandStore implements TaskCommandStore {
  private readonly byId = new Map<string, CommandOperation>();
  private readonly byKey = new Map<string, CommandOperation>();
  private readonly byIntent = new Map<string, CommandOperation>();
  private readonly leases = new Map<string, { operationId: string; expiresAt: number }>();
  private readonly barriers = new Map<string, CommandOperation>();
  private sequence = 0;

  async reserve(input: CommandReservation): Promise<ReserveResult> {
    const key = `${input.orgId}|${input.actorId}|${input.idempotencyKey}`;
    const found = this.byKey.get(key);
    if (found) return found.payloadHash === input.payloadHash ? { kind: "replay", operation: found } : { kind: "payload-conflict", operation: found };
    const intent = this.byIntent.get(`${input.orgId}|${input.actorId}|${input.intentId}`);
    if (intent) return { kind: "replay", operation: intent };
    const operation: CommandOperation = { ...input, id: `cmnd-${++this.sequence}`, state: "reserved" };
    this.byId.set(operation.id, operation);
    this.byKey.set(key, operation);
    this.byIntent.set(`${input.orgId}|${input.actorId}|${input.intentId}`, operation);
    return { kind: "new", operation };
  }
  async getCommand(id: string) { const found = this.byId.get(id); return found && { ...found }; }
  async advanceCommand(id: string, expected: CommandState, patch: Partial<CommandOperation>) {
    const found = this.byId.get(id);
    if (!found || found.state !== expected) return found && { ...found };
    Object.assign(found, patch);
    if (terminal(found.state)) {
      for (const [key, entry] of [...this.leases]) if (entry.operationId === id) this.leases.delete(key);
      if (found.state !== "uncertain") this.barriers.delete(found.issueKey);
      else this.barriers.set(found.issueKey, found);
    }
    return { ...found };
  }
  async claimLease(issueKey: string, operationId: string, now: number): Promise<CommandLeaseResult> {
    for (const entry of [...this.leases.values()]) {
      if (entry.expiresAt > now) continue;
      const holder = this.byId.get(entry.operationId);
      if (holder && holder.state === "executing") {
        const expired = await this.advanceCommand(entry.operationId, "executing", { state: "uncertain" });
        if (expired) this.barriers.set(issueKey, expired);
      }
      this.leases.delete(issueKey);
    }
    const held = this.leases.get(issueKey);
    if (held) {
      const holder = this.byId.get(held.operationId);
      if (holder) return { kind: "busy", operation: { ...holder } };
    }
    this.leases.set(issueKey, { operationId, expiresAt: now + LEASE_MS });
    return { kind: "claimed" };
  }
  async releaseLease(issueKey: string, operationId: string) { if (this.leases.get(issueKey)?.operationId === operationId) this.leases.delete(issueKey); }
  async resolveUncertain(operationId: string, outcome: CommandOutcome) {
    const found = this.byId.get(operationId);
    if (!found || found.state !== "uncertain") return found && { ...found };
    return await this.advanceCommand(operationId, "uncertain", { state: "applied", outcome });
  }
  async barrierFor(issueKey: string) { return this.barriers.get(issueKey); }
}

const terminal = (state: CommandState): boolean => state === "applied" || state === "rejected" || state === "uncertain";

export class CommandRejection extends Error {
  constructor(readonly status: number, readonly code: string, readonly fieldErrors: Record<string, string> = {}, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export const commandEnvelope = (rejection: CommandRejection): { error: { code: string; message: string; fieldErrors?: Record<string, string>; retryable: false } } => ({
  error: { code: rejection.code, message: COMMAND_MESSAGES[rejection.code] ?? rejection.code,
    ...(Object.keys(rejection.fieldErrors).length ? { fieldErrors: rejection.fieldErrors } : {}), retryable: false }
});
const COMMAND_MESSAGES: Record<string, string> = {
  PRECONDITION_REQUIRED: "Include If-Match with the task's current revision to change it.",
  INVALID_BODY: "The request was not valid.",
  UNKNOWN_FIELD: "The request contained fields the task rules do not allow.",
  IDEMPOTENCY_KEY_REUSED: "This Idempotency-Key was already used with different content.",
  TASK_CHANGED: "The task changed since you loaded it.",
  TRANSITION_UNAVAILABLE: "That transition is not available for this task right now.",
  FIELD_VALIDATION_FAILED: "The task's required fields were not all supplied.",
  FORBIDDEN: "Your Jira access does not allow this change.",
  OPERATION_IN_PROGRESS: "There is already a change in flight for this task.",
  JIRA_UNAVAILABLE: "Jira could not be reached; the change may or may not have been applied.",
  STORE_UNAVAILABLE: "The change could not be recorded before the response."
};

const EDIT_FIELDS = ["summary", "assignee", "priority", "dueDate", "labels"] as const;
export const commandPayloadHash = (input: unknown): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");

const commandIntentError = (fieldErrors: Record<string, string>): void => {
  if (Object.keys(fieldErrors).length) throw new CommandRejection(400, "INVALID_BODY", fieldErrors);
};

export function parseCommandIdentity(url: URL, ifMatchRaw: string | undefined, idempotencyRaw: string | undefined,
  body: Record<string, unknown>): { ifMatch: string; idempotencyKey: string; intentId: string } {
  if (url.search) throw new CommandRejection(400, "INVALID_BODY", {}, {});
  let fieldErrors: Record<string, string> = {};
  const ifMatch = `${ifMatchRaw ?? ""}`.replace(/^W\//, "").replaceAll(`"`, "").trim();
  if (!ifMatch) throw new CommandRejection(428, "PRECONDITION_REQUIRED");
  const idempotencyKey = idempotencyRaw ?? "";
  if (!idempotencyKey) {
    fieldErrors = { ...fieldErrors, idempotencyKey: "An Idempotency-Key header is required." };
  }
  const intentId = `${body.clientIntentId ?? ""}`;
  if (typeof body.clientIntentId !== "string" || intentId.length > 128) {
    fieldErrors = { ...fieldErrors, clientIntentId: "A clientIntentId backs the operation on retries." };
  }
  commandIntentError(fieldErrors);
  return { ifMatch, idempotencyKey, intentId };
}

export interface EditFields { summary?: string; assignee?: string | null; priority?: string | null; dueDate?: string | null; labels?: string[] }

export const parseEditFields = (body: Record<string, unknown>): EditFields => {
  const fields = body.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new CommandRejection(400, "INVALID_BODY", { fields: "A fields object carries the allowed edits." });
  const entries = Object.entries(fields as Record<string, unknown>);
  if (!entries.length) throw new CommandRejection(400, "INVALID_BODY", { fields: "Include at least one field to change." });
  const fieldErrors: Record<string, string> = {};
  const allowed: EditFields = {};
  for (const [name, value] of entries) {
    if (!EDIT_FIELDS.includes(name as (typeof EDIT_FIELDS)[number])) {
      fieldErrors[name] = name === "status" ? "Move a task through its transitions, not by editing fields." : "This field is not editable here.";
      continue;
    }
    if (name === "summary") {
      if (typeof value !== "string" || !value.trim()) { fieldErrors.summary = "Give a summary of 1-250 characters."; continue; }
      if (value.trim().length > 250) { fieldErrors.summary = "Keep the summary under 250 characters."; continue; }
      allowed.summary = value.trim();
    } else if (name === "dueDate") {
      if (value === null) { allowed.dueDate = null; continue; }
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !validCommandDate(value)) { fieldErrors.dueDate = "Use a real calendar date (YYYY-MM-DD)."; continue; }
      allowed.dueDate = value;
    } else if (name === "labels") {
      if (value === null || (Array.isArray(value) && value.length === 0)) { allowed.labels = []; continue; }
      if (!Array.isArray(value) || !value.every(item => typeof item === "string" && /^[a-z0-9 _.-]{1,80}$/i.test(item))) { fieldErrors.labels = "Labels are short words or lowercase phrases."; continue; }
      allowed.labels = [...new Set(value.map(item => item.replace(/\s+/g, "-")))]; 
    } else {
      if (value === null) { allowed[name as "assignee" | "priority"] = null; continue; }
      if (typeof value !== "string" || value.trim().length > 320) { fieldErrors[name] = "Give one name, or null to clear the field."; continue; }
      allowed[name as "assignee" | "priority"] = value.trim();
    }
  }
  commandIntentError(fieldErrors);
  return allowed;
};
const validCommandDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export interface TransitionCommand { transitionId: string; fields: Record<string, string> }

export const parseTransitionCommand = (body: Record<string, unknown>): TransitionCommand => {
  const fieldErrors: Record<string, string> = {};
  const transitionId = `${body.transitionId ?? ""}`;
  if (!transitionId) fieldErrors.transitionId = "Choose one of the task's legal transitions.";
  const rawFields = body.fields;
  if (rawFields !== undefined && (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields) ||
    Object.entries(rawFields).some(([_name, value]) => typeof value !== "string" || value.trim() === ""))) {
    fieldErrors.fields = "Transition fields are nonempty strings.";
  }
  commandIntentError(fieldErrors);
  return { transitionId, fields: rawFields && typeof rawFields === "object" ? rawFields as Record<string, string> : {} };
};

export const revisionOf = (version: number): string => `task-r${version}`;
export const parseRevision = (raw: string): number | undefined => {
  const match = /^task-r(\d+)$/.exec(raw);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? Number(match[1]) : undefined;
};

export interface TransitionFieldMeta { readonly id: string; readonly name: string; readonly type: string; readonly required: boolean; readonly supported: boolean; readonly allowedValues?: ReadonlyArray<{ readonly id: string; readonly name: string }> }
export interface TransitionMeta { readonly id: string; readonly name: string; readonly target: { readonly name: string; readonly category: "new" | "indeterminate" | "done" }; readonly fields: ReadonlyArray<TransitionFieldMeta> }

/** The exact status spellings the mock corpus carries; a done task has no legal moves in the demo workflow. */
export type DemoStatus = "open" | "in progress" | "in review" | "blocked" | "Released" | "released";
const doneTransition: TransitionMeta = { id: "31", name: "Done", target: { name: "released", category: "done" },
  fields: [{ id: "resolutionId", name: "Resolution", type: "option", required: true, supported: true, allowedValues: [{ id: "1", name: "Done" }] }] };

export const DEMO_WORKFLOW: ReadonlyArray<{ readonly status: DemoStatus; readonly transitions: ReadonlyArray<TransitionMeta> }> = [
  { status: "open", transitions: [
    { id: "21", name: "Start progress", target: { name: "in progress", category: "indeterminate" }, fields: [] }, doneTransition] },
  { status: "in progress", transitions: [
    { id: "41", name: "Back to open", target: { name: "open", category: "new" }, fields: [] },
    { id: "51", name: "Start review", target: { name: "in review", category: "indeterminate" }, fields: [] }, doneTransition,
    { id: "91", name: "Release", target: { name: "released", category: "done" }, fields: [] }] },
  { status: "in review", transitions: [
    { id: "41", name: "Back to open", target: { name: "open", category: "new" }, fields: [] },
    { id: "61", name: "Block", target: { name: "blocked", category: "indeterminate" }, fields: [] }, doneTransition] },
  { status: "blocked", transitions: [
    { id: "71", name: "Unblock", target: { name: "in progress", category: "indeterminate" }, fields: [] }] }
];
export const demoWorkflow = (status: unknown): ReadonlyArray<TransitionMeta> =>
  (DEMO_WORKFLOW.find(entry => entry.status === status)?.transitions ?? []);
export interface CommandIntent { readonly ifMatch: string; readonly idempotencyKey: string; readonly intentId: string }

export type TransitionChoices =
  | { readonly status: "unavailable" }
  | { readonly status: "found"; readonly revision: string; readonly transitions: ReadonlyArray<TransitionMeta> };

export type CommandResult =
  | { readonly status: "unavailable" }
  | { readonly status: "forbidden" }
  | { readonly status: "refused"; readonly rejection: CommandRejection }
  | { readonly status: "uncertain"; readonly operation: CommandOperation }
  | { readonly status: "rejected"; readonly operation: CommandOperation; readonly fieldErrors: Record<string, string> }
  | { readonly status: "applied"; readonly operation: CommandOperation; readonly fields: Record<string, unknown>; readonly document?: SourceDocument };
