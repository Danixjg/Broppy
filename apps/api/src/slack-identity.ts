export function slackUserIdsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.SLACK_USERS_JSON) return {};
  const people: unknown = JSON.parse(env.SLACK_USERS_JSON);
  if (!Array.isArray(people)) throw new Error("SLACK_USERS_JSON must be a list");
  const result: Record<string, string> = {};
  const slackIds = new Set<string>();
  for (const person of people) {
    if (!person || typeof person !== "object") throw new Error("Invalid Slack identity mapping");
    const { brainUserId, slackId } = person as Record<string, unknown>;
    if (brainUserId === undefined) continue;
    if (typeof brainUserId !== "string" || !brainUserId || typeof slackId !== "string" || !/^[UW][A-Z0-9]+$/.test(slackId)
      || result[brainUserId] || slackIds.has(slackId)) throw new Error("Invalid Slack identity mapping");
    result[brainUserId] = slackId;
    slackIds.add(slackId);
  }
  return result;
}
