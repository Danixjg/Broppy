import type { Deps } from "./config.js";
import type { Proposal, TaskLink } from "./store.js";

export const destinationPolicy = (deps: Deps, proposal: Proposal) => deps.destinations?.find(policy => policy.channel === proposal.suggestion.c && policy.project === proposal.suggestion.p);
export function validDestinationPolicy(policy: ReturnType<typeof destinationPolicy>): boolean {
  return Boolean(policy && Array.isArray(policy.allowedSlackIds) && policy.allowedSlackIds.length > 0 && policy.allowedSlackIds.length <= 100
    && policy.allowedSlackIds.every(id => typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id)) && Array.isArray(policy.disclosureFields)
    && policy.disclosureFields.includes("summary") && policy.disclosureFields.every(field => field === "summary" || field === "permalink"));
}
export function validIssueUrl(deps: Deps, url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && (!deps.jiraBaseUrl || parsed.origin === new URL(deps.jiraBaseUrl).origin); } catch { return false; }
}

export async function mayDiscloseIssue(deps: Deps, link: TaskLink, purpose: "tracking" | "completion"): Promise<boolean> {
  try {
    const policies = purpose === "tracking" ? deps.destinations : deps.completionPolicies;
    const policy = policies?.find(p => p.channel === link.channel && p.project === link.project);
    if (!policy || !Array.isArray(policy.allowedSlackIds) || !policy.allowedSlackIds.length || !deps.slack.members || !validIssueUrl(deps, link.issueUrl)) return false;
    const ownBot = await deps.slack.botUserId?.();
    const members = (await deps.slack.members(link.channel)).filter(id => id !== ownBot);
    if (!members.length || members.some(id => !policy.allowedSlackIds.includes(id))) return false;
    for (const id of members) {
      const email = await deps.slack.userEmail(id);
      if (!email) return false;
      const access = await deps.broppy.issueAccess(email, link.issueKey);
      if (access.key !== link.issueKey || (purpose === "completion" && access.statusCategory !== "done") || !validIssueUrl(deps, access.url)) return false;
    }
    return true;
  } catch { return false; }
}
