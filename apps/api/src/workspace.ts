import { core } from "@brain/rust-core";
import type { AuditEntry, MerkleBatch, SlackMessageEvidence, Source, User } from "@brain/types";

/** A document the viewer may open, as the workspace sees it. */
export interface WorkspaceDocument {
  docId: string;
  source: Source;
  title: string;
  content: string;
  url: string;
  updatedAt: string;
  version: number;
  metadata: Record<string, string>;
  /** Items one link away, in either direction, that the viewer may also open. */
  links: string[];
  slackMessages?: SlackMessageEvidence[];
}

export interface Project { key: string; name: string; masterDocId: string; docIds: string[] }
export interface Latest { project?: string; docId: string; score: number; reasons: string[] }
export interface Duplicate { keep: string; other: string; reasons: string[]; onlyInKeep: string[]; onlyInOther: string[] }
export interface Suggestion {
  threadDocId: string;
  sentence: string;
  project: string;
  summary: string;
  /** False with live sources: the app only reads them, so the task is created in Jira itself. */
  canCreate: boolean;
  jiraUrl?: string;
  message?: SlackMessageEvidence;
}

const nativeDoc = (doc: WorkspaceDocument) => ({ ...doc, timestamp: Date.parse(doc.updatedAt) });
function projectOrder(docs: readonly WorkspaceDocument[]): string[][] {
  const keys = [...new Set(docs.map(doc => doc.metadata.project).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const groups: string[][] = [];
  for (const key of keys) {
    const group = groups.at(-1);
    if (group && group[0].localeCompare(key) === 0) group.push(key);
    else groups.push([key]);
  }
  return groups;
}
const summaryText = (rest: string) => (rest[0].toUpperCase() + rest.slice(1)).slice(0, 80);

export const sentences = (text: string): string[] => core("workspace.sentences", { text });

/**
 * One project per visible Confluence master page. Members include its links, items tagged with its key,
 * and visible files and threads linked from its Jira issues.
 */
export function projectsFor(docs: readonly WorkspaceDocument[]): Project[] {
  return core<Project[]>("workspace.projectsFor", { docs: docs.map(nativeDoc) })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The file's Latest score, with the reason for every point. */
export function latestScore(doc: WorkspaceDocument, now: Date, master?: WorkspaceDocument): { score: number; reasons: string[] } {
  return core("workspace.latestScore", { doc: nativeDoc(doc), now: now.getTime(), master: master && nativeDoc(master) });
}

/** The latest visible Drive file overall and per project. Superseded files never count. */
export function latestFor(docs: readonly WorkspaceDocument[], projects: readonly Project[], now: Date): Latest[] {
  return core("workspace.latestFor", { docs: docs.map(nativeDoc), projects, now: now.getTime() });
}

/**
 * Drive pairs with the same title where one is superseded, or at least 60% shared words.
 * Keeps the Latest score's preferred file and never keeps a superseded file.
 */
export function duplicatesFor(docs: readonly WorkspaceDocument[], now: Date): Duplicate[] {
  return core("workspace.duplicatesFor", { docs: docs.map(nativeDoc), now: now.getTime() });
}

/** An agreement's task summary, or undefined when the sentence does not begin with an agreement phrase. */
export function agreementSummary(sentence: string): string | undefined {
  const rest = core<string | null>("workspace.agreementSummary", { text: sentence });
  return rest === null ? undefined : summaryText(rest);
}

export function commitmentSummary(sentence: string): string | undefined {
  const rest = core<string | null>("workspace.commitmentSummary", { text: sentence });
  return rest === null ? undefined : summaryText(rest);
}

/** Whether a visible issue already quotes the sentence. */
export function tracked(sentence: string, issues: readonly WorkspaceDocument[]): boolean {
  return core("workspace.tracked", { text: sentence, issues: issues.map(nativeDoc) });
}

/** The project of linked Jira issues, else the thread's project tag if present among visible issues. */
export function projectOf(thread: WorkspaceDocument, issues: readonly WorkspaceDocument[]): string | undefined {
  return core<string | null>("workspace.projectOf", {
    doc: nativeDoc(thread), issues: issues.map(nativeDoc), projectOrder: projectOrder(issues)
  }) ?? undefined;
}

/** Batch projectOf results in thread order, sharing one linked-issue index. */
export function projectsOf(threads: readonly WorkspaceDocument[], issues: readonly WorkspaceDocument[]): Array<string | undefined> {
  return core<Array<string | null>>("workspace.projectsOf", {
    docs: threads.map(nativeDoc), issues: issues.map(nativeDoc), projectOrder: projectOrder(issues)
  }).map(project => project ?? undefined);
}

/** Visible agreements without an issue quoting them. Creation is available on mock sources; live sources open Jira. */
export function agreementsFor(docs: readonly WorkspaceDocument[], live: boolean): Suggestion[] {
  return core<Suggestion[]>("workspace.agreementsFor", {
    docs: docs.map(nativeDoc), live, projectOrder: projectOrder(docs.filter(doc => doc.source === "jira"))
  }).map(suggestion => ({ ...suggestion, summary: summaryText(suggestion.summary),
    ...(suggestion.jiraUrl ? { jiraUrl: suggestion.jiraUrl.replace(/\/browse\/[^/?#]+.*$/, `/browse/${suggestion.project}`) } : {}) }));
}

/** A question based on the viewer's role and groups. Compliance receives audit summaries instead. */
export function catchUpQuestion(person: Pick<User, "name" | "groups" | "role">, project?: Pick<Project, "name">): string | undefined {
  return core<string | null>("workspace.catchUpQuestion", { person, project }) ?? undefined;
}

/** Compliance's catch-up counts for the last seven days of the audit trail. */
export function auditSummary(entries: readonly AuditEntry[], batches: ReadonlyArray<Pick<MerkleBatch, "sealedAt">>,
  nameOf: (actor: string) => string, now: Date, verifies: boolean): string[] {
  const since = now.getTime() - 7 * 86_400_000;
  return core("workspace.auditSummary", {
    entries: entries.map(entry => ({ type: entry.type, timestamp: Date.parse(entry.timestamp),
      name: entry.type === "query_received" && Date.parse(entry.timestamp) >= since ? nameOf(entry.actor) : "",
      allowed: typeof entry.data.allowed === "boolean" ? entry.data.allowed : undefined })),
    batches: batches.map(batch => ({ timestamp: Date.parse(batch.sealedAt) })), now: now.getTime(), verifies
  });
}
