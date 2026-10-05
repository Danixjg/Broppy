import { formatDue } from "./score.js";
import type { BroppyAnswer } from "./broppy.js";

/** What a button carries back to us. Slack signs the whole interaction, so the value can't be forged by a click. */
export interface Suggestion {
  /** Title */
  t: string;
  /** Slack ID of the person receiving the task */
  a: string;
  /** Due date, YYYY-MM-DD */
  d?: string;
  /** Jira project */
  p: string;
  /** Channel ID */
  c: string;
  /** Message ts */
  ts: string;
  /** Thread ts, when the message was a reply */
  th?: string;
  /** The sentence that triggered it */
  s: string;
}

const text = (value: string) => ({ type: "mrkdwn", text: value });
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function suggestionBlocks(s: Suggestion, assigneeName: string, openUrl: string) {
  const line = ["Looks like a task: *" + escape(s.t) + "*", escape(assigneeName),
    ...(s.d ? [`due ${formatDue(s.d)}`] : []), `Jira project ${s.p}`].join(" · ");
  return [
    { type: "section", text: text(line) },
    {
      type: "actions", block_id: "task_suggestion",
      elements: [
        { type: "button", action_id: "track_task", style: "primary", text: { type: "plain_text", text: "Track in Jira" }, value: JSON.stringify(s) },
        { type: "button", action_id: "open_in_broppy", text: { type: "plain_text", text: "Open in Broppy ↗" }, url: openUrl },
        { type: "button", action_id: "dismiss_task", text: { type: "plain_text", text: "Not a task" }, value: JSON.stringify(s) }
      ]
    }
  ];
}

export function trackedLine(key: string, url: string, trackedBy: string, assigneeName: string, due: string | undefined,
  openUrl: string, existing: boolean): string {
  const head = existing ? `Added to <${url}|${key}>, which already tracks this` : `Tracked as <${url}|${key}>`;
  return [`${head} by <@${trackedBy}>`, escape(assigneeName), ...(due ? [`due ${formatDue(due)}`] : []),
    `<${openUrl}|Open in Broppy ↗>`].join(" · ");
}

/** A short answer: its first few sentences, then the sources it came from. Visible only to the person who asked. */
export function answerBlocks(question: string, answer: BroppyAnswer, openUrl: string) {
  const short = answer.text.length > 600 ? `${answer.text.slice(0, 597).trimEnd()}...` : answer.text;
  const sources = answer.citations.slice(0, 4).map(c => `<${c.url}|${escape(c.title)}>`).join("  ·  ");
  return [
    { type: "context", elements: [text(`You asked: _${escape(question.slice(0, 200))}_ · only visible to you`)] },
    { type: "section", text: text(escape(short)) },
    ...(sources ? [{ type: "context", elements: [text(`Sources: ${sources}`)] }] : []),
    {
      type: "actions",
      elements: [{ type: "button", action_id: "open_answer", text: { type: "plain_text", text: "Open full answer in Broppy ↗" }, url: openUrl }]
    }
  ];
}
