import type { AuditEntry, User } from "@brain/types";
export function searchAudit(entries: AuditEntry[], params: URLSearchParams, users: readonly User[], now = new Date()) {
  const question = params.get("q") ?? "";
  if (question.length > 500) throw new Error("Invalid query");
  const q = question.toLowerCase();
  const dates = q.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const date = (value: string | undefined, end = false) => {
    if (!value) return undefined;
    const stamp = Date.parse(value.length === 10 ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value);
    if (!Number.isFinite(stamp)) throw new Error("Invalid date");
    return stamp;
  };
  let from = date(params.get("from") ?? (q.includes("before ") ? undefined : dates[0]));
  let to = date(params.get("to") ?? dates[1] ?? (!q.includes("since ") && !q.includes("after ") ? dates[0] : undefined), true);
  if (!dates.length && !params.has("from") && !params.has("to")) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = /\blast (\d+) days?\b/.exec(q);
    if (/\byesterday\b/.test(q)) { from = midnight - 86400000; to = midnight - 1; }
    else if (/\btoday\b/.test(q)) { from = midnight; to = midnight + 86400000 - 1; }
    else if (/\blast week\b/.test(q)) { from = midnight - 7 * 86400000; to = now.getTime(); }
    else if (days) { from = midnight - Number(days[1]) * 86400000; to = now.getTime(); }
  }
  if (from !== undefined && to !== undefined && from > to) throw new Error("Invalid date range");
  const user = params.get("user") ?? users.find(user => [user.id, user.email, user.name.toLowerCase()].some(value =>
    q.split(/[^a-z0-9@._-]+/).includes(value.toLowerCase())))?.id;
  const source = params.get("source") ?? ["slack", "jira", "confluence", "drive"].find(source => q.includes(source));
  const spaces = [...new Set(entries.flatMap(e => [e.data.space, e.data.project]).filter((v): v is string => typeof v === "string"))];
  const space = params.get("space") ?? spaces.find(space => q.includes(space.toLowerCase()));
  const filters = { user, source, space, from: from === undefined ? undefined : new Date(from).toISOString(), to: to === undefined ? undefined : new Date(to).toISOString() };
  const matching = entries.filter(entry => {
    const time = Date.parse(entry.timestamp);
    return (!user || entry.actor === user) && (from === undefined || time >= from) && (to === undefined || time <= to);
  });
  const relevant = matching.filter(entry => (!source || entry.data.source === source) &&
    (!space || entry.data.space === space || entry.data.project === space));
  const traces = new Set(relevant.map(e => e.data.traceId).filter(Boolean));
  const allowed = /\b(denied|deny|rejected)\b/.test(q) ? false : /\b(allowed|allow|approved)\b/.test(q) ? true : undefined;
  const filtered = matching.filter(e => (relevant.includes(e) || traces.has(e.data.traceId)) && (allowed === undefined || e.data.allowed === allowed));
  const hasFilters = Object.values(filters).some(value => value !== undefined);
  return { filters, entries: hasFilters || !q ? filtered : filtered.filter(e => {
    const terms = q.match(/[a-z0-9_-]+/g) ?? [];
    const ignored = new Set(["show", "me", "all", "the", "events", "event", "for", "where", "were", "with", "by", "about"]);
    return terms.filter(t => !ignored.has(t)).every(t => {
      if (["denied", "deny", "rejected"].includes(t)) return e.data.allowed === false;
      if (["allowed", "allow", "approved"].includes(t)) return e.data.allowed === true;
      return `${e.type} ${e.actor} ${JSON.stringify(e.data)}`.toLowerCase().includes(t);
    });
  }) };
}
