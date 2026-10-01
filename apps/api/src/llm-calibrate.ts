import { pathToFileURL } from "node:url";
import { loadMockCorpus } from "@brain/connectors";
import { chunk, SEMANTIC_MIN, type SemanticEmbeddingClient } from "@brain/retrieval";
import { modelsFromEnv } from "./llm-budget.js";

/** Questions with the mock documents that should match them. The last three share no keywords with their documents. */
export const CALIBRATION: ReadonlyArray<{ question: string; relevant: readonly string[] }> = [
  { question: "What's the status of the database migration project and were there any blockers raised in Slack last week?",
    relevant: ["jira:DB-12", "jira:DB-15", "slack:db-migration", "slack:db-oncall", "slack:db-planning",
      "confluence:db-migration-plan"] },
  { question: "What's the latest runbook for the payment-service incident?",
    relevant: ["confluence:payment-service-runbook", "drive:runbook-2025"] },
  { question: "What does PAY-101 need before cutover?",
    relevant: ["jira:PAY-101", "jira:SEC-44", "confluence:payment-master", "drive:cutover-plan", "slack:payments-cutover"] },
  { question: "Show me the security incident report from the Q3 breach",
    relevant: ["confluence:q3-incident", "slack:sec-incident"] },
  { question: "Payment gateway operations", relevant: ["confluence:gateway-operations"] },
  { question: "How do we handle a chargeback dispute?", relevant: ["drive:chargeback-guide"] },
  { question: "Who owns the vendor handshake test?", relevant: ["slack:vendor-integration"] },
  { question: "When does money movement switch over to the new platform?",
    relevant: ["jira:PAY-101", "drive:cutover-plan", "confluence:payment-master", "slack:payments-cutover"] },
  { question: "Is the ledger move stuck on anything?", relevant: ["jira:DB-15", "slack:db-migration", "jira:DB-12"] },
  { question: "What should on-call do first when card payments fail?", relevant: ["confluence:payment-service-runbook"] }
];

function cosine(a: number[], b: number[]): number {
  let dot = 0, aNorm = 0, bNorm = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] ?? 0;
};

export interface Calibration {
  relevant: number[];
  irrelevant: number[];
  /** A cut-off between the irrelevant pairs' 95th percentile and the relevant pairs' 25th percentile. */
  suggestion: number;
}

/** Embeds the mock corpus the way the index does, then scores every labelled question against every document. */
export async function calibrate(embedding: SemanticEmbeddingClient): Promise<Calibration> {
  const { connectors } = loadMockCorpus();
  const docs = (await Promise.all(Object.values(connectors).map(connector => connector.listItems()))).flat();
  const vectors: Array<[string, number[]]> = [];
  for (const doc of docs) {
    for (const item of chunk(doc)) vectors.push([doc.docId, await embedding.embed(`${doc.title} ${item.text}`)]);
  }
  const relevant: number[] = [];
  const irrelevant: number[] = [];
  for (const { question, relevant: ids } of CALIBRATION) {
    const vector = await embedding.embed(question);
    for (const [docId, docVector] of vectors) (ids.includes(docId) ? relevant : irrelevant).push(cosine(vector, docVector));
  }
  const suggestion = Number(((quantile(irrelevant, 0.95) + quantile(relevant, 0.25)) / 2).toFixed(2));
  return { relevant, irrelevant, suggestion };
}

export function formatCalibration(result: Calibration): string {
  const f = (value: number) => value.toFixed(2);
  const missed = result.relevant.filter(score => score < SEMANTIC_MIN).length;
  const noise = result.irrelevant.filter(score => score >= SEMANTIC_MIN).length;
  return [
    `Matching pairs (${result.relevant.length}): lowest ${f(Math.min(...result.relevant))}, ` +
      `25th percentile ${f(quantile(result.relevant, 0.25))}, median ${f(quantile(result.relevant, 0.5))}`,
    `Non-matching pairs (${result.irrelevant.length}): median ${f(quantile(result.irrelevant, 0.5))}, ` +
      `95th percentile ${f(quantile(result.irrelevant, 0.95))}, highest ${f(Math.max(...result.irrelevant))}`,
    `Today's SEMANTIC_MIN ${f(SEMANTIC_MIN)} misses ${missed} matching pairs and lets in ${noise} non-matching ones.`,
    `Suggested SEMANTIC_MIN: ${f(result.suggestion)} (set it in packages/retrieval/src/index.ts).`
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { embedding } = modelsFromEnv(process.env);
  if (!embedding) {
    console.error("Semantic search isn't configured. Set HUNYUAN_EMBEDDING_API_KEY, LLM_USAGE_FILE and " +
      "EMBEDDING_TOKEN_BUDGET in .env.local. The Groq route keeps semantic search off.");
    process.exit(1);
  }
  console.log(formatCalibration(await calibrate(embedding)));
  const usage = embedding.meter.usage();
  console.log(`\nCounted so far: ${usage.embeddingTokens.toLocaleString("en-US")} embedding tokens.`);
}
