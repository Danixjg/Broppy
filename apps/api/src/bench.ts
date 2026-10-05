import { arch, cpus, platform, totalmem } from "node:os";
import { pathToFileURL } from "node:url";
import { AuditLog } from "@brain/audit";
import { NO_RESULT } from "@brain/retrieval";
import type { AuditEntry } from "@brain/types";
import { generateCorpus } from "../../../data/generate.js";
import { Brain } from "./brain.js";

// pnpm bench: the brief's scale (about 20,000 items in 30 projects) built in memory beside the 26 hand-written items,
// indexed by the same Brain the demo API runs, then asked the same questions by each of the six people.

/**
 * What every person asks: the brief's scenarios and the hand-written story, the generated company's projects and issues
 * by name, questions that name a platform or a week, and the catch-ups.
 */
export const BENCH_QUESTIONS: readonly string[] = [
  "What's the status of the database migration project and were there any blockers raised in Slack last week?",
  "What's the latest runbook for the payment-service incident?",
  "Show me the security incident report from the Q3 breach",
  "What does PAY-101 need before cutover?",
  "Why is DB-15 blocked?",
  "How do we handle a chargeback dispute?",
  "What's the status of the Build pipeline upgrade?",
  "What is blocked in PLAT?",
  "Why is PLAT-1 blocked?",
  "What was decided recently about the Mobile app 4.0 release?",
  "Which Jira tasks are in review for the Mobile app 4.0 release?",
  "What is the status of the Customer data warehouse, and what are its blockers?",
  "Which KYC review automation items are blocked?",
  "What are the reward tiers in the Corporate card rewards pricing sheet?",
  "What rate limit applies to the partner API?",
  "What changed in the merge queue last week?",
  "What did Slack say about flaky tests last week?",
  "Where is the on-call guide?",
  "What has been shared with Wei Ming, and what does Wei Ming own?",
  "What should a new hire read first: the overview, the milestones and the workflow guides?"
];

export interface BenchPerson {
  id: string;
  name: string;
  /** Milliseconds per question: the median and the 95th percentile, by nearest rank. */
  p50: number;
  p95: number;
  /** Questions answered from at least one source the person may open, on topic or not, rather than with the fixed reply. */
  answered: number;
  /** Documents the access check decided on, over all the questions, and how many were refused before the writer. */
  checked: number;
  refused: number;
  /** Entries the questions added to the audit log. */
  entries: number;
}

export interface BenchReport {
  scale: "demo" | "brief";
  items: number;
  bySource: Record<string, number>;
  projects: number;
  generateMs: number;
  /** Building the Brain and its first sync: chunking, search terms, access tuples and an audit entry per item. */
  buildMs: number;
  /** Heap in use after indexing, above what was in use before generating, and the process's resident memory. */
  heapMb: number;
  rssMb: number;
  questions: number;
  people: BenchPerson[];
  /** Everyone's questions together, and the slowest of them. */
  overall: { p50: number; p95: number };
  slowest: { person: string; question: string; ms: number; entries: number };
  machine: string;
}

// Counts, for each question, its audit entries, the documents the access check decided on, and those refused before the
// writer: by that check, or at the source just before their text is used. Reading the log's entries copies all of them,
// which at this scale would cost more than the questions.
class CountingAuditLog extends AuditLog {
  readonly counts = new Map<string, { entries: number; checked: number; refused: number }>();

  override append(type: string, actor: string, data: Record<string, unknown>): AuditEntry {
    if (typeof data.traceId === "string") {
      const count = this.counts.get(data.traceId) ?? { entries: 0, checked: 0, refused: 0 };
      count.entries += 1;
      if (type === "access_decision") count.checked += 1;
      if ((type === "access_decision" || type === "live_access_decision") && data.allowed === false) count.refused += 1;
      this.counts.set(data.traceId, count);
    }
    return super.append(type, actor, data);
  }
}

// Collects garbage first when Node runs with --expose-gc, as pnpm bench does, so the heap figures are what is kept.
const collect = () => (globalThis as { gc?: () => void }).gc?.();
const megabytes = (bytes: number) => Math.round(bytes / 1_048_576);

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

function machine(): string {
  const processors = cpus();
  return `${processors[0]?.model.trim() || "Unknown processor"}, ${processors.length} logical processors, ` +
    `${Math.round(totalmem() / 2 ** 30)} GB memory, Node ${process.version} on ${platform()} ${arch()}`;
}

/** Generates the company, builds the Brain, then has each person ask every question, after one warm-up pass. */
export async function runBench(options: { scale?: "demo" | "brief"; questions?: readonly string[] } = {}): Promise<BenchReport> {
  const scale = options.scale ?? "brief";
  const questions = options.questions ?? BENCH_QUESTIONS;
  collect();
  const heapBefore = process.memoryUsage().heapUsed;
  let started = performance.now();
  const corpus = generateCorpus({ scale });
  const generateMs = performance.now() - started;
  started = performance.now();
  const audit = new CountingAuditLog();
  const brain = new Brain(undefined, { corpus, audit });
  await brain.syncAll();
  const buildMs = performance.now() - started;
  collect();
  const memory = process.memoryUsage();
  const documents = [...brain.index.documents.values()];
  const bySource: Record<string, number> = {};
  for (const doc of documents) bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;

  // The first questions after indexing are slower while the code warms up, so a pass comes before any timing.
  for (const question of questions) await brain.query(brain.users[0], question);
  const people: BenchPerson[] = [];
  const everyone: number[] = [];
  let slowest: BenchReport["slowest"] = { person: "", question: "", ms: 0, entries: 0 };
  for (const user of brain.users) {
    const times: number[] = [];
    let answered = 0;
    let checked = 0;
    let refused = 0;
    let entries = 0;
    for (const question of questions) {
      let traceId = "";
      const begun = performance.now();
      const answer = await brain.query(user, question, id => { traceId = id; });
      const ms = performance.now() - begun;
      times.push(ms);
      if (answer.text !== NO_RESULT) answered += 1;
      const count = audit.counts.get(traceId) ?? { entries: 0, checked: 0, refused: 0 };
      checked += count.checked;
      refused += count.refused;
      entries += count.entries;
      if (ms > slowest.ms) slowest = { person: user.name, question, ms, entries: count.entries };
    }
    everyone.push(...times);
    people.push({ id: user.id, name: user.name, p50: percentile(times, 0.5), p95: percentile(times, 0.95), answered, checked, refused, entries });
  }
  return {
    scale, items: documents.length, bySource, projects: documents.filter(doc => doc.metadata.label === "master").length,
    generateMs, buildMs, heapMb: megabytes(memory.heapUsed - heapBefore), rssMb: megabytes(memory.rss),
    questions: questions.length, people, overall: { p50: percentile(everyone, 0.5), p95: percentile(everyone, 0.95) },
    slowest, machine: machine()
  };
}

const thousands = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const milliseconds = (ms: number) => `${thousands(ms)} ms`;

export function formatBench(report: BenchReport): string {
  const count = (source: string, noun: string) => `${thousands(report.bySource[source] ?? 0)} ${noun}`;
  const header = ["Person", "Median", "95th percentile", "Answered", "Checked per question", "Refused", "Audit entries per question"];
  const rows = report.people.map(person => [
    person.name, milliseconds(person.p50), milliseconds(person.p95), `${person.answered} of ${report.questions}`,
    thousands(person.checked / report.questions), person.checked ? `${(100 * person.refused / person.checked).toFixed(1)}%` : "none checked",
    thousands(person.entries / report.questions)
  ]);
  rows.push(["Everyone", milliseconds(report.overall.p50), milliseconds(report.overall.p95), "", "", "", ""]);
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [
    `pnpm bench at the ${report.scale === "brief" ? "brief's" : "demo's"} scale, in memory`,
    `Data: ${thousands(report.items)} items (${count("confluence", "Confluence pages")}, ${count("jira", "Jira issues")}, ` +
      `${count("slack", "Slack channels")} and ${count("drive", "Drive files")}) in ${report.projects} projects, the 26 hand-written items included.`,
    `Generated in ${seconds(report.generateMs)} and indexed in ${seconds(report.buildMs)}. After indexing, the heap holds ` +
      `${thousands(report.heapMb)} MB more than before, and the process ${thousands(report.rssMb)} MB in all.`,
    `Each person asked the same ${report.questions} questions, after one warm-up pass.`,
    "",
    line(header),
    ...rows.map(line),
    "",
    "Answered: replies built from at least one source the person may open, on topic or not, rather than the fixed reply.",
    "Checked: the documents search found that the access check decided on. Refused: the share of them kept from the writer, by that check or at the source.",
    "Audit entries: one per ranked candidate and one per access decision, among others.",
    `Slowest: "${report.slowest.question}", asked by ${report.slowest.person}: ${milliseconds(report.slowest.ms)} and ` +
      `${thousands(report.slowest.entries)} audit entries.`,
    `Machine: ${report.machine}.`
  ].join("\n");
}

// pathToFileURL makes the comparison work on Windows too, where argv[1] is "C:\...".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = args.findIndex(arg => arg === "--scale" || arg.startsWith("--scale="));
  const value = flag < 0 ? "brief" : args[flag].includes("=") ? args[flag].split("=")[1] : args[flag + 1];
  if (value !== "demo" && value !== "brief") throw new Error("--scale must be demo or brief");
  process.stdout.write(`${formatBench(await runBench({ scale: value }))}\n`);
}
