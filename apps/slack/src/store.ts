import { createHash, randomUUID } from "node:crypto";
import { SAME_TASK, similarity } from "./fingerprint.js";
import type { Suggestion } from "./blocks.js";

export interface Proposal {
  id: string;
  revision: number;
  suggestion: Suggestion;
  teamId?: string;
  authorSlackId?: string;
  permalink?: string;
  reviewerSlackId?: string;
  status: "pending" | "dismissed" | "linked" | "created";
  issueKey?: string;
  issueUrl?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  operationId?: string;
}

export interface TaskLink {
  fingerprint: string;
  titleFingerprint?: string;
  project: string;
  title: string;
  tokens: string[];
  issueKey: string;
  issueUrl: string;
  assigneeSlackId: string;
  trackedBy: string;
  channel: string;
  messageTs: string;
  mentionCount: number;
  threadTs?: string;
  teamId?: string;
  authorSlackId?: string;
  permalink?: string;
  operationId?: string;
}
export type OperationState = "reserved" | "creating" | "remote_succeeded" | "linked" | "notifying" | "notified" | "uncertain" | "refused";
export interface TaskOperation {
  id: string;
  project: string;
  fingerprint: string;
  proposalId: string;
  proposalRevision: number;
  proposal: Proposal;
  actorSlackId: string;
  state: OperationState;
  existing: boolean;
  kind?: "create" | "link";
  issueKey?: string;
  issueUrl?: string;
  messageTs?: string;
}
export interface CompletionObservation { statusCategory: "new" | "indeterminate" | "done"; providerVersion: string }
export interface FeedbackOperation {
  id: string;
  link: TaskLink;
  providerVersion: string;
  state: "pending" | "sending" | "delivered" | "uncertain";
  messageTs?: string;
}
export interface TaskStore {
  findTask(project: string, fingerprint: string, tokens: string[], teamId?: string): Promise<TaskLink | undefined>;
  candidates(project: string, fingerprint: string, tokens: string[], teamId?: string): Promise<TaskLink[]>;
  listTasks(limit?: number, teamId?: string): Promise<TaskLink[]>;
  saveTask(link: TaskLink): Promise<void>;
  recordRepeat(link: TaskLink, channel: string, messageTs: string): Promise<void>;
  listProposals(): Promise<Proposal[]>;
  getProposal(id: string): Promise<Proposal | undefined>;
  saveProposal(proposal: Proposal, expectedRevision?: number): Promise<boolean>;
  completeProposal(id: string, expectedRevision: number, operationId: string, reviewedBy: string, reviewedAt: string): Promise<Proposal | undefined>;
  reserveOperation(proposal: Proposal, actorSlackId: string, existing?: TaskLink): Promise<TaskOperation | undefined>;
  reserveLinkOperation(proposal: Proposal, actorSlackId: string, existing: TaskLink): Promise<TaskOperation | undefined>;
  getOperation(id: string): Promise<TaskOperation | undefined>;
  advanceOperation(id: string, expected: OperationState, patch: Partial<TaskOperation>): Promise<TaskOperation | undefined>;
  observeCompletion(link: TaskLink, observation: CompletionObservation): Promise<void>;
  pendingFeedback(limit?: number, teamId?: string): Promise<FeedbackOperation[]>;
  advanceFeedback(id: string, expected: FeedbackOperation["state"], patch: Partial<FeedbackOperation>): Promise<FeedbackOperation | undefined>;
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export function bestMatch(links: TaskLink[], project: string, fingerprint: string, _tokens: string[]): TaskLink | undefined {
  return links.find(link => link.project === project && (link.fingerprint === fingerprint || (link.titleFingerprint ?? makeFingerprint(link.project, link.title)) === fingerprint));
}
const copy = <T>(value: T): T => structuredClone(value);
const sourceKey = (proposal: Proposal) => JSON.stringify([proposal.teamId ?? "", proposal.suggestion.c, proposal.suggestion.ts]);
export function proposalId(channel: string, messageTs: string, teamId = ""): string {
  const hash = createHash("sha256").update(JSON.stringify([teamId, channel, messageTs])).digest();
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const commitmentFingerprint = (id: string): string => createHash("sha256").update(JSON.stringify(["commitment", id])).digest("hex");

export class MemoryTaskStore implements TaskStore {
  readonly links: TaskLink[] = [];
  readonly sightings = new Map<string, { channel: string; messageTs: string }[]>();
  private readonly claims = new Set<string>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly operations = new Map<string, TaskOperation>();
  private readonly legacyFences = new Set<string>();
  private readonly observations = new Map<string, CompletionObservation>();
  private readonly polled = new Map<string, number>();
  private pollSequence = 0;
  private readonly feedback = new Map<string, FeedbackOperation>();
  async findTask(project: string, fingerprint: string, words: string[], teamId?: string) { const found = bestMatch(this.links.filter(link => !teamId || link.teamId === teamId), project, fingerprint, words); return found && copy(found); }
  async candidates(project: string, _fingerprint: string, words: string[], teamId?: string) {
    return copy([...new Map(this.links.filter(link => (!teamId || link.teamId === teamId) && link.project === project && similarity(link.tokens, words) >= SAME_TASK).map(link => [link.issueKey, link])).values()].slice(0, 3));
  }
  async listTasks(limit = 50, teamId?: string) { return copy(this.links.filter(link => !teamId || link.teamId === teamId).sort((a, b) => (this.polled.get(`${a.project}:${a.fingerprint}`) ?? 0) - (this.polled.get(`${b.project}:${b.fingerprint}`) ?? 0)).slice(0, limit)); }
  async saveTask(link: TaskLink) {
    if (!this.links.some(stored => stored.project === link.project && stored.fingerprint === link.fingerprint)) this.links.push(copy({ ...link, titleFingerprint: link.titleFingerprint ?? makeFingerprint(link.project, link.title) }));
  }
  async recordRepeat(link: TaskLink, channel: string, messageTs: string) {
    if (link.channel === channel && link.messageTs === messageTs) return;
    const key = `${link.project}:${link.fingerprint}`;
    const sightings = this.sightings.get(key) ?? [];
    if (sightings.some(s => s.channel === channel && s.messageTs === messageTs)) return;
    sightings.push({ channel, messageTs });
    this.sightings.set(key, sightings);
    const stored = this.links.find(l => l.project === link.project && l.fingerprint === link.fingerprint);
    if (stored) stored.mentionCount += 1;
  }
  async listProposals() { return copy([...this.proposals.values()]); }
  async getProposal(id: string) { const p = this.proposals.get(id); return p && copy(p); }
  async saveProposal(proposal: Proposal, expectedRevision?: number) {
    const current = this.proposals.get(proposal.id);
    if (expectedRevision === undefined) {
      if (current || [...this.proposals.values()].some(p => sourceKey(p) === sourceKey(proposal)) || proposal.revision !== 1) return false;
    } else {
      if (!current || current.revision !== expectedRevision || proposal.revision !== expectedRevision + 1) return false;
      if (current.status !== "pending" || sourceKey(current) !== sourceKey(proposal)) return false;
      if ([...this.operations.values()].some(op => op.proposalId === proposal.id && (op.state !== "refused" || op.issueKey))) return false;
      if (current.teamId !== proposal.teamId || current.authorSlackId !== proposal.authorSlackId || current.permalink !== proposal.permalink || current.reviewerSlackId !== proposal.reviewerSlackId || current.suggestion.s !== proposal.suggestion.s || current.suggestion.th !== proposal.suggestion.th) return false;
    }
    for (const [id, op] of this.operations) if (op.proposalId === proposal.id && op.state === "refused" && !op.issueKey) this.operations.delete(id);
    this.proposals.set(proposal.id, copy(proposal)); return true;
  }
  async completeProposal(id: string, expectedRevision: number, operationId: string, reviewedBy: string, reviewedAt: string) {
    const p = this.proposals.get(id); const op = this.operations.get(operationId);
    if (!p || !op || p.status !== "pending" || p.revision !== expectedRevision || p.suggestion.p !== op.project
      || proposalFingerprint(p) !== op.fingerprint || !["remote_succeeded", "linked", "notifying", "notified"].includes(op.state) || !op.issueKey || !op.issueUrl
      || (op.proposalId === p.id && op.proposalRevision !== p.revision)) return undefined;
    const next: Proposal = { ...p, revision: p.revision + 1, status: op.existing || op.proposalId !== p.id ? "linked" : "created",
      issueKey: op.issueKey, issueUrl: op.issueUrl, operationId, reviewedBy, reviewedAt };
    this.proposals.set(id, next); return copy(next);
  }
  async reserveOperation(proposal: Proposal, actorSlackId: string, existing?: TaskLink) {
    if (existing) return this.reserveLinkOperation(proposal, actorSlackId, existing);
    const p = this.proposals.get(proposal.id);
    if (!p || p.revision !== proposal.revision || p.status !== "pending") return undefined;
    const linked = [...this.operations.values()].find(op => op.kind === "link" && op.proposalId === proposal.id);
    if (linked) return copy(linked);
    const fingerprint = proposalFingerprint(proposal);
    const fence = `${proposal.suggestion.p}:${fingerprint}`;
    if (this.claims.has(`track:${proposal.suggestion.c}:${proposal.suggestion.ts}`)) this.legacyFences.add(fence);
    const prior = [...this.operations.values()].find(op => op.kind !== "link" && op.project === proposal.suggestion.p && op.fingerprint === fingerprint);
    if (prior) {
      if (this.legacyFences.has(fence) && ["reserved", "refused"].includes(prior.state)) prior.state = "uncertain";
      return copy(prior);
    }
    const op: TaskOperation = { id: randomUUID(), project: proposal.suggestion.p, fingerprint, proposalId: proposal.id, proposalRevision: proposal.revision,
      proposal: copy(proposal), actorSlackId, state: this.legacyFences.has(fence) ? "uncertain" : "reserved", existing: false };
    this.operations.set(op.id, op); return copy(op);
  }
  async reserveLinkOperation(proposal: Proposal, actorSlackId: string, existing: TaskLink) {
    const p = this.proposals.get(proposal.id);
    if (!p || p.revision !== proposal.revision || p.status !== "pending") return undefined;
    const own = [...this.operations.values()].find(op => op.proposalId === proposal.id);
    if (own) {
      if (own.kind === "link") return own.proposalRevision === proposal.revision && own.issueKey === existing.issueKey ? copy(own) : undefined;
      if (own.state !== "refused" || own.issueKey) return undefined;
      this.operations.delete(own.id);
    }
    const op: TaskOperation = { id: randomUUID(), project: p.suggestion.p, fingerprint: proposalFingerprint(p), proposalId: p.id, proposalRevision: p.revision,
      proposal: copy(p), actorSlackId, state: "remote_succeeded", existing: true, kind: "link", issueKey: existing.issueKey, issueUrl: existing.issueUrl };
    this.operations.set(op.id, op); return copy(op);
  }
  async getOperation(id: string) { const op = this.operations.get(id); return op && copy(op); }
  async advanceOperation(id: string, expected: OperationState, patch: Partial<TaskOperation>) {
    const op = this.operations.get(id); if (!op || op.state !== expected) return undefined;
    if (op.kind === "link" && patch.state && ["reserved", "creating", "uncertain", "refused"].includes(patch.state)) return undefined;
    if (patch.state === "creating" && ["reserved", "refused"].includes(expected) && this.legacyFences.has(`${op.project}:${op.fingerprint}`)) { op.state = "uncertain"; return undefined; }
    const next = { ...op, ...patch, id: op.id }; this.operations.set(id, next); return copy(next);
  }
  async observeCompletion(link: TaskLink, observation: CompletionObservation) {
    const key = `${link.project}:${link.fingerprint}`;
    const previous = this.observations.get(key);
    this.observations.set(key, copy(observation));
    this.polled.set(key, ++this.pollSequence);
    if (!previous || previous.statusCategory === "done" || observation.statusCategory !== "done" || this.feedback.has(key)) return;
    this.feedback.set(key, { id: randomUUID(), link: copy(link), providerVersion: observation.providerVersion, state: "pending" });
  }
  async pendingFeedback(limit = 50, teamId?: string) { return copy([...this.feedback.values()].filter(f => f.state !== "delivered" && (!teamId || f.link.teamId === teamId)).slice(0, limit)); }
  async advanceFeedback(id: string, expected: FeedbackOperation["state"], patch: Partial<FeedbackOperation>) {
    const entry = [...this.feedback.entries()].find(([, f]) => f.id === id && f.state === expected); if (!entry) return undefined;
    const next = { ...entry[1], ...patch, id }; this.feedback.set(entry[0], next); return copy(next);
  }
  async claim(key: string) { if (this.claims.has(key)) return false; this.claims.add(key); return true; }
  async release(key: string) { this.claims.delete(key); }
}

import { fingerprint as makeFingerprint } from "./fingerprint.js";
const proposalFingerprint = (p: Proposal) => makeFingerprint(p.suggestion.p, p.suggestion.t);

export class SupabaseTaskStore implements TaskStore {
  constructor(private readonly orgId: string, private readonly url: string, private readonly key: string, private readonly transport: typeof fetch = fetch) {
    if (!orgId || new URL(url).protocol !== "https:") throw new Error("Invalid Supabase configuration");
  }
  private async request(path: string, method = "GET", data?: unknown, prefer?: string): Promise<any> {
    const response = await this.transport(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, { method,
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json", ...(prefer ? { prefer } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${response.status})`);
    const text = await response.text(); return text ? JSON.parse(text) : undefined;
  }
  private static fromRow(row: any): TaskLink {
    return { fingerprint: row.fingerprint, titleFingerprint: row.title_fingerprint, project: row.project, title: row.title, tokens: row.tokens, issueKey: row.issue_key, issueUrl: row.issue_url,
      assigneeSlackId: row.assignee_slack_id, trackedBy: row.tracked_by, channel: row.channel, messageTs: row.message_ts, mentionCount: row.mention_count,
      ...(row.source ?? {}), ...(row.operation_id ? { operationId: row.operation_id } : {}) };
  }
  private org() { return `org_id=eq.${encodeURIComponent(this.orgId)}`; }
  private teamFilter(teamId: string | undefined, field = "source->>teamId") { return teamId ? `&${field}=eq.${encodeURIComponent(teamId)}` : ""; }
  async findTask(project: string, fingerprint: string, _tokens: string[], teamId?: string) {
    const rows = await this.request(`slack_task_links?${this.org()}${this.teamFilter(teamId)}&project=eq.${encodeURIComponent(project)}&title_fingerprint=eq.${encodeURIComponent(fingerprint)}&order=created_at.asc&limit=1`);
    return rows?.[0] && SupabaseTaskStore.fromRow(rows[0]);
  }
  async candidates(project: string, _fingerprint: string, words: string[], teamId?: string) {
    const rows = await this.request(`slack_task_links?${this.org()}${this.teamFilter(teamId)}&project=eq.${encodeURIComponent(project)}&order=updated_at.desc&limit=500`);
    return [...new Map((rows as any[]).map(SupabaseTaskStore.fromRow).filter(l => similarity(l.tokens, words) >= SAME_TASK).map(l => [l.issueKey, l])).values()].slice(0, 3);
  }
  async listTasks(limit = 50, teamId?: string) { const rows = await this.request(`slack_task_links?${this.org()}${this.teamFilter(teamId)}&order=updated_at.asc&limit=${Math.min(100, Math.max(1, limit))}`); return rows.map(SupabaseTaskStore.fromRow); }
  async saveTask(link: TaskLink) {
    await this.request("slack_task_links?on_conflict=org_id,project,fingerprint", "POST", { org_id: this.orgId, fingerprint: link.fingerprint, title_fingerprint: link.titleFingerprint ?? makeFingerprint(link.project, link.title), project: link.project, title: link.title,
      tokens: link.tokens, issue_key: link.issueKey, issue_url: link.issueUrl, assignee_slack_id: link.assigneeSlackId, tracked_by: link.trackedBy, channel: link.channel,
      message_ts: link.messageTs, mention_count: link.mentionCount, operation_id: link.operationId,
      source: { threadTs: link.threadTs, teamId: link.teamId, authorSlackId: link.authorSlackId, permalink: link.permalink } }, "resolution=ignore-duplicates");
  }
  async recordRepeat(link: TaskLink, channel: string, messageTs: string) {
    await this.request("rpc/record_slack_task_repeat", "POST", { organization: this.orgId, project_key: link.project, task_fingerprint: link.fingerprint, repeat_channel: channel, repeat_ts: messageTs });
  }
  async listProposals() { const rows = await this.request(`slack_task_proposals?${this.org()}&order=created_at.asc`); return rows.map((row: any) => row.payload as Proposal); }
  async getProposal(id: string) { const rows = await this.request(`slack_task_proposals?${this.org()}&id=eq.${encodeURIComponent(id)}&limit=1`); return rows?.[0]?.payload as Proposal | undefined; }
  async saveProposal(proposal: Proposal, expectedRevision?: number) {
    return await this.request("rpc/save_slack_proposal", "POST", { organization: this.orgId, proposal, expected_revision: expectedRevision ?? null }) === true;
  }
  async completeProposal(id: string, expectedRevision: number, operationId: string, reviewedBy: string, reviewedAt: string) {
    const p = await this.getProposal(id); if (!p || p.revision !== expectedRevision) return undefined;
    return await this.request("rpc/complete_slack_proposal", "POST", { organization: this.orgId, proposal_id: id, expected_revision: expectedRevision, operation_id: operationId, task_fingerprint: proposalFingerprint(p), reviewed_by: reviewedBy, reviewed_at: reviewedAt }) ?? undefined;
  }
  async reserveOperation(proposal: Proposal, actorSlackId: string, existing?: TaskLink) {
    if (existing) return this.reserveLinkOperation(proposal, actorSlackId, existing);
    return await this.request("rpc/reserve_slack_operation", "POST", { organization: this.orgId, proposal_id: proposal.id, expected_revision: proposal.revision,
      operation_id: randomUUID(), task_fingerprint: proposalFingerprint(proposal), actor_slack_id: actorSlackId, existing_issue: null }) ?? undefined;
  }
  async reserveLinkOperation(proposal: Proposal, actorSlackId: string, existing: TaskLink) {
    return await this.request("rpc/reserve_slack_link_operation", "POST", { organization: this.orgId, proposal_id: proposal.id, expected_revision: proposal.revision,
      operation_id: randomUUID(), task_fingerprint: proposalFingerprint(proposal), actor_slack_id: actorSlackId, existing_issue: { key: existing.issueKey, url: existing.issueUrl } }) ?? undefined;
  }
  async getOperation(id: string) {
    const path = `?${this.org()}&id=eq.${encodeURIComponent(id)}&limit=1`;
    const rows = await this.request(`slack_task_operations${path}`);
    if (rows?.[0]) return rows[0].payload as TaskOperation;
    const linked = await this.request(`slack_link_operations${path}`); return linked?.[0]?.payload as TaskOperation | undefined;
  }
  async advanceOperation(id: string, expected: OperationState, patch: Partial<TaskOperation>) {
    return await this.request("rpc/advance_slack_operation", "POST", { organization: this.orgId, operation_id: id, expected_state: expected, patch }) ?? undefined;
  }
  async observeCompletion(link: TaskLink, observation: CompletionObservation) {
    await this.request("rpc/observe_slack_completion", "POST", { organization: this.orgId, task_link: link, observation, delivery_id: randomUUID() });
  }
  async pendingFeedback(limit = 50, teamId?: string) { const rows = await this.request(`slack_completion_feedback?${this.org()}${this.teamFilter(teamId, "payload->link->>teamId")}&state=neq.delivered&order=created_at.asc&limit=${Math.min(100, Math.max(1, limit))}`); return rows.map((r: any) => r.payload as FeedbackOperation); }
  async advanceFeedback(id: string, expected: FeedbackOperation["state"], patch: Partial<FeedbackOperation>) {
    return await this.request("rpc/advance_slack_feedback", "POST", { organization: this.orgId, delivery_id: id, expected_state: expected, patch }) ?? undefined;
  }
  async claim(key: string) { const rows = await this.request("slack_claims?on_conflict=org_id,key", "POST", { org_id: this.orgId, key }, "resolution=ignore-duplicates,return=representation"); return Array.isArray(rows) && rows.length > 0; }
  async release(key: string) { await this.request(`slack_claims?${this.org()}&key=eq.${encodeURIComponent(key)}`, "DELETE"); }
}
