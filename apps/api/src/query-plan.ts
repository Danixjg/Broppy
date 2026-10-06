import type { Source } from "@brain/types";
import { core } from "@brain/rust-core";

export interface QueryPlan {
  /** The question without platform names, which say where to look rather than what about. */
  searchText: string;
  /** The platforms the question names, in the order it names them. */
  sources: Source[];
  /** The time range the question names, as ISO timestamps. */
  window?: { from: string; to: string };
}

export function planQuery(question: string, now = new Date()): QueryPlan {
  const plan = core<Omit<QueryPlan, "window"> & { window?: { from: number; to: number } }>("query.plan", {
    question, now: now.getTime()
  });
  return {
    searchText: plan.searchText,
    sources: plan.sources,
    ...(plan.window ? { window: {
      from: new Date(plan.window.from).toISOString(), to: new Date(plan.window.to).toISOString()
    } } : {})
  };
}

/**
 * Orders ranked candidates for the answer context:
 * 1. up to `perNamed` from each platform the question named, best first;
 * 2. then the clearly relevant platforms take turns: those whose best candidate scores at least half the top score.
 *    The other platforms go first in each turn, starting with the one whose best candidate ranks highest;
 * 3. then everything else, by score.
 * Only what the question itself matched counts for 1 and for a platform's relevance: an item a link brought in never
 * takes a named platform's places, nor makes its platform clearly relevant. Original candidate objects are retained.
 */
export function balanceBySource<T extends { docId: string; score: number; linkedFrom?: string }>(candidates: readonly T[],
  named: readonly Source[], sourceOf: (docId: string) => Source | undefined, perNamed = 3): T[] {
  const order = core<number[]>("query.balance", {
    candidates: candidates.map(candidate => ({
      source: sourceOf(candidate.docId) ?? null, score: candidate.score, linked: Boolean(candidate.linkedFrom)
    })),
    named, perNamed: Number.isNaN(perNamed) ? 0 : perNamed === Infinity ? candidates.length : perNamed === -Infinity ? 0 : perNamed
  });
  return order.map(index => candidates[index]);
}
