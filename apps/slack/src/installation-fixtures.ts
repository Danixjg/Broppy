import type { User } from "../../../packages/types/src/index.js";
import type { ActiveInstallation, BotGrant, InstallationRegistry, InstallationStatus, InstallAttempt } from "./installations.js";
import type { TrustedRuntime } from "./runtime.js";
export const admin: User = { id: "maya", name: "Maya", email: "maya@example.test", role: "admin", groups: [], contractor: false,
  active: true, auth0Sub: "auth0|maya", orgId: "org-a", platformIdentities: { slack: "maya@example.test", jira: "maya@example.test", confluence: "maya@example.test", drive: "maya@example.test" } };
export function testRuntime(orgId = "org-a"): TrustedRuntime {
  return { orgId, apiUrl: `https://${orgId}.api.test`, serviceToken: `${orgId}-service-${"x".repeat(32)}`, webUrl: `https://${orgId}.web.test`,
    storeUrl: `https://${orgId}.store.test`, storeKey: `${orgId}-store-key`, people: [{ slackId: "UMAYA", name: "Maya" }], channelProjects: { CDB: "DB" },
    defaultProject: "DB", threshold: 0.6, jiraBaseUrl: "https://x.atlassian.net", destinations: [{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA"], disclosureFields: ["summary", "permalink"] }],
    completionPolicies: [{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA"] }] };
}
interface StoredAttempt { value: InstallAttempt; hash: string; consumed: boolean; expires: number; completed: boolean }
interface StoredInstallation { active?: ActiveInstallation; status: Exclude<InstallationStatus, { state: "not_installed" }>; lastAttempt: number }
export class TestInstallationRegistry implements InstallationRegistry {
  readonly attempts: StoredAttempt[] = [];
  readonly installations = new Map<string, StoredInstallation>();
  clock = Date.now();
  private sequence = 0;
  readonly lookups: Array<{ appId: string; teamId: string }> = [];
  async begin(orgId: string, appId: string, hash: string, person: string, personSub: string): Promise<void> {
    this.attempts.push({ value: { attemptId: ++this.sequence, orgId, appId, person, personSub }, hash, consumed: false, expires: this.clock + 600_000, completed: false });
  }
  async consume(orgId: string, appId: string, hash: string): Promise<InstallAttempt | undefined> {
    const attempt = this.attempts.find(a => a.value.orgId === orgId && a.value.appId === appId && a.hash === hash && !a.consumed && a.expires > this.clock);
    if (!attempt) return undefined;
    attempt.consumed = true; return attempt.value;
  }
  async publish(attempt: InstallAttempt, grant: BotGrant, runtime: TrustedRuntime): Promise<boolean> {
    const flow = this.attempts.find(a => a.value.attemptId === attempt.attemptId && a.consumed && !a.completed && a.expires > this.clock);
    const key = `${attempt.orgId}/${attempt.appId}`;
    const old = this.installations.get(key);
    if (!flow || runtime.orgId !== attempt.orgId || grant.appId !== attempt.appId || (old && (old.status.teamId !== grant.teamId || old.lastAttempt >= attempt.attemptId))
      || [...this.installations.values()].some(i => i.active?.appId === grant.appId && i.status.teamId === grant.teamId && i.active.orgId !== attempt.orgId)
      || [...this.installations.entries()].some(([owner,i]) => owner !== key && owner.endsWith(`/${grant.appId}`) && i.status.teamId === grant.teamId)) return false;
    const generation = (old?.status.generation ?? 0) + 1;
    this.installations.set(key, { active: { appId: grant.appId, teamId: grant.teamId, orgId: attempt.orgId, botUserId: grant.botUserId, generation, accessToken: grant.accessToken, runtime },
      status: { state: "active", teamId: grant.teamId, teamName: grant.teamName, generation, installedAt: new Date(this.clock).toISOString() }, lastAttempt: attempt.attemptId });
    flow.completed = true; return true;
  }
  async status(orgId: string, appId: string): Promise<InstallationStatus> { return this.installations.get(`${orgId}/${appId}`)?.status ?? { state: "not_installed", configured: true }; }
  async resolve(appId: string, teamId: string): Promise<ActiveInstallation | undefined> { this.lookups.push({ appId, teamId }); return [...this.installations.values()].find(i => i.active?.appId === appId && i.status.teamId === teamId)?.active; }
  async current(appId: string, teamId: string, generation: number): Promise<boolean> { return [...this.installations.values()].some(i => i.active?.appId === appId && i.status.teamId === teamId && i.active.generation === generation); }
  async refresh(orgId: string, appId: string, generation: number, runtime: TrustedRuntime): Promise<boolean> {
    const old = this.installations.get(`${orgId}/${appId}`);
    if (!old?.active || old.active.generation !== generation || runtime.orgId !== orgId) return false;
    old.active = { ...old.active, generation: generation + 1, runtime }; old.status = { ...old.status, generation: generation + 1 }; return true;
  }
  async deactivate(orgId: string, appId: string, teamId: string, generation: number, reason: "disconnected" | "uninstalled"): Promise<boolean> {
    const old = this.installations.get(`${orgId}/${appId}`);
    if (!old?.active || old.active.teamId !== teamId || old.active.generation !== generation) return false;
    old.active = undefined; old.status = { ...old.status, state: reason, generation: generation + 1 };
    for (const attempt of this.attempts) if (attempt.value.orgId === orgId && attempt.value.appId === appId && !attempt.completed) attempt.expires = this.clock;
    return true;
  }
  async seed(teamId: string, orgId: string, token = `xoxb-${teamId}`): Promise<void> {
    await this.begin(orgId,"AAPP",`${orgId}-${teamId}-${this.sequence}`,"maya","auth0|maya");
    const flow = this.attempts.at(-1);
    if (!flow) throw new Error("Expected test attempt");
    flow.consumed = true;
    if (!await this.publish(flow.value,{ appId: "AAPP", teamId, teamName: teamId, botUserId: "UBOT", scopes: [], accessToken: token },testRuntime(orgId))) throw new Error("Test install collision");
  }
}
