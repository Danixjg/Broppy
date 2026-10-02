import type { Source } from "@brain/types";
import { relativeWindow } from "./time-window.js";

export interface QueryPlan {
  /** The question without platform names, which say where to look rather than what about. */
  searchText: string;
  /** The platforms the question names, in the order it names them. */
  sources: Source[];
  /** The time range the question names, as ISO timestamps. */
  window?: { from: string; to: string };
}

// A platform name as a whole word: "drive-through" or "slackline" don't count.
const PLATFORM = /(?<![a-z0-9-])(slack|jira|confluence|drive)(?![a-z0-9-])/gi;

export function planQuery(question: string, now = new Date()): QueryPlan {
  const sources = [...new Set([...question.matchAll(PLATFORM)].map(match => match[1].toLowerCase() as Source))];
  const searchText = question.replace(PLATFORM, " ").replace(/\s+/g, " ").trim();
  const range = relativeWindow(question, now);
  return {
    searchText,
    sources,
    ...(range ? { window: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } } : {})
  };
}

/**
 * Orders ranked candidates for the answer context:
 * 1. up to `perNamed` from each platform the question named, best first;
 * 2. then the clearly relevant platforms take turns: those whose best candidate scores at least half the top score.
 *    The other platforms go first in each turn, starting with the one whose best candidate ranks highest;
 * 3. then everything else, by score.
 * Only what the question itself matched counts for 1 and for a platform's relevance: an item a link brought in never
 * takes a named platform's places, nor makes its platform clearly relevant.
 */
export function balanceBySource<T extends { docId: string; score: number; linkedFrom?: string }>(candidates: readonly T[],
  named: readonly Source[], sourceOf: (docId: string) => Source | undefined, perNamed = 3): T[] {
  const queues = new Map<Source | undefined, T[]>();
  const best = new Map<Source | undefined, number>();
  for (const candidate of candidates) {
    const source = sourceOf(candidate.docId);
    queues.set(source, [...(queues.get(source) ?? []), candidate]);
    if (!candidate.linkedFrom) best.set(source, Math.max(best.get(source) ?? 0, candidate.score));
  }
  const top = Math.max(0, ...best.values());
  const ordered: T[] = [];
  for (const source of named) {
    const queue = queues.get(source) ?? [];
    for (let taken = 0, index = 0; taken < perNamed && index < queue.length;) {
      if (queue[index].linkedFrom) index += 1;
      else { ordered.push(...queue.splice(index, 1)); taken += 1; }
    }
  }
  const isNamed = (source: Source | undefined) => Number(source !== undefined && named.includes(source));
  const relevant = (source: Source | undefined) => (best.get(source) ?? 0) >= top / 2;
  const turns = [...queues].filter(([source]) => relevant(source))
    .sort(([a], [b]) => isNamed(a) - isNamed(b)).map(([, queue]) => queue);
  while (turns.some(queue => queue.length)) {
    for (const queue of turns) {
      const next = queue.shift();
      if (next) ordered.push(next);
    }
  }
  const rest = [...queues].filter(([source]) => !relevant(source)).flatMap(([, queue]) => queue);
  return [...ordered, ...rest.sort((a, b) => b.score - a.score)];
}
