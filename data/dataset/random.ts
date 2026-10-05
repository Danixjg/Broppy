// One seeded source of randomness, so the same seed gives byte-identical data on any machine. Each part of the
// dataset draws from its own stream, so changing one area never reshuffles another.

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, to turn a stream's label into a seed. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number, label = "") {
    this.next = mulberry32(label ? hash32(`${seed}:${label}`) : seed);
  }

  /** A separate stream for one part of the dataset. */
  stream(label: string): Rng {
    return new Rng(this.seed, label);
  }

  float(): number {
    return this.next();
  }

  /** A whole number from min to max, both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(this.next() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  /** An id of the given length from the given characters. */
  id(length: number, characters: string): string {
    let result = "";
    for (let index = 0; index < length; index++) result += characters[Math.floor(this.next() * characters.length)];
    return result;
  }
}

/** Code-unit order: the same on every machine, whatever its locale. */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCode);
}
