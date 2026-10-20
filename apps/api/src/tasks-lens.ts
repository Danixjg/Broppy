/** Pure math for the task list: filters, presets, sorts, paging, columns, summary and date/category truth.
 *  No imports. Rows arrive pre-authorized and parsed, so no document, URL or JSON type enters here.
 *  Counts never run over a page: callers pass the whole authorized row set and take totals from lengths. */

export type JiraStatusCategory = "new" | "indeterminate" | "done";

/** One pre-authorized, privacy-clean task row. There is no assignee field: that state is unrepresentable.
 *  Rows are constructed only by assembleSnapshot(); every consumer treats them as already authorized. */
export interface TaskRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;        // v1: equals the key; a real name needs §14.1's field extension
  readonly status: string;             // display name as Jira reported; "" renders as Unnamed
  readonly category: JiraStatusCategory | undefined;  // undefined joins the Unmapped column
  readonly dueDate: string | null;     // strict YYYY-MM-DD, or null (explicit no-date fallback)
  readonly priority: string | null;
  readonly priorityRank: number | null;  // static Highest→Lowest = 5..1; unknown priority sorts last
  readonly updatedAt: string;
  readonly url: string;
  readonly mine: boolean;              // derived from taskStore task links at build time
}

export type View = "board" | "list" | "personal";
export type Due = "any" | "today" | "throughToday" | "thisWeek" | "overdue" | "none";
export type SummaryPreset = "open" | "dueThisWeek" | "overdue" | "doneThisWeek";
export type Sort = "dueAsc" | "updatedDesc" | "priorityDesc" | "keyAsc";

/** Validated query values, parse-at-boundary output. `q` holds lowercased tokens; all must match somewhere. */
export interface TaskQuery {
  readonly view: View;
  readonly projectIds: readonly string[];
  readonly statusIds: readonly string[];
  readonly priorityIds: readonly string[];
  readonly mine: boolean;
  readonly due: Due;
  readonly summaryPreset?: SummaryPreset;
  readonly q: readonly string[];
  readonly sort: Sort;
  readonly timezone: string;
  readonly limit: number;
}

/** Honest in-memory data generation: sync watermark + row count + max version + permission-mutation epoch. */
export interface DataGeneration {
  readonly id: string;
  readonly observedAt: string;
  readonly dataComplete: boolean;
}

/** The full authorized row set of one data generation. Every count, option and page derives from `rows`. */
export interface TaskSnapshot {
  readonly gen: DataGeneration;
  readonly rows: readonly TaskRow[];
  readonly builtAt: string;
}

export interface Summary {
  readonly open: number;
  readonly dueThisWeek: number;
  readonly overdue: number;
  readonly doneThisWeek: { readonly knownCount: number; readonly historyComplete: boolean };
}

export interface BoardColumn {
  readonly id: "todo" | "in-progress" | "done" | "unmapped";
  readonly name: string;
  readonly rows: readonly TaskRow[];
}

const DAY = 86_400_000;
const CATEGORIES: readonly JiraStatusCategory[] = ["new", "indeterminate", "done"];
const COLUMN_DEFS: ReadonlyArray<{ readonly id: BoardColumn["id"]; readonly name: string; readonly category: JiraStatusCategory | undefined }> = [
  { id: "todo", name: "To do", category: "new" },
  { id: "in-progress", name: "In progress", category: "indeterminate" },
  { id: "done", name: "Done", category: "done" },
  { id: "unmapped", name: "Unmapped", category: undefined }
];

// Jira's standard priorities rank 1..5. A site with custom priority names relies on no fabricated rank.
const PRIORITY_RANKS: Record<string, number> = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };

export function priorityRank(priority: string | null): number | null {
  return priority && PRIORITY_RANKS[priority] !== undefined ? PRIORITY_RANKS[priority] : null;
}

export function statusCategoryOf(metadata: { readonly [key: string]: string | undefined }): JiraStatusCategory | undefined {
  return CATEGORIES.includes(metadata.statusCategory as JiraStatusCategory) ? metadata.statusCategory as JiraStatusCategory : undefined;
}

// Legacy corpus rows carry only status names. Live data lands here only through `liveMode:false`, because its own
// metadata.statusCategory is the truth and an Unmapped column is more honest than a guessed one.
const NAME_CATEGORIES: ReadonlyArray<readonly [categories: JiraStatusCategory, names: string[]]> = [
  ["new", ["to do", "todo", "open", "backlog", "selected for development", "reopened", "new"]],
  ["indeterminate", ["in progress", "in development", "in review", "review", "code review", "indeterminate"]],
  ["done", ["done", "closed", "resolved", "completed", "released"]]
];

export function nameCategory(statusName: string): JiraStatusCategory | undefined {
  const name = statusName.trim().toLowerCase();
  for (const [category, names] of NAME_CATEGORIES) if (names.includes(name)) return category;
  return undefined;
}

export function categoryOf(metadata: { readonly [key: string]: string | undefined }, liveMode: boolean): JiraStatusCategory | undefined {
  return statusCategoryOf(metadata) ?? (liveMode ? undefined : nameCategory(metadata.status ?? ""));
}

/** The viewer's local calendar date at `now`, as YYYY-MM-DD, from the Intl platform only. */
export function localToday(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const byType: Record<string, string> = {};
  for (const part of parts.formatToParts(now)) if (part.type !== "literal") byType[part.type] = part.value;
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/** The local Monday–Sunday interval containing `today`. Date-only arithmetic; boundaries need no timezone. */
export function localWeekBounds(today: string): { monday: string; sunday: string } {
  const [year, month, day] = today.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const offset = (new Date(utc).getUTCDay() + 6) % 7;
  return { monday: isoDate(utc - offset * DAY), sunday: isoDate(utc - offset * DAY + 6 * DAY) };
}

function isoDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function dueOverdue(due: string | null, today: string): boolean {
  return due !== null && due < today;
}

export function dueInWeek(due: string | null, bounds: { monday: string; sunday: string }): boolean {
  return due !== null && due >= bounds.monday && due <= bounds.sunday;
}

/** All explicit filter-bar filters composed. `due` needs `now` because its periods are date-relative. */
export function filterRows(rows: readonly TaskRow[], query: TaskQuery, now: Date): readonly TaskRow[] {
  const today = localToday(now, query.timezone);
  return rows.filter(row =>
    (query.projectIds.length === 0 || query.projectIds.includes(row.projectKey)) &&
    (query.statusIds.length === 0 || query.statusIds.includes(row.status)) &&
    (query.priorityIds.length === 0 || (row.priority !== null && query.priorityIds.includes(row.priority))) &&
    (!query.mine || row.mine) &&
    dueMatches(query.due, row.dueDate, today) &&
    matchesTokens(row, query.q)
  );
}

function dueMatches(due: Due, rowDue: string | null, today: string): boolean {
  switch (due) {
    case "any": return true;
    case "today": return rowDue === today;
    case "throughToday": return rowDue !== null && rowDue <= today;
    case "thisWeek": return dueInWeek(rowDue, localWeekBounds(today));
    case "overdue": return dueOverdue(rowDue, today);
    case "none": return rowDue === null;
  }
}

function matchesTokens(row: TaskRow, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [row.key, row.title, row.projectKey, row.projectName].join(" ").toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

/** A summary-tile preset narrows the displayed rows only; tile totals still come from the pre-preset set. */
export function presetRows(rows: readonly TaskRow[], preset: SummaryPreset, query: TaskQuery, now: Date): readonly TaskRow[] {
  const today = localToday(now, query.timezone);
  const bounds = localWeekBounds(today);
  const isOpen = (row: TaskRow) => row.category !== "done";
  switch (preset) {
    case "open": return rows.filter(row => isOpen(row));
    case "dueThisWeek": return rows.filter(row => isOpen(row) && dueInWeek(row.dueDate, bounds));
    case "overdue": return rows.filter(row => isOpen(row) && dueOverdue(row.dueDate, today));
    case "doneThisWeek": return rows.filter(row => row.category === "done");
  }
}

/** Total orders ending in the unique key, so equal sort keys rebuild to an identical page.
 *  Ordering: due date ascending with no-date last, then priority rank, then issue key. */
export function sortRows(rows: readonly TaskRow[], sort: Sort): readonly TaskRow[] {
  const byKey = (a: TaskRow, b: TaskRow) => a.key.localeCompare(b.key);
  const byPriority = (a: TaskRow, b: TaskRow) => (b.priorityRank ?? -Infinity) - (a.priorityRank ?? -Infinity);
  return [...rows].sort((a, b) => {
    switch (sort) {
      case "dueAsc": return dueOrder(a.dueDate, b.dueDate) || byPriority(a, b) || byKey(a, b);
      case "updatedDesc": return (updatedMs(b.updatedAt) - updatedMs(a.updatedAt)) || byKey(a, b);
      case "priorityDesc": return byPriority(a, b) || byKey(a, b);
      case "keyAsc": return byKey(a, b);
    }
  });
}

function dueOrder(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function updatedMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function pageOf(rows: readonly TaskRow[], limit: number,
  offset: number): { items: readonly TaskRow[]; hasMore: boolean; nextOffset: number } {
  return { items: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length, nextOffset: offset + limit };
}

/** All four columns, in fixed order, so a column is present even when empty; a row never vanishes. */
export function columnize(rows: readonly TaskRow[]): readonly BoardColumn[] {
  return COLUMN_DEFS.map(({ id, name, category }) => ({ id, name, rows: rows.filter(row => row.category === category) }));
}

/** Tile definitions. F is the caller's explicit-filter set; a preset never redefines another tile. */
export function summarize(rows: readonly TaskRow[], query: TaskQuery, now: Date): Summary {
  const today = localToday(now, query.timezone);
  const bounds = localWeekBounds(today);
  const open = rows.filter(row => row.category !== "done");
  return {
    open: open.length,
    dueThisWeek: open.filter(row => dueInWeek(row.dueDate, bounds)).length,
    overdue: open.filter(row => dueOverdue(row.dueDate, today)).length,
    doneThisWeek: { knownCount: 0, historyComplete: false }
  };
}
