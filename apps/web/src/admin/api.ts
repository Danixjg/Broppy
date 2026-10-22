// The one client the admin surface talks to the API with. Every call carries the identity the page is
// showing: the demo persona when the page is in the demo, the session otherwise.

import { call } from "../tasks/api";

export type SourcePermissions = {
  users: string[];
  groups: string[];
  public: boolean;
  native?: Record<string, unknown>;
};

export type PermissionsResponse = { docId: string; source: string; permissions: SourcePermissions };

export type PreviewDocument = { docId: string; title: string; tier?: string };

export type PreviewResponse = {
  user: { id: string; name: string };
  documents: PreviewDocument[];
  reasons: Record<string, string[]>;
};

export type SyncResult = { source: string; ok: boolean; error?: string };

export async function loadPermissions(docId: string): Promise<PermissionsResponse> {
  return call<PermissionsResponse>(`/v1/admin/permissions?docId=${encodeURIComponent(docId)}`);
}

export async function savePermissions(docId: string, permissions: unknown): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/admin/permissions", { method: "POST", body: { docId, permissions } });
}

export async function applyTier(docId: string, tier: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/admin/tier", { method: "POST", body: { docId, tier } });
}

export async function applyContent(docId: string, content: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/admin/content", { method: "POST", body: { docId, content } });
}

export async function removeGroup(userId: string, group: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/admin/group", { method: "POST", body: { userId, group } });
}

export async function removeChannelMember(docId: string, userId: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/admin/channel-member", { method: "POST", body: { docId, userId } });
}

export async function previewAccess(userId: string): Promise<PreviewResponse> {
  return call<PreviewResponse>(`/v1/admin/preview?user=${encodeURIComponent(userId)}`);
}
