import type { AuditEntry, User } from "@brain/types";
import { core } from "@brain/rust-core";

interface AuditDocument { docId: string; title: string }
interface Filters { user?: string; source?: string; space?: string; doc?: string; from?: string; to?: string }
interface Plan { q: string; filters: Filters; fromValue: string | null; toValue: string | null; window: { from: number; to: number } | null }

function date(value: string | null, end = false): number | undefined {
  if (!value) return undefined;
  const stamp = Date.parse(value.length === 10 ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  if (!Number.isFinite(stamp)) throw new Error("Invalid date");
  return stamp;
}

export function searchAudit(entries: AuditEntry[], params: URLSearchParams, users: readonly User[], now = new Date(),
  documents: readonly AuditDocument[] = []) {
  const traces = new Map<unknown, number>();
  const prepared = entries.map(entry => {
    const trace = entry.data.traceId;
    if (trace && !traces.has(trace)) traces.set(trace, traces.size);
    return { type: entry.type, actor: entry.actor, data: entry.data,
      timestamp: Date.parse(entry.timestamp), trace: trace ? traces.get(trace) : undefined };
  });
  const plan = core<Plan>("auditSearch.plan", {
    entries: prepared, params: Object.fromEntries(["q", "from", "to", "user", "source", "space", "doc"]
      .map(key => [key, params.get(key)])), users, documents, now: now.getTime()
  });
  const from = date(plan.fromValue) ?? plan.window?.from;
  const to = date(plan.toValue, true) ?? plan.window?.to;
  const indices = core<number[]>("auditSearch.search", {
    entries: prepared.map((entry, index) => ({ ...entry, payload: JSON.stringify(entries[index].data) })),
    q: plan.q, filters: plan.filters, from, to
  });
  const filters: Filters = { user: plan.filters.user, source: plan.filters.source, space: plan.filters.space,
    doc: plan.filters.doc, from: from === undefined ? undefined : new Date(from).toISOString(),
    to: to === undefined ? undefined : new Date(to).toISOString() };
  return { filters, entries: indices.map(index => entries[index]) };
}
