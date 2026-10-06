import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AuditLog, FileAuditStore } from "../packages/audit/src/index.js";
import { NO_RESULT } from "../packages/retrieval/src/index.js";
import { Brain } from "../apps/api/src/brain.js";
import { createApiServer } from "../apps/api/src/server.js";
import type { QueryAnswer } from "../packages/types/src/index.js";

process.env.ALLOW_DEMO_AUTH = "true";
const directory = mkdtempSync(join(tmpdir(), "broppy-rust-smoke-"));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const log = join(directory, "audit.jsonl");
const key = join(directory, "audit.pub.pem");
const anchors = join(directory, "anchors.jsonl");
writeFileSync(key, publicKey.export({ type: "spki", format: "pem" }));
const audit = new AuditLog({ store: new FileAuditStore(log), signingKey: privateKey });
const brain = new Brain(undefined, { corpus: "curated", audit });
const api = await createApiServer({ brain, startOrchestrator: false, corpus: "curated" });
await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));

try {
  const address = api.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const ask = async (user: string, question: string) => {
    const response = await fetch(`${base}/v1/query`, { method: "POST",
      headers: { "x-demo-user": user, "content-type": "application/json" }, body: JSON.stringify({ question }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<QueryAnswer>;
  };
  const allowed = await ask("maya", "What does PAY-101 need before cutover?");
  assert.notEqual(allowed.text, NO_RESULT);
  assert(allowed.citations.some(citation => citation.docId === "jira:PAY-101"));
  const denied = await ask("wei", "Show me the security incident report from the Q3 breach");
  assert.deepEqual({ text: denied.text, citations: denied.citations }, { text: NO_RESULT, citations: [] });
  const workspace = await fetch(`${base}/v1/workspace`, { headers: { "x-demo-user": "maya" } });
  assert.equal(workspace.status, 200);
  assert((await workspace.json()).projects.length > 0);
  const compliance = brain.users.find(user => user.role === "compliance");
  assert(compliance);
  const search = await fetch(`${base}/v1/audit/search?user=maya`, { headers: { "x-demo-user": compliance.id } });
  assert.equal(search.status, 200);
  const found = await search.json();
  assert(found.entries.length > 0 && found.entries.every((entry: { actor: string }) => entry.actor === "maya"));
  const batch = audit.seal();
  assert(batch);
  assert(audit.verifyChain());
  assert(audit.verifyBatches());
  const proof = audit.proof(batch.lastSequence);
  assert(proof && AuditLog.verifyProof(proof, batch));
  const restored = new AuditLog({ store: new FileAuditStore(log), verificationKey: publicKey });
  assert(restored.verifyChain() && restored.verifyBatches());
  assert.equal(restored.entries.length, audit.entries.length);
  for (const operation of ["publish", "verify"]) {
    const result = spawnSync("cargo", ["run", "--quiet", "--locked", "-p", "brain-anchor", "--", operation,
      "--log", log, "--pubkey", key, "--anchors", anchors], { stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `brain-anchor ${operation}`);
  }
  console.log(`Rust HTTP, authorization, grounding, workspace, audit search, signed audit restore, and independent anchor checks passed. Artifacts: ${directory}`);
} finally {
  api.orchestrator.stop();
  await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()));
}
