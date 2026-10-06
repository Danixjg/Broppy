import { core } from "@brain/rust-core";

export interface Person {
  slackId: string;
  name: string;
  brainUserId?: string;
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

/** The first date a message names, relative to when it was posted (UTC). */
export function parseDue(text: string, reference: Date): string | undefined {
  return core<string | null>("tasks.parseDue", { text, reference: reference.getTime() }) ?? undefined;
}

/** "Fri 16 Oct", the way the suggestion shows it. */
export function formatDue(due: string): string {
  return core<string>("tasks.formatDue", { due });
}

/** Scores a message deterministically and retains the identity of a known owner. */
export function scoreMessage(text: string, people: Person[], postedAt: Date, threshold = DEFAULT_THRESHOLD, authorSlackId?: string):
  TaskCandidate & { suggest: boolean } {
  const { assigneeIndex, ...result } = core<TaskCandidate & { suggest: boolean; assigneeIndex?: number }>("tasks.score", {
    text, people, postedAt: postedAt.getTime(), authorSlackId,
    threshold: threshold === Infinity ? 2 : threshold === -Infinity ? -1 : threshold
  });
  if (assigneeIndex !== undefined) result.assignee = people[assigneeIndex];
  return result;
}
