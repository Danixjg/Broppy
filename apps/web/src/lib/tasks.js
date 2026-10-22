// Pure helpers for the Tasks view: the one query string, the one detail address, the words for absent
// fields, and header text built straight from the response. The browser never recounts, re-buckets or
// invents a value: counts travel verbatim, and a fallback word only states that a field was absent.

/**
 * @typedef {{ id: string, name: string, target?: { name?: string, category?: string },
 *   fields?: Array<{ id: string, name: string, required?: boolean, supported?: boolean,
 *     allowedValues?: Array<{ id: string, name: string }> }> }} TaskTransition
 * @typedef {{ kind: "none" } | { kind: "submit", transition: TaskTransition } | { kind: "pick" }} Drop
 */

export const FALLBACKS = {
  name: "Unnamed",
  dueDate: "No due date",
  priority: "No priority",
  column: "Unmapped"
};

const word = value => typeof value === "string" && value.trim() !== "";

// Present values pass through unchanged; only an absent field becomes a word.
export const nameText = value => (word(value) ? value.trim() : FALLBACKS.name);
export const dueText = value => (word(value) ? value.trim() : FALLBACKS.dueDate);
export const priorityText = value => (word(value) ? value.trim() : FALLBACKS.priority);

// Date-only strings order by calendar day, so a plain compare against today decides the urgency.
export function dueUrgency(dueDate, today) {
  if (!word(dueDate)) return "";
  if (dueDate === today) return "today";
  return dueDate < today ? "overdue" : "later";
}

// A calendar day in short words: "Nov 2". A date nobody can read says so rather than "Invalid Date".
export function dayText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

// A count that isn't there reads as empty, never as a zero claimed by the page.
export const countText = value => typeof value === "number" && Number.isFinite(value) ? String(value) : "–";

// Filter state and the task view become exactly one list query. Empty filters stay out of the string:
// an absent param is the API default, which is the only meaning this side claims.
/**
 * @param {string} view
 * @param {{projectIds?: string[], mine?: boolean, priority?: string, status?: string, due?: string, preset?: string, q?: string}} filters
 * @returns {URLSearchParams}
 */
export function taskQuery(view, filters = {}) {
  const params = new URLSearchParams();
  params.set("view", ["board", "personal"].includes(view) ? view : "list");
  const projects = (Array.isArray(filters.projectIds) ? filters.projectIds : []).map(value => `${value ?? ""}`.trim()).filter(Boolean);
  if (projects.length) params.set("projectIds", projects.join(","));
  for (const [field, key] of [["priority", "priorityIds"], ["status", "statusIds"],
    ["due", "due"], ["preset", "summaryPreset"]]) {
    const value = `${filters[field] ?? ""}`.trim();
    if (value && !(field === "due" && value === "any")) params.set(key, value);
  }
  if (filters.mine === true) params.set("mine", "true");
  const q = `${filters.q ?? ""}`.trim();
  if (q) params.set("q", q);
  return params;
}

// The detail address is the summary's key split into its own path segments, because the route is
// /v1/tasks/jira/KEY and a colon cannot ride inside a path segment. Anything else isn't a task address.
export function detailPath(docId) {
  const segments = `${docId ?? ""}`.split(":").map(segment => segment.trim()).filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "jira") return null;
  return `/v1/tasks/jira/${segments[1]}`;
}

// Jira's status category IS the board column id; a category the columns don't know falls to Unmapped.
/**
 * @param {TaskTransition[] | undefined} transitions
 * @returns {Map<string, TaskTransition[]>}
 */
export function movesByColumn(transitions) {
  const byColumn = new Map();
  for (const transition of Array.isArray(transitions) ? transitions : []) {
    if (!transition || typeof transition.id !== "string" || transition.id.trim() === "") continue;
    const column = { new: "todo", indeterminate: "in-progress", done: "done" }[transition.target?.category] ?? "unmapped";
    const moves = byColumn.get(column) ?? [];
    moves.push(transition);
    byColumn.set(column, moves);
  }
  return byColumn;
}

/**
 * @param {TaskTransition[] | undefined} moves
 * @returns {Drop}
 */
export function pickDrop(moves) {
  const list = Array.isArray(moves) ? moves : [];
  if (!list.length) return { kind: "none" };
  const single = list.length === 1 ? list[0] : null;
  if (single && !single.fields?.some(field => field?.required === true)) return { kind: "submit", transition: single };
  return { kind: "pick" };
}

// The header text behind the count tiles: numbers as the response reported them, and the done tile
// naming itself untracked when there is no completion history to count, instead of a bare zero.
export function countsText(summary = {}) {
  const done = summary.doneThisWeek ?? {};
  const doneCount = `${countText(done.knownCount)} done this week`;
  return [
    `${countText(summary.open)} open`,
    `${countText(summary.dueThisWeek)} due this week`,
    `${countText(summary.overdue)} overdue`,
    done.historyComplete === true ? doneCount : `${doneCount} · not tracked yet`
  ].join(" · ");
}

export function doneTileLabel(summary = {}) {
  const done = summary.doneThisWeek ?? {};
  return done.historyComplete === true || (done.knownCount ?? 0) > 0 ? "Done this week" : "Not tracked yet";
}

/**
 * @param {{[name: string]: string | null | undefined}} current
 * @param {{[name: string]: string | null | undefined}} values
 * @returns {{[name: string]: string | null | undefined}}
 */
export function changedFields(current = {}, values = {}) {
  const fields = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === current[name]) continue;
    fields[name] = value === "" ? null : value;
  }
  return fields;
}

// Task routes reject with one envelope, not the legacy error string. Field notes come with it, so one
// message carries everything the response said about a rejected query.
export function errorText(payload) {
  const error = payload && typeof payload === "object" ? payload.error : null;
  if (!error || typeof error !== "object") return "Request failed.";
  const fields = Object.entries(error.fieldErrors ?? {}).map(([field, message]) => `${field}: ${message}`);
  return [error.message ?? "The request was not valid.", ...fields].join(" ");
}
