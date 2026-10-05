// Turning facts into sentences without repeating ourselves: a sentence of six or more words may appear in at most
// three items, so each fact can be said in several ways and the writer picks one that is still free.
import type { Rng } from "./random.js";

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
export const normalizeSentence = (sentence: string): string => sentence.toLowerCase().replace(/\s+/g, " ").trim();
export const cap = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);
export const LONG_SENTENCE = 6;
export const REPEAT_LIMIT = 3;

export class Writer {
  /** Long sentence -> the items (families) that use it. */
  private readonly uses = new Map<string, Set<string>>();

  constructor(private readonly rng: Rng, private readonly limit: number) {}

  /** Whether the family may use the sentence without passing the limit. */
  fits(family: string, sentence: string): boolean {
    if (wordCount(sentence) < LONG_SENTENCE) return true;
    const families = this.uses.get(normalizeSentence(sentence));
    return !families || families.has(family) || families.size < this.limit;
  }

  /** Records the sentence as used by the family. */
  use(family: string, sentence: string): void {
    if (wordCount(sentence) < LONG_SENTENCE) return;
    const key = normalizeSentence(sentence);
    const families = this.uses.get(key) ?? new Set<string>();
    families.add(family);
    this.uses.set(key, families);
  }

  /** Picks, in random order, the first candidate that still fits, and records it. */
  pick<T>(family: string, candidates: ReadonlyArray<readonly [string, T]>): [string, T] {
    return this.pickTiered(family, [candidates]);
  }

  /**
   * Picks the first candidate that still fits, trying each tier in turn and each tier in random order, and records
   * it. When nothing fits, the first tier's first candidate is used anyway.
   */
  pickTiered<T>(family: string, tiers: ReadonlyArray<ReadonlyArray<readonly [string, T]>>): [string, T] {
    const shuffled = tiers.filter(tier => tier.length).map(tier => this.rng.shuffle(tier));
    if (!shuffled.length) throw new Error("Nothing to say");
    const chosen = shuffled.flat().find(([sentence]) => this.fits(family, sentence)) ?? shuffled[0][0];
    this.use(family, chosen[0]);
    return [chosen[0], chosen[1]];
  }

  /** Picks one of several ways to say the same thing. */
  say(family: string, sentences: readonly string[]): string {
    return this.pick(family, sentences.map(sentence => [sentence, null] as const))[0];
  }
}

/** Formal text states facts plainly; chat attributes them to colleagues. */
export type Voice = "formal" | "chat";

/** One way to state a fact: its style, how readily it is used (0 first), the sentence, and who it quotes. */
export type Variant = [style: string, tier: number, sentence: string, who?: string];

/**
 * Ways to state a fact as a sentence. The plain sentence reads best, and chat also names who said it; the openers
 * ("In practice," or "Quick update:") only take over once those are used up, and one item never uses an opener twice.
 */
export function factVariants(fact: string, names: readonly string[], voice: Voice): Variant[] {
  if (voice === "formal") {
    return [
      ["plain", 0, `${cap(fact)}.`],
      ["practice", 1, `In practice, ${fact}.`], ["today", 1, `Today, ${fact}.`], ["present", 1, `At present, ${fact}.`],
      ["note", 2, `Note that ${fact}.`], ["reference", 2, `For reference, ${fact}.`]
    ];
  }
  return [
    ["plain", 0, `${cap(fact)}.`],
    ...names.flatMap(name => [
      ["confirmed", 0, `${name} confirmed that ${fact}.`, name], ["according", 0, `According to ${name}, ${fact}.`, name],
      ["says", 0, `${name} says ${fact}.`, name]
    ] as Variant[]),
    ["week", 1, `As of this week, ${fact}.`], ["update", 1, `Quick update: ${fact}.`], ["worth", 2, `Worth knowing: ${fact}.`]
  ];
}

/** Ways to give a status line, which the catch-up looks for. */
export function statusSentences(status: string): string[] {
  return [`Status: ${status}.`, `Status update: ${status}.`, `Status this week: ${status}.`, `Latest status: ${status}.`];
}

/** "a, b and c". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "than", "then", "are", "was", "has", "have", "its",
  "our", "their", "each", "every", "only", "before", "after", "per", "out", "all", "any", "not", "will", "can", "now",
  "still", "also", "more", "less", "who", "what", "when", "which", "whether"
]);

const WORDS = new Map<string, Set<string>>();

/** The words that carry a sentence's meaning: numbers, and words of three letters or more without a plural s. */
export function contentWords(text: string): Set<string> {
  const known = WORDS.get(text);
  if (known) return known;
  const words = new Set<string>();
  for (const [token] of text.toLowerCase().matchAll(/\d+(?:[.,]\d+)*%?|[a-z]+/g)) {
    if (/^\d/.test(token)) words.add(token);
    else if (token.length >= 3 && !STOPWORDS.has(token)) words.add(token.length > 3 ? token.replace(/s$/, "") : token);
  }
  WORDS.set(text, words);
  return words;
}

/** Whether the text already says the fact: most of the fact's meaning words appear in it. */
export function restates(fact: string, text: string): boolean {
  const words = [...contentWords(fact)];
  if (!words.length) return false;
  const other = contentWords(text);
  return words.filter(word => other.has(word)).length / words.length >= 0.6;
}
