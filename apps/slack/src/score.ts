/**
 * Rule-based task detection. No model and no sampling: the same message and reference date always give the same
 * score, so a suggestion can be explained by listing the signals that fired.
 */

export interface Person {
  slackId: string;
  name: string;
  /** The Jira account that gets the issue. */
  jiraAccountId?: string;
}

export interface Signal { name: string; weight: number }

export interface TaskCandidate {
  score: number;
  signals: Signal[];
  title: string;
  sentence: string;
  assignee?: Person;
  /** ISO date (YYYY-MM-DD), when the message names one. */
  due?: string;
}

export const DEFAULT_THRESHOLD = 0.6;

const CUE = /^\s*(?:agreed|decision|decided|action(?:\s+items?)?|todo|to-do|next\s+steps?|owner)\s*:\s*/i;
const COMMIT = /\b(?:will|i'll|we'll|going\s+to|needs?\s+to|has\s+to|must|should|to\s+be\s+done)\b/i;
const HEDGE = /\b(?:maybe|perhaps|might|could\s+we|should\s+we|wondering|not\s+sure|if\s+we)\b/i;
const VERBS = [
  "raise", "fix", "update", "create", "migrate", "add", "remove", "review", "send", "write", "deploy", "increase",
  "rotate", "schedule", "draft", "prepare", "file", "close", "open", "check", "run", "test", "ship", "set up",
  "confirm", "approve", "document", "restart", "revert", "roll back", "investigate", "resolve", "backfill", "patch",
  "upgrade", "provision", "cut over", "sign off"
];
const VERB = new RegExp(`\\b(${VERBS.join("|")})(?:s|es)?\\b`, "i");
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const iso = (date: Date): string => date.toISOString().slice(0, 10);

/** The first date a message names, relative to when it was posted (UTC). */
export function parseDue(text: string, reference: Date): string | undefined {
  const day = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (day) return day[0];
  const dayMonth = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*\\b`, "i"));
  const monthDay = text.match(new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"));
  const named = dayMonth
    ? { d: Number(dayMonth[1]), m: MONTHS.indexOf(dayMonth[2].toLowerCase()) }
    : monthDay ? { d: Number(monthDay[2]), m: MONTHS.indexOf(monthDay[1].toLowerCase()) } : undefined;
  if (named && named.d >= 1 && named.d <= 31) {
    let date = new Date(Date.UTC(reference.getUTCFullYear(), named.m, named.d));
    if (date.getUTCMonth() !== named.m) return undefined;
    // A date already well past means next year's.
    if (date.getTime() < reference.getTime() - 30 * 86400000) date = new Date(Date.UTC(reference.getUTCFullYear() + 1, named.m, named.d));
    return iso(date);
  }
  if (/\btomorrow\b/i.test(text)) return iso(new Date(reference.getTime() + 86400000));
  if (/\b(?:today|eod)\b/i.test(text)) return iso(reference);
  const weekday = text.match(new RegExp(`\\b(?:by|due|on|before|until)?\\s*(${WEEKDAYS.join("|")})[a-z]*\\b`, "i"));
  if (weekday && /\b(?:by|due|on|before|until|next|this)\b/i.test(text)) {
    const target = WEEKDAYS.indexOf(weekday[1].toLowerCase());
    const ahead = (target - reference.getUTCDay() + 7) % 7 || 7;
    return iso(new Date(reference.getTime() + ahead * 86400000));
  }
  return undefined;
}

/** "Fri 16 Oct", the way the suggestion shows it. */
export function formatDue(due: string): string {
  const date = new Date(`${due}T00:00:00Z`);
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

function findAssignee(text: string, people: Person[]): { person?: Person; matched?: string } {
  const mention = text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/);
  if (mention) {
    const person = people.find(candidate => candidate.slackId === mention[1]);
    return { person: person ?? { slackId: mention[1], name: mention[1] }, matched: mention[0] };
  }
  let best: { person: Person; index: number; matched: string } | undefined;
  for (const person of people) {
    const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hit = new RegExp(`\\b${escaped}\\b`, "i").exec(text);
    if (hit && (!best || hit.index < best.index)) best = { person, index: hit.index, matched: hit[0] };
  }
  return best ? { person: best.person, matched: best.matched } : {};
}

function titleOf(sentence: string, matched: string | undefined): string {
  let text = sentence.replace(CUE, "");
  if (matched) text = text.replace(matched, " ");
  text = text.replace(/<[^>]+>/g, " ").replace(/\b(?:will|i'll|we'll|needs?\s+to|has\s+to|must|should|to)\b/gi, " ");
  const verb = VERB.exec(text);
  if (verb) text = `${verb[1]} ${text.slice(verb.index + verb[0].length)}`;
  text = text.split(/\b(?:before|by|until|due|on)\b|[.;,]|\s[-–—]\s/i)[0];
  text = text.replace(/^\s*(?:the|a|an)\s+/i, "").replace(/\b(?:the|a|an)\b/gi, " ").replace(/\s+/g, " ").trim();
  const [head, ...rest] = text.split(" ");
  const withoutArticle = verb ? [head, ...rest].join(" ") : text;
  return withoutArticle ? withoutArticle[0].toUpperCase() + withoutArticle.slice(1) : "Follow up";
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Scores one message. A signal adds or removes a fixed weight; the total is clamped to 0..1. Only the message text,
 * the known people and the posting time are inputs.
 */
export function scoreMessage(text: string, people: Person[], postedAt: Date, threshold = DEFAULT_THRESHOLD):
  TaskCandidate & { suggest: boolean } {
  const sentence = text.replace(/\s+/g, " ").trim();
  const signals: Signal[] = [];
  const add = (name: string, weight: number) => signals.push({ name, weight });
  const cue = CUE.test(sentence);
  const { person, matched } = findAssignee(sentence, people);
  const due = parseDue(sentence, postedAt);
  if (cue) add("agreement cue", 0.45);
  if (person) add("names an owner", 0.2);
  if (VERB.test(sentence)) add("action verb", 0.15);
  if (due) add("has a date", 0.15);
  if (COMMIT.test(sentence) && person) add("commitment wording", 0.1);
  if (sentence.includes("?")) add("is a question", -0.4);
  if (HEDGE.test(sentence)) add("hedged wording", -0.3);
  const score = round(Math.min(1, Math.max(0, signals.reduce((sum, signal) => sum + signal.weight, 0))));
  return {
    score, signals, title: titleOf(sentence, matched), sentence,
    ...(person ? { assignee: person } : {}), ...(due ? { due } : {}),
    // Without an owner there is nobody to show the suggestion to.
    suggest: score >= threshold && Boolean(person)
  };
}
