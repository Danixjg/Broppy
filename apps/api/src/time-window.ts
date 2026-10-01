const DAY = 86_400_000;
// The widest span a Date can hold, either side of 1970.
const LIMIT = 8_640_000_000_000_000;

/**
 * The time range a relative phrase names (yesterday, today, last or past week, last or past N days), in milliseconds,
 * or undefined. Days run from UTC midnight; the open-ended ranges end now.
 */
export function relativeWindow(text: string, now: Date): { from: number; to: number } | undefined {
  const q = text.toLowerCase();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = /\b(?:last|past) (\d+) days?\b/.exec(q);
  let range: { from: number; to: number } | undefined;
  if (/\byesterday\b/.test(q)) range = { from: midnight - DAY, to: midnight - 1 };
  else if (/\btoday\b/.test(q)) range = { from: midnight, to: midnight + DAY - 1 };
  else if (/\b(?:last|past) week\b/.test(q)) range = { from: midnight - 7 * DAY, to: now.getTime() };
  else if (days) range = { from: midnight - Number(days[1]) * DAY, to: now.getTime() };
  return range && Math.abs(range.from) <= LIMIT ? range : undefined;
}
