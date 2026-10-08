const hits = new Map<string, number[]>();

/** At most `max` per `windowMs` for this key, counted in this instance. A guard against a form being hammered, not a security boundary. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(time => time > now - windowMs);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now);
  if (hits.size > 5000) hits.clear();
  hits.set(key, recent);
  return true;
}
