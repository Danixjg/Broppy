import { AuditLog } from "@brain/audit";
import type { LlmClient, SemanticEmbeddingClient } from "@brain/retrieval";
import type { AuditEntry, QueryAnswer, QueryScope } from "@brain/types";
import { searchAudit } from "./audit-search.js";
import { Brain } from "./brain.js";
import { actorTrace } from "./server.js";

// The challenge brief's five scenarios, run on the demo data and written up as Markdown. Every claim in the text is
// computed from the run, so a change in behaviour changes the document. worked-examples.test.ts keeps
// docs/worked-examples.md equal to this output.

export interface WorkedExampleOptions {
  /** Writes the answers; the built-in writer when unset. */
  llm?: LlmClient;
  embedding?: SemanticEmbeddingClient;
  /** Sets the clock. Each step whose time matters calls it first. */
  at(iso: string): void;
  /** Who wrote the answers, for the introduction. */
  writer: string;
}

const DAY = "2026-10-15";
const MIGRATION =
  "What's the status of the database migration project and were there any blockers raised in Slack last week?";
const MIGRATION_ANY_TIME =
  "What's the status of the database migration project and were there any blockers raised in Slack?";
const RUNBOOK = "What's the latest runbook for the payment-service incident?";
const FAILOVER_STEP = "Step 4: if errors persist for ten minutes, fail over payment traffic to the standby region.";
const RUNBOOK_DOC = "confluence:payment-service-runbook";
const Q3 = "Show me the security incident report from the Q3 breach";
const ABSENT = "Show me the zebra onboarding notes from the Q9 offsite";
const PAY101 = "What does PAY-101 need before cutover?";
const AUDIT_QUESTION =
  "Show me everything user 'ravi' accessed related to the 'payment-gateway' Confluence space in the last 30 days";
const WHO_RETRIEVED = "Who retrieved the Payment gateway operations page?";

// UTC with fixed month names, so the text doesn't depend on the machine's time zone or locale.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");
const date = (iso: string) => {
  const value = new Date(iso);
  return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`;
};
const time = (iso: string) => {
  const value = new Date(iso);
  return `${two(value.getUTCHours())}:${two(value.getUTCMinutes())}`;
};
const when = (iso: string) => `${date(iso)}, ${time(iso)} UTC`;
const yes = (value: boolean) => (value ? "yes" : "no");
const code = (value: string) => `\`${value}\``;
const clip = (text: string) => (text.length > 90 ? `${text.slice(0, 87)}…` : text);
const PLATFORMS: Record<string, string> = { slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Drive" };

interface Asked {
  answer: QueryAnswer;
  /** Every audit entry of the query: the compliance view. */
  trace: AuditEntry[];
}

const docOf = (chunkId: string) => chunkId.slice(0, chunkId.lastIndexOf(":"));
const cites = (asked: Asked, docId: string) => asked.answer.citations.some(citation => citation.docId === docId);
const sentToWriter = (trace: AuditEntry[]) => {
  const chunks = trace.find(entry => entry.type === "context_sent")?.data.chunkIds;
  return new Set(Array.isArray(chunks) ? chunks.map(chunk => docOf(String(chunk))) : []);
};
const ownTrace = (asked: Asked) => actorTrace(asked.trace);
const mentions = (entries: unknown, text: string) => JSON.stringify(entries).includes(text);
const audited = (brain: Brain, type: string) => brain.audit.entries.some(entry => entry.type === type);

type FreshBrain = (hhmm: string) => Promise<Brain>;
type Ask = (brain: Brain, userId: string, question: string) => Promise<Asked>;
type Clock = (hhmm: string) => void;

export async function runWorkedExamples(options: WorkedExampleOptions): Promise<string> {
  const at: Clock = hhmm => options.at(`${DAY}T${hhmm}:00.000Z`);
  const freshBrain: FreshBrain = async hhmm => {
    at(hhmm);
    const brain = new Brain(options.llm, { embedding: options.embedding });
    await brain.syncAll();
    return brain;
  };
  const ask: Ask = async (brain, userId, question) => {
    let traceId: string | undefined;
    const answer = await brain.query(brain.user(userId)!, question, id => { traceId = id; });
    return { answer, trace: brain.audit.entries.filter(entry => entry.data.traceId === traceId) };
  };
  return [
    ...introduction(options.writer, options.llm !== undefined),
    ...await scenario1(freshBrain, ask),
    ...await scenario2(freshBrain, ask, at),
    ...await scenario3(freshBrain, ask),
    ...await scenario4(freshBrain, ask, at),
    ...await scenario5(freshBrain, ask, at)
  ].join("\n");
}

function introduction(writer: string, withModel: boolean): string[] {
  return [
    withModel ? "# Worked examples with a language model" : "# Worked examples",
    "",
    withModel
      ? "The challenge brief's five scenarios, run end to end on the demo data with a language model. " +
        "`pnpm scenarios:model` writes this file; `worked-examples.md` has the same steps with the built-in writer."
      : "The challenge brief's five scenarios, run end to end on the demo data. `pnpm scenarios` writes this file, and " +
        "`pnpm test` fails when it no longer matches what the code does, so every answer, citation and audit entry " +
        "below is real output.",
    "",
    "- **Date:** Thursday 15 October 2026, UTC. Demo content is dated relative to the clock, so \"last week\" finds it.",
    `- **Writer:** ${writer}`,
    "- **People:** David is the engineer in the brief, Ravi heads payments, Maya is an admin, Nur works in " +
      "compliance, Alex is an intern and Wei Ming is a contractor.",
    "- **Decision tables** are the compliance view of the audit trail. The person asking sees only their own trace, " +
      "which never names what they couldn't see.",
    ""
  ];
}

function readAs(scope?: QueryScope): string {
  if (!scope) return "every platform, any date";
  const named = scope.sources.map(source => PLATFORMS[source] ?? source).join(", ");
  const range = scope.from && scope.to ? `${date(scope.from)} to ${date(scope.to)}` : undefined;
  if (named && range) return `${named} first, and ${named} only from ${range}; other platforms at any date`;
  if (named) return `${named} first; any date`;
  return range ? `every platform, from ${range}` : "every platform, any date";
}

function quote(asked: Asked): string[] {
  const lines = asked.answer.text.split("\n").map(line => `> ${line}`);
  const fallback = asked.trace.find(entry => entry.type === "llm_fallback")?.data.reason;
  if (typeof fallback === "string") lines.push("", `*Written by the built-in writer instead of the model (${fallback}).*`);
  return lines;
}

function citations(answer: QueryAnswer): string[] {
  if (!answer.citations.length) return ["No citations."];
  return [
    "| Cited | Title | Version | Last edited |",
    "| --- | --- | --- | --- |",
    ...answer.citations.map(citation =>
      `| ${code(citation.docId)} | ${citation.title} | ${citation.version} | ${when(citation.updatedAt)} |`)
  ];
}

interface Checks { score?: number; access?: boolean; live?: string; output?: boolean }

// Every check each document went through, in ranking order, from a query's full trace.
function checks(trace: AuditEntry[]): Map<string, Checks> {
  const rows = new Map<string, Checks>();
  for (const entry of trace) {
    const docId = entry.data.docId;
    if (typeof docId !== "string") continue;
    const row = rows.get(docId) ?? {};
    if (entry.type === "candidate_ranked" && typeof entry.data.score === "number") row.score = entry.data.score;
    if (entry.type === "access_decision") row.access = entry.data.allowed === true;
    if (entry.type === "live_access_decision") {
      row.live = entry.data.allowed === true
        ? `allowed, v${entry.data.sourceVersion}${entry.data.refreshed === true ? ", refreshed" : ""}`
        : "**denied**";
    }
    if (entry.type === "output_access_decision") row.output = entry.data.allowed === true;
    rows.set(docId, row);
  }
  return rows;
}

const verdict = (value?: boolean) => (value === undefined ? "–" : value ? "allowed" : "**denied**");

function decisions(asked: Asked): string[] {
  const sent = sentToWriter(asked.trace);
  return [
    "| Document | Match | Access check | Live check at the source | Sent to the writer | Rechecked after writing | Cited |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...[...checks(asked.trace)].map(([docId, row]) => `| ${code(docId)} | ` +
      `${row.score === undefined ? "–" : row.score.toFixed(2)} | ${verdict(row.access)} | ${row.live ?? "–"} | ` +
      `${yes(sent.has(docId))} | ${verdict(row.output)} | ${yes(cites(asked, docId))} |`)
  ];
}

async function scenario1(freshBrain: FreshBrain, ask: Ask): Promise<string[]> {
  const brain = await freshBrain("09:00");
  const david = await ask(brain, "david", MIGRATION);
  const anyTime = await ask(brain, "david", MIGRATION_ANY_TIME);
  const ravi = await ask(brain, "ravi", MIGRATION);
  const own = ownTrace(david);
  const onCall = ravi.answer.text.split("\n").find(line => line.includes("[slack:db-oncall:"));
  return [
    "## Scenario 1: one question across platforms",
    "",
    `**The brief.** An engineer asks "${MIGRATION}" The answer should combine Jira issues with Slack messages from ` +
      "channels the engineer belongs to, cite them, and leave out private channels the engineer isn't in.",
    "",
    "### David asks",
    "",
    `Read as: ${readAs(david.answer.scope)}.`,
    "",
    ...quote(david),
    "",
    ...citations(david.answer),
    "",
    "**How each document was decided:**",
    "",
    ...decisions(david),
    "",
    `- ${code("slack:db-oncall")} is a private channel David isn't in. It was denied before anything reached the ` +
      `writer. David's own trace has ${own.length} events and mentions it: ${yes(mentions(own, "db-oncall"))}.`,
    `- ${code("slack:db-planning")}, three weeks old, is outside "last week". Asked without "last week", it reaches ` +
      `the writer: ${yes(sentToWriter(anyTime.trace).has("slack:db-planning"))}.`,
    "",
    "### Ravi asks the same question",
    "",
    `Ravi is in #db-oncall, so his answer cites it: ${yes(cites(ravi, "slack:db-oncall"))}.` +
      (onCall ? ` It adds:\n\n> ${onCall}` : ""),
    "",
    "![David's answer in the workspace](images/s1-david.png)",
    "",
    "![David's own trace](images/s1-trace.png)",
    ""
  ];
}

async function scenario2(freshBrain: FreshBrain, ask: Ask, at: Clock): Promise<string[]> {
  const brain = await freshBrain("12:00");
  const synced = brain.index.documents.get(RUNBOOK_DOC)!.version;
  at("13:00");
  const runbook = (await brain.connectors.confluence.fetchDocument(RUNBOOK_DOC))!;
  // Edited in Confluence itself: no sync runs before the question.
  brain.connectors.confluence.updateContent(RUNBOOK_DOC, `${runbook.content} ${FAILOVER_STEP}`);
  at("14:05");
  const david = await ask(brain, "david", RUNBOOK);
  const cited = david.answer.citations.find(citation => citation.docId === RUNBOOK_DOC);
  const refreshed = david.trace.some(entry => entry.type === "live_access_decision" &&
    entry.data.docId === RUNBOOK_DOC && entry.data.refreshed === true);
  return [
    "## Scenario 2: fresh content",
    "",
    `**The brief.** At 2:05 PM someone asks "${RUNBOOK}" The answer must include the failover step added to the ` +
      "Confluence runbook at 1:00 PM, and outdated content must never be served as current.",
    "",
    `- **12:00** The Brain syncs. The runbook is version ${synced}, with steps 1 to 3.`,
    "- **13:00** Step 4 is added in Confluence itself. No sync runs.",
    "- **14:05** David asks.",
    "",
    ...quote(david),
    "",
    ...citations(david.answer),
    "",
    `- Step 4 is in the answer: ${yes(david.answer.text.includes(FAILOVER_STEP))}. The runbook is cited as version ` +
      `${cited?.version ?? "–"}, edited ${cited ? when(cited.updatedAt) : "–"}.`,
    "- Before anything reaches the writer, the Brain checks each document's version and permissions at the source. " +
      `It refreshed the runbook then: ${yes(refreshed)}.`,
    `- The superseded 2025 copy, ${code("drive:runbook-2025")}, is cited: ${yes(cites(david, "drive:runbook-2025"))}.`,
    "",
    "![David's answer with the new step](images/s2-david.png)",
    ""
  ];
}

async function scenario3(freshBrain: FreshBrain, ask: Ask): Promise<string[]> {
  const brain = await freshBrain("10:00");
  const wei = await ask(brain, "wei", Q3);
  const absent = await ask(brain, "wei", ABSENT);
  const alex = await ask(brain, "alex", Q3);
  const ravi = await ask(brain, "ravi", PAY101);
  const shape = (asked: Asked) =>
    JSON.stringify(ownTrace(asked).map(({ sequence, type, data }) => ({ sequence, type, data })));
  const refused = wei.trace.filter(entry => entry.type === "access_decision" && entry.data.allowed === false)
    .map(entry => code(String(entry.data.docId)));
  const sent = sentToWriter(wei.trace).size;
  const platforms = new Set(ravi.answer.citations.map(citation => citation.docId.split(":")[0]));
  return [
    "## Scenario 3: no hint that restricted content exists",
    "",
    `**The brief.** A contractor asks "${Q3}", which lives in a security-only Confluence space. The reply must ` +
      "contain nothing from it, and must neither confirm nor deny that it exists.",
    "",
    "| Who | Question | Reply |",
    "| --- | --- | --- |",
    `| Wei Ming, contractor | ${Q3} | ${wei.answer.text} |`,
    `| Wei Ming | ${ABSENT} (a topic that doesn't exist) | ${absent.answer.text} |`,
    `| Alex, intern | ${Q3} | ${alex.answer.text} |`,
    "",
    `- Wei's two replies are identical: ${yes(JSON.stringify(wei.answer) === JSON.stringify(absent.answer))}. So ` +
      `are his own traces: ${yes(shape(wei) === shape(absent))}, with ${ownTrace(wei).length} event each, an empty ` +
      "answer.",
    `- The compliance view shows what was refused for him: ${refused.length ? refused.join(", ") : "nothing"}. ` +
      `Passages sent to the writer for him: ${sent || "none"}.`,
    `- Ravi, who may see payments material, asks "${PAY101}" and gets a cited answer from ${platforms.size} ` +
      "platforms.",
    "",
    "![Wei Ming's reply](images/s3-wei.png)",
    ""
  ];
}

async function scenario4(freshBrain: FreshBrain, ask: Ask, at: Clock): Promise<string[]> {
  const brain = await freshBrain("11:00");
  const maya = brain.user("maya")!;
  const david = brain.user("david")!;
  const before = await ask(brain, "david", MIGRATION);
  at("11:05");
  await brain.removeSlackMember(maya, "slack:db-migration", david.id);
  at("11:06");
  const after = await ask(brain, "david", MIGRATION);
  const jira = after.answer.citations.filter(citation => citation.docId.startsWith("jira:"))
    .map(citation => code(citation.docId));

  at("11:10");
  const runbookBefore = await ask(brain, "david", RUNBOOK);
  at("11:15");
  const current = (await brain.connectors.confluence.fetchPermissions(RUNBOOK_DOC))!;
  if (current.native?.source !== "confluence") throw new Error("Expected Confluence permissions");
  await brain.setNativePermissions(maya, RUNBOOK_DOC, { ...current, native: { ...current.native,
    pageViewers: (current.native.pageViewers ?? []).filter(email => email !== david.email) } });
  at("11:16");
  const runbookAfter = await ask(brain, "david", RUNBOOK);
  const ravi = await ask(brain, "ravi", RUNBOOK);
  return [
    "## Scenario 4: access changes apply to the next question",
    "",
    "**The brief.** After a revocation, such as removal from a Slack channel or a restricted Confluence page, later " +
      "answers must reflect it.",
    "",
    "### Maya removes David from #db-migration",
    "",
    `- **11:00** David asks the scenario 1 question. His answer cites ${code("slack:db-migration")}: ` +
      `${yes(cites(before, "slack:db-migration"))}.`,
    `- **11:05** Maya removes him from the channel. The audit records ${code("channel_membership_removed")}: ` +
      `${yes(audited(brain, "channel_membership_removed"))}.`,
    `- **11:06** David asks again. His answer cites the channel: ${yes(cites(after, "slack:db-migration"))}. It ` +
      `still cites Jira: ${jira.length ? jira.join(", ") : "none"}.`,
    "",
    ...quote(after),
    "",
    "### Maya restricts the runbook page",
    "",
    `- **11:10** David asks "${RUNBOOK}" His answer cites the runbook: ${yes(cites(runbookBefore, RUNBOOK_DOC))}.`,
    `- **11:15** Maya removes him from the page's viewers. The audit records ${code("native_permission_changed")}: ` +
      `${yes(audited(brain, "native_permission_changed"))}.`,
    `- **11:16** David asks again. His answer cites the runbook: ${yes(cites(runbookAfter, RUNBOOK_DOC))}. His own ` +
      `trace mentions it: ${yes(mentions(ownTrace(runbookAfter), "payment-service-runbook"))}. His answer now reads:`,
    "",
    ...quote(runbookAfter),
    "",
    `- Ravi asks the same question. His answer cites the runbook: ${yes(cites(ravi, RUNBOOK_DOC))}.`,
    "",
    "![David's answer after leaving the channel](images/s4-david.png)",
    ""
  ];
}

// One row per question an audit search found: the entries are grouped by the query they belong to.
function questions(entries: AuditEntry[]): string[] {
  const traces = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const key = String(entry.data.traceId ?? entry.sequence);
    traces.set(key, [...(traces.get(key) ?? []), entry]);
  }
  return [
    "| Entries | Time | Question | Documents checked | Refused | Sent to the writer | Answer |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...[...traces.values()].map(trace => {
      const asked = trace.find(entry => entry.type === "query_received")?.data.question;
      const answer = trace.find(entry => entry.type === "answer_returned");
      const refused = [...checks(trace)].filter(([, row]) =>
        row.access === false || row.live === "**denied**" || row.output === false).map(([docId]) => code(docId));
      const first = answer?.data.empty === true ? "the fixed reply" : `"${clip(String(answer?.data.answer ?? "").split("\n")[0])}"`;
      return `| ${trace[0].sequence}–${trace[trace.length - 1].sequence} | ${time(trace[0].timestamp)} | ` +
        `"${String(asked)}" | ${trace.filter(entry => entry.type === "access_decision").length} | ` +
        `${refused.join(", ") || "none"} | ${sentToWriter(trace).size} documents | ${first} |`;
    })
  ];
}

async function scenario5(freshBrain: FreshBrain, ask: Ask, at: Clock): Promise<string[]> {
  const brain = await freshBrain("09:00");
  at("09:30");
  await ask(brain, "ravi", "Payment gateway operations");
  at("09:40");
  await ask(brain, "ravi", "PAY-101 cutover");
  at("09:50");
  await ask(brain, "alex", "Executive milestones staged cutover decisions");
  at("16:00");
  const documents = [...brain.index.documents.values()].map(doc => ({ docId: doc.docId, title: doc.title }));
  const search = (q: string) =>
    searchAudit(brain.audit.entries, new URLSearchParams({ q }), brain.users, new Date(), documents);
  const activity = search(AUDIT_QUESTION);
  const { filters } = activity;
  const inSpace = [...new Set(activity.entries.filter(entry => entry.data.space === filters.space)
    .map(entry => String(entry.data.docId)))];
  const spaceChecks = checks(activity.entries);
  const sent = sentToWriter(activity.entries);
  const answered = activity.entries.filter(entry => entry.type === "answer_returned");
  const retrieved = search(WHO_RETRIEVED);
  const readers = [...new Set(retrieved.entries.filter(entry => entry.type === "context_sent")
    .map(entry => brain.user(entry.actor)?.name ?? entry.actor))];

  const chainValid = brain.audit.verifyChain();
  const batch = brain.audit.seal()!;
  const answer = answered[0];
  const proof = answer ? brain.audit.proof(answer.sequence) : undefined;
  const loads = (entries: AuditEntry[]) => {
    try {
      new AuditLog({ initial: { entries, batches: brain.audit.batches } });
      return "accepted";
    } catch (error) {
      return `refused ("${error instanceof Error ? error.message : "error"}")`;
    }
  };
  const changed = brain.audit.entries;
  if (answer) changed[answer.sequence - 1].data.answer = "Nothing to report.";
  const deleted = brain.audit.entries;
  const removed = deleted.splice(Math.floor(deleted.length / 2), 1)[0];

  return [
    "## Scenario 5: the audit trail answers compliance questions",
    "",
    "**The brief.** Compliance can reconstruct what any user asked, what was retrieved for them and what was " +
      "answered, with times and authorization decisions. The example is \"Show me everything user 'jdoe' accessed " +
      "related to the 'payment-gateway' Confluence space in the last 30 days\". Here Ravi stands in for 'jdoe'.",
    "",
    "Earlier that day, Ravi asks \"Payment gateway operations\" at 09:30 and \"PAY-101 cutover\" at 09:40, and Alex " +
      "asks \"Executive milestones staged cutover decisions\" at 09:50.",
    "",
    "### Nur searches the audit trail at 16:00",
    "",
    `> ${AUDIT_QUESTION}`,
    "",
    `Read as: user ${code(String(filters.user))}, source ${code(String(filters.source))}, space ` +
      `${code(String(filters.space))}, from ${filters.from ? when(filters.from) : "–"} to ` +
      `${filters.to ? when(filters.to) : "now"}. It finds ${activity.entries.length} entries, grouped here by ` +
      "question; the workspace's Compliance tab lists each one.",
    "",
    ...questions(activity.entries),
    "",
    ...inSpace.map(docId => {
      const row = spaceChecks.get(docId) ?? {};
      return `- From the ${code(String(filters.space))} space, ${code(docId)}. Access check: ${verdict(row.access)}; ` +
        `live check at the source: ${row.live ?? "–"}; sent to the writer: ${yes(sent.has(docId))}; rechecked after ` +
        `writing: ${verdict(row.output)}.`;
    }),
    "",
    "### Who retrieved a document",
    "",
    `> ${WHO_RETRIEVED}`,
    "",
    `Read as: document ${code(String(retrieved.filters.doc))}. Retrieved for: ${readers.join(", ") || "nobody"}.`,
    "",
    "### Tamper evidence",
    "",
    `- Every entry carries the hash of the one before it. The chain verifies: ${yes(chainValid)}.`,
    `- Nur seals the log into a Merkle batch of entries ${batch.firstSequence} to ${batch.lastSequence}. The proof ` +
      `for Ravi's answer, entry ${answer?.sequence ?? "–"}, verifies against it: ` +
      `${yes(Boolean(proof && AuditLog.verifyProof(proof, batch)))}.`,
    `- A copy of the log with that answer changed is ${loads(changed)}.`,
    `- A copy with entry ${removed?.sequence ?? "–"} deleted is ${loads(deleted)}.`,
    "",
    "![Nur's audit search](images/s5-nur.png)",
    "",
    "![A verified proof](images/s5-proof.png)",
    ""
  ];
}
