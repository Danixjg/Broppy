import { formatDue } from "./score.js";
import type { BroppyAnswer } from "./broppy.js";

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

export function suggestionBlocks(s: Suggestion, assigneeName: string, openUrl: string, reference: { id: string; revision: number }, candidates: Array<{ issueKey: string; issueUrl: string }> = [], sourcePointer?: string, audience: string[] = []) {
  const line = ["Looks like a task: *" + escape(s.t) + "*", escape(assigneeName),
    ...(s.d ? [`due ${formatDue(s.d)}`] : []), s.p ? `Jira project ${s.p}` : "no Jira project yet"].join(" · ");
  return [
    { type: "section", text: text(line + "\nJira receives the reviewed summary, owner, and due date." + (sourcePointer ? "\nFrom: " + escape(sourcePointer) : "")
      + (audience.length ? "\nJira task visible to: " + audience.map(id => `<@${id}>`).join(", ") : "\nCreating Jira tasks from Slack isn't set up for this workspace yet.")) },
    {
      type: "actions", block_id: "task_suggestion",
      elements: [
        // No button that can only fail: without a declared audience, creation is refused.
        ...(audience.length ? [{ type: "button", action_id: "track_task", style: "primary", text: { type: "plain_text", text: "Track in Jira" }, value: JSON.stringify(reference) }] : []),
        { type: "button", action_id: "edit_task", text: { type: "plain_text", text: "Edit" }, value: JSON.stringify(reference) },
        { type: "button", action_id: "open_in_broppy", text: { type: "plain_text", text: "Open in Broppy ↗" }, url: openUrl },
        { type: "button", action_id: "dismiss_task", text: { type: "plain_text", text: "Not a task" }, value: JSON.stringify(reference) }
      ]
    },
    ...candidates.map(candidate => ({ type: "actions", elements: [{ type: "button", action_id: "link_task", text: { type: "plain_text", text: `Link ${candidate.issueKey}` }, value: JSON.stringify({ ...reference, issueKey: candidate.issueKey }) }] }))
  ];
}

export function trackedLine(key: string, url: string, trackedBy: string, assigneeName: string, due: string | undefined,
  openUrl: string, existing: boolean): string {
  const head = existing ? `Linked to <${url}|${key}>` : `Tracked as <${url}|${key}>`;
  return [`${head} by <@${trackedBy}>`, escape(assigneeName), ...(due ? [`due ${formatDue(due)}`] : []),
    `<${openUrl}|Open in Broppy ↗>`].join(" · ");
}

/** A short answer: its first few sentences, then the sources it came from. Visible only to the person who asked. */
const NO_RESULT = "No accessible information was found for this query.";
// The same words for a restricted item as for one that doesn't exist, so a miss never hints that something is hidden.
export const NOTHING_FOUND = "Hmm, I couldn't find anything on that. If you expected an answer, the file may be out of date or not in Broppy yet. Check with your admin or manager.";

export function answerBlocks(question: string, answer: BroppyAnswer, openUrl: string) {
  const said = answer.text.trim() === NO_RESULT && !answer.citations.length ? NOTHING_FOUND : answer.text;
  const short = said.length > 600 ? `${said.slice(0, 597).trimEnd()}...` : said;
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
