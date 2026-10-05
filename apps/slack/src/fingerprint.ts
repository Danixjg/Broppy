import { createHash } from "node:crypto";

const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "on", "in", "by", "before", "after", "with", "is", "be", "we", "our", "this", "that", "final", "again"]);

const stem = (word: string): string =>
  word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, "") : word.replace(/s$/, "");

/** The title's content words, lower-cased, lightly stemmed and sorted, so reworded repeats compare equal. */
export function tokens(title: string): string[] {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter(word => word && !STOP.has(word)).map(stem);
  return [...new Set(words)].sort();
}

export function fingerprint(project: string, title: string): string {
  return createHash("sha256").update(`${project.toUpperCase()}\n${tokens(title).join(" ")}`).digest("hex");
}

export function similarity(a: string[], b: string[]): number {
  const left = new Set(a);
  const shared = b.filter(token => left.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/** Titles at or above this overlap count as the same task. */
export const SAME_TASK = 0.75;
