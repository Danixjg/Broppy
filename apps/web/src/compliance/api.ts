// The one client the compliance console talks to the API with. Every call carries the identity the page is
// showing: the demo persona when the page is in the demo, the session otherwise.

import { call } from "../tasks/api";
import type { TraceEntry, TraceResult } from "../workspace/api";

export type { TraceEntry, TraceResult };

export type AuditEntry = {
  sequence: number;
  timestamp: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  hash: string;
};

export type MerkleBatch = { firstSequence: number; lastSequence: number; root: string; sealedAt: string };

export type MerkleProof = { leaf: string; root: string; siblings: { hash: string; position: "left" | "right" }[] };

export type AuditPayload = { entries: AuditEntry[]; batches: MerkleBatch[]; chainValid: boolean };

export type ProofResponse = { proof: MerkleProof };

export type VerifyResponse = { verified?: boolean; valid?: boolean; local?: boolean };

export async function loadAudit(): Promise<AuditPayload> {
  return call<AuditPayload>("/v1/audit");
}

export async function searchAudit(query: string, from?: string, to?: string): Promise<{ entries: AuditEntry[] }> {
  const params = new URLSearchParams({ q: query, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return call<{ entries: AuditEntry[] }>(`/v1/audit/search?${params}`);
}

export async function sealAudit(): Promise<{ batch: MerkleBatch | null }> {
  return call<{ batch: MerkleBatch | null }>("/v1/audit/seal", { method: "POST", body: {} });
}

export async function loadProof(sequence: number): Promise<ProofResponse> {
  return call<ProofResponse>(`/v1/audit/proof?sequence=${sequence}`);
}

export async function verifyAudit(sequence: number): Promise<VerifyResponse> {
  return call<VerifyResponse>("/v1/audit/verify", { method: "POST", body: { sequence } });
}

export async function loadTrace(traceId: string): Promise<TraceResult> {
  return call<TraceResult>(`/v1/trace?traceId=${encodeURIComponent(traceId)}`);
}
