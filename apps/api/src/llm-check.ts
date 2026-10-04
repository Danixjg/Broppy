import { pathToFileURL } from "node:url";
import { NO_RESULT, type LlmClient } from "@brain/retrieval";
import { Brain } from "./brain.js";
import { modelsFromEnv } from "./llm-budget.js";
import { USAGE_QUESTIONS } from "./llm-usage.js";

/** One question's reply: the lines kept, with how and what backs them, and the model's lines left out, with why. */
export interface CheckedReply {
  user: string;
  question: string;
  kept: Array<{ kind: "quoted" | "reworded"; text: string; support: string[] }>;
  removed: Array<{ text: string; reason: string; detail: string }>;
  /** Why the built-in writer answered instead of the model, when it did. */
  fallback?: string;
}

/** Asks the questions on the mock data through the model, and records the answer checker's verdict on every line. */
export async function reviewReplies(model: LlmClient, questions: ReadonlyArray<readonly [string, string]> = USAGE_QUESTIONS):
  Promise<CheckedReply[]> {
  const brain = new Brain(model);
  await brain.syncAll();
  const replies: CheckedReply[] = [];
  for (const [user, question] of questions) {
    let traceId = "";
    const answer = await brain.query(brain.user(user)!, question, id => { traceId = id; });
    const trace = brain.audit.entries.filter(entry => entry.data.traceId === traceId);
    const check = trace.find(entry => entry.type === "answer_returned")?.data.check as
      { removed?: Array<{ text: string; reason: string; detail: string }> } | undefined;
    const fallback = trace.find(entry => entry.type === "llm_fallback")?.data.reason;
    const lines = answer.text === NO_RESULT ? [] : answer.text.split("\n");
    replies.push({
      user, question,
      kept: lines.map((text, index) => ({ kind: answer.check?.lines[index]?.kind ?? "quoted", text,
        support: answer.check?.lines[index]?.support ?? [] })),
      removed: (check?.removed ?? []).map(({ text, reason, detail }) => ({ text, reason, detail })),
      ...(typeof fallback === "string" ? { fallback } : {})
    });
  }
  return replies;
}

/** The review as text, for a person to judge each verdict. */
export function formatReview(replies: CheckedReply[]): string {
  const out = [
    "Each line the model wrote, and what the answer checker did with it. Judge every verdict: a wrong \"kept\" is a",
    "hallucination that got through, and a wrong \"left out\" is a faithful line that was removed.", ""
  ];
  const reasons = new Map<string, number>();
  let copied = 0;
  let reworded = 0;
  let replaced = 0;
  replies.forEach((reply, index) => {
    out.push(`${index + 1}. ${reply.user}: ${reply.question}`);
    if (reply.fallback) {
      replaced++;
      out.push(`   the built-in writer answered instead (${reply.fallback}); the model's lines were:`);
    } else if (!reply.kept.length && !reply.removed.length) {
      out.push("   no model call: nothing the asker may see");
    } else {
      for (const line of reply.kept) {
        out.push(`   kept, ${line.kind === "reworded" ? "reworded" : "copied  "}  ${line.text}`);
        if (line.kind === "reworded") out.push(...line.support.map(sentence => `                     backed by: "${sentence}"`));
        if (line.kind === "reworded") reworded++; else copied++;
      }
    }
    for (const line of reply.removed) {
      out.push(`   left out (${line.reason})  ${line.text}`, `                     ${line.detail}`);
      reasons.set(line.reason, (reasons.get(line.reason) ?? 0) + 1);
    }
    out.push("");
  });
  const removed = [...reasons.values()].reduce((sum, count) => sum + count, 0);
  const total = copied + reworded + removed;
  const why = removed ? ` (${[...reasons].map(([reason, count]) => `${reason} ${count}`).join(", ")})` : "";
  out.push(`Totals: ${total} line${total === 1 ? "" : "s"} from the model: ${copied} copied, ${reworded} reworded, ${removed} left out${why}. ` +
    (replaced ? `${replaced} repl${replaced === 1 ? "y was" : "ies were"} replaced by the built-in writer.` : "No reply was replaced by the built-in writer."));
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { llm } = modelsFromEnv(process.env);
  if (!llm) {
    console.error("No model is configured. Set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL in .env.local.");
    process.exit(1);
  }
  console.log(formatReview(await reviewReplies(llm)));
}
