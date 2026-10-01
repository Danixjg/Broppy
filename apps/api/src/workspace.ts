import { queryTerms } from "@brain/retrieval";
import type { Source } from "@brain/types";

// What the workspace shows beside the documents: projects, the latest file, likely duplicates and task suggestions.
// Every function here reads only the documents the viewer may open, so nothing they can't see can show up.

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
}

const DAY = 86_400_000;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);

/**
 * One project per master page the viewer may open: a Confluence page labelled "master". Its items are what the page
 * links to, the issues, pages and channels tagged with its key, and the files and threads those issues link to.
 */
export function projectsFor(docs: readonly WorkspaceDocument[]): Project[] {
  const byId = new Map(docs.map(doc => [doc.docId, doc]));
  return docs.filter(doc => doc.source === "confluence" && doc.metadata.label === "master" && doc.metadata.space)
    .map(master => {
      const key = master.metadata.space;
      const members = new Set([master.docId, ...master.links]);
      for (const doc of docs) {
        if (doc.source === "confluence" ? doc.metadata.space === key : doc.source !== "drive" && doc.metadata.project === key) {
          members.add(doc.docId);
        }
      }
      for (const id of [...members]) {
        const doc = byId.get(id);
        if (doc?.source !== "jira") continue;
        for (const link of doc.links) if (["drive", "slack"].includes(byId.get(link)?.source ?? "")) members.add(link);
      }
      return { key, name: master.title.replace(/\s+master page$/i, ""), masterDocId: master.docId,
        docIds: [...members].filter(id => byId.has(id)).sort() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const STATUS_POINTS: Record<string, number> = { final: 40, "in review": 20, draft: 8 };

/** The "Latest" score of a file, with the reason for every point. */
export function latestScore(doc: WorkspaceDocument, now: Date, master?: WorkspaceDocument): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const status = STATUS_POINTS[doc.metadata.status] ?? 0;
  if (status) { score += status; reasons.push(`${doc.metadata.status} (+${status})`); }
  const age = Math.max(0, (now.getTime() - Date.parse(doc.updatedAt)) / DAY);
  const recency = Math.max(0, 30 - age);
  if (recency) {
    const days = Math.round(age);
    score += recency;
    reasons.push(`edited ${days ? `${days} day${days === 1 ? "" : "s"} ago` : "today"} (+${Math.round(recency)})`);
  }
  const version = Math.min(doc.version, 10);
  score += version;
  reasons.push(`version ${doc.version} (+${version})`);
  if (master?.links.includes(doc.docId)) { score += 15; reasons.push("linked to the master page (+15)"); }
  return { score: Math.round(score * 100) / 100, reasons };
}

/** The latest Drive file of all the viewer may open, and of each project. Superseded files never count. */
export function latestFor(docs: readonly WorkspaceDocument[], projects: readonly Project[], now: Date): Latest[] {
  const best = (files: readonly WorkspaceDocument[], master?: WorkspaceDocument) => files
    .filter(doc => doc.source === "drive" && doc.metadata.status !== "superseded")
    .map(doc => ({ docId: doc.docId, ...latestScore(doc, now, master) }))
    .sort((a, b) => b.score - a.score)[0];
  const all = best(docs);
  const latest: Latest[] = all ? [all] : [];
  for (const project of projects) {
    const found = best(docs.filter(doc => project.docIds.includes(doc.docId)), docs.find(doc => doc.docId === project.masterDocId));
    if (found) latest.push({ project: project.key, ...found });
  }
  return latest;
}

const normalizeTitle = (title: string) =>
  title.toLowerCase().replace(/\b(copy|draft|final|v\d+)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const normalizeSentence = (sentence: string) => sentence.toLowerCase().replace(/\s+/g, " ");

/**
 * Pairs of Drive files that look like the same document: the same title where one is superseded, or at least 60% of
 * their words shared. The file to keep is the one the Latest score prefers; a superseded file is never kept.
 */
export function duplicatesFor(docs: readonly WorkspaceDocument[], now: Date): Duplicate[] {
  const files = docs.filter(doc => doc.source === "drive");
  const words = new Map(files.map(doc => [doc.docId, new Set(queryTerms(doc.content))]));
  const pairs: Duplicate[] = [];
  for (const [index, a] of files.entries()) {
    for (const b of files.slice(index + 1)) {
      const superseded = [a, b].filter(doc => doc.metadata.status === "superseded");
      const reasons: string[] = [];
      if (superseded.length === 1 && normalizeTitle(a.title) === normalizeTitle(b.title)) reasons.push("same title");
      const wordsA = words.get(a.docId)!, wordsB = words.get(b.docId)!;
      const shared = [...wordsA].filter(word => wordsB.has(word)).length / (new Set([...wordsA, ...wordsB]).size || 1);
      if (shared >= 0.6) reasons.push(`${Math.round(shared * 100)}% of their words are shared`);
      if (!reasons.length || superseded.length === 2) continue;
      const [keep, other] = superseded.length ? (superseded[0] === a ? [b, a] : [a, b]) :
        latestScore(a, now).score >= latestScore(b, now).score ? [a, b] : [b, a];
      if (superseded.length) reasons.push("the other is marked superseded");
      const only = (from: WorkspaceDocument, than: WorkspaceDocument) => {
        const theirs = new Set(sentences(than.content).map(normalizeSentence));
        return sentences(from.content).filter(sentence => !theirs.has(normalizeSentence(sentence)));
      };
      pairs.push({ keep: keep.docId, other: other.docId, reasons, onlyInKeep: only(keep, other), onlyInOther: only(other, keep) });
    }
  }
  return pairs;
}

// Fixed phrases at the start of a sentence: predictable, free, and the card quotes the sentence it matched.
const AGREEMENT = /^(?:agreed[:,]|decision:|decided:|approved:|ok,? let's|let's go with)\s*/i;

/** The Jira project a thread belongs to: that of the issues it links to, else its own project tag. */
function projectOf(thread: WorkspaceDocument, issues: readonly WorkspaceDocument[]): string | undefined {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (thread.links.includes(issue.docId) && issue.metadata.project) {
      counts.set(issue.metadata.project, (counts.get(issue.metadata.project) ?? 0) + 1);
    }
  }
  const linked = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0];
  return linked ?? (issues.some(issue => issue.metadata.project === thread.metadata.project) ? thread.metadata.project : undefined);
}

/**
 * Agreements in threads the viewer may open that could become a Jira task in the thread's project, until a visible
 * issue quotes them. A task can be created here only on mock sources; with live ones, the project opens in Jira.
 */
export function agreementsFor(docs: readonly WorkspaceDocument[], live: boolean): Suggestion[] {
  const issues = docs.filter(doc => doc.source === "jira");
  const suggestions: Suggestion[] = [];
  for (const thread of docs.filter(doc => doc.source === "slack")) {
    const project = projectOf(thread, issues);
    if (!project) continue;
    for (const sentence of sentences(thread.content)) {
      const phrase = sentence.match(AGREEMENT)?.[0];
      const rest = phrase === undefined ? "" : sentence.slice(phrase.length).replace(/[.!?]+$/, "").trim();
      if (!rest || issues.some(issue => normalizeSentence(issue.content).includes(normalizeSentence(sentence)))) continue;
      const example = issues.find(issue => issue.metadata.project === project);
      suggestions.push({ threadDocId: thread.docId, sentence, project, summary: (rest[0].toUpperCase() + rest.slice(1)).slice(0, 80),
        canCreate: !live, ...(live && example ? { jiraUrl: example.url.replace(/\/browse\/[^/?#]+.*$/, `/browse/${project}`) } : {}) });
    }
  }
  return suggestions;
}
