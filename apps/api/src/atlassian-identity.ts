import type { SourceOAuth } from "./source-oauth.js";

/**
 * Finds a person's Atlassian account ID from their email, through the organization's shared Jira connection.
 * Jira and Confluence share account IDs, so one lookup serves both. A person who cannot be matched exactly is not found.
 */
export function atlassianAccountIds(oauth: Pick<SourceOAuth, "authorization" | "siteFor">, transport: typeof fetch = fetch) {
  const known = new Map<string, { at: number; id?: string }>();
  return async (email: string): Promise<string | undefined> => {
    const hit = known.get(email);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
    const [authorization, site] = await Promise.all([oauth.authorization("jira"), oauth.siteFor("jira")]);
    if (!authorization || !site) return undefined;
    const response = await transport(`https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=5`,
      { headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`Atlassian account lookup failed (${response.status})`);
    const list: unknown = await response.json();
    const people = (Array.isArray(list) ? list : []).filter((item: any) => item?.accountType === "atlassian" && typeof item.accountId === "string");
    // Atlassian may hide email addresses; a search for the full address that finds one person still names that person.
    const match = people.filter((item: any) => typeof item.emailAddress === "string" ? item.emailAddress.toLowerCase() === email : true);
    const id = match.length === 1 ? match[0].accountId as string : undefined;
    known.set(email, { at: Date.now(), id });
    return id;
  };
}
