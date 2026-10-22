// Pure helpers for the workspace surface: the words a document carries, the sentences an answer quotes,
// and the choices the panels make. Nothing here touches the page or the API, so node checks it
// (workspace.nodecheck.js).

import { dayText } from "./tasks.js";

export const LIST_LIMIT = 8;

const sourceNames = { slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Drive" };

export const sourceName = source => sourceNames[source] || "Source";
export const safeText = value => typeof value === "string" ? value : "";
export const documentStatus = doc => safeText(doc?.metadata?.status) || "source";
export const taskIsDone = doc => doc?.metadata?.statusCategory ? doc.metadata.statusCategory === "done"
  : documentStatus(doc).toLowerCase() === "done";
export const sentencesOf = text => safeText(text).split(/\n|(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);

/** A link a browser may follow: https, and nothing else. */
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** The items to show, and how many wait behind the "Show more" button. */
/**
 * @template T
 * @param {T[]} items
 * @param {boolean} expanded
 * @param {number} [limit]
 * @returns {{ shown: T[], hidden: number }}
 */
export function visibleItems(items, expanded, limit = LIST_LIMIT) {
  const shown = expanded || items.length <= limit ? items : items.slice(0, limit);
  return { shown, hidden: items.length - shown.length };
}

/** The button's label, naming what it shows, so each list's button makes sense on its own. */
export function showMoreLabel(hidden, noun) {
  return `Show ${hidden} more ${noun}${hidden === 1 ? "" : "s"}`;
}

/** The project on screen if this person may still open it, else the one they chose last, else their first. */
export function chosenProject(current, saved, keys) {
  const allowed = key => key === "" || keys.includes(key);
  if (current !== null && allowed(current)) return current;
  if (saved !== null && allowed(saved)) return saved;
  return keys[0] ?? "";
}

/** The Jira issue a task link names, by its own id, by its key, or by its title. */
export function linkedTask(documents, value) {
  if (typeof value !== "string" || !value) return undefined;
  return documents.find(doc => doc.source === "jira" && (doc.docId === value || doc.docId === `jira:${value}` ||
    doc.title === value || doc.title.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, "") === value));
}

/** Where the answer looked first and the dates it kept to, when the question named them, and the project it kept to. */
export function scopeText(scope) {
  const names = Array.isArray(scope?.sources) ? scope.sources.map(sourceName).join(" and ") : "";
  const dates = scope?.from && scope?.to ? `${dayText(scope.from)} – ${dayText(scope.to)}` : "";
  const project = safeText(scope?.project) ? `Kept to ${safeText(scope.project)}.` : "";
  const searched = names && dates ? `Searched ${names} (${dates}) first, then the other sources at any date.` :
    names ? `Searched ${names} first, then the other sources.` : dates ? `Searched everything from ${dates}.` : "";
  return [project, searched].filter(Boolean).join(" ");
}

/** What to highlight in a line's source: a copied line's own words, or the sentences that back a reworded one. */
export const quotesOf = line => line.kind === "reworded" && line.support?.length ? line.support : [line.text];

/** Reviewed fields Jira went without, said plainly so the person can set them in Jira. */
export function omittedNotes(omitted) {
  const list = Array.isArray(omitted) ? omitted : [];
  if (!list.length) return [];
  return [list.includes("owner") ? "No owner was set in Jira: we couldn't match them to a Jira account it would accept." : "",
    list.includes("due date") ? "No due date was set: Jira didn't accept one for this project." : "", "Set it in Jira."].filter(Boolean);
}

/** The words the search box looks for in a document. */
export function searchMatches(doc, term) {
  const needle = safeText(term).trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = `${doc.title} ${doc.source} ${safeText(doc.content)} ${safeText(doc.metadata?.status)} ${safeText(doc.metadata?.project)}`
    .toLocaleLowerCase();
  return haystack.includes(needle);
}
