import { core } from "@brain/rust-core";

/**
 * The time range a relative phrase names (yesterday, today, last or past week, last or past N days), in milliseconds,
 * or undefined. Days run from UTC midnight; the open-ended ranges end now.
 */
export function relativeWindow(text: string, now: Date): { from: number; to: number } | undefined {
  return core<{ from: number; to: number } | null>("query.relativeWindow", { text, now: now.getTime() }) ?? undefined;
}
