// The one client the sync health surface talks to the API with. Every call carries the identity the page is
// showing: the demo persona when the page is in the demo, the session otherwise.

import { call } from "../tasks/api";

export type HealthJob = { status: string; found: number; indexed: number; failed: number; finishedAt?: string };

export type HealthSource = {
  source: string;
  status: string;
  scope?: string;
  connectedAt?: string;
  error?: string;
  items: number;
  lastSync?: string;
  job?: HealthJob;
  pending?: number;
};

export type HealthResponse = { sources: HealthSource[]; live?: boolean; auditEntries?: number; merkleBatches?: number };

export async function loadHealth(): Promise<HealthResponse> {
  return call<HealthResponse>("/v1/sync-health");
}

export async function syncNow(): Promise<{ results: { source: string; ok: boolean; error?: string }[] }> {
  return call<{ results: { source: string; ok: boolean; error?: string }[] }>("/v1/admin/sync", { method: "POST", body: {} });
}
