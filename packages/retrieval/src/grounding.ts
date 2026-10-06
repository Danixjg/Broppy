import { core } from "@brain/rust-core";
import type { Citation, QueryAnswer, RemovalReason } from "@brain/types";

export const NO_RESULT = "No accessible information was found for this query.";

export const fold = (text: string): string => core("grounding.fold", { text });
export const stem = (word: string): string => core("grounding.stem", { word });
export const sameWord = (a: string, b: string): boolean => core("grounding.sameWord", { a, b });
export const splitClauses = (sentence: string): string[] => core("grounding.splitClauses", { sentence });

export function numberValue(word: string): string | undefined {
  return core<string | null>("grounding.numberValue", { word }) ?? undefined;
}

export interface CheckReport {
  lines: Array<{ kind: "quoted" | "reworded"; text: string; citations: string[]; support: string[] }>;
  removed: Array<{ text: string; reason: RemovalReason; detail: string; citations: string[] }>;
}

export function checkAnswer(output: string, allowed: Map<string, Citation>, evidence: Map<string, string>):
  { answer: QueryAnswer; report: CheckReport } {
  return core("grounding.checkAnswer", { output, allowed: [...allowed], evidence: [...evidence] });
}
