const stringList = value => Array.isArray(value) && value.every(item => typeof item === "string");
const subset = (next, current) => next.every(item => current.includes(item));
const restrictedList = (next, current) => current === undefined ? next === undefined || stringList(next) : stringList(next) && subset(next, current);

export function narrowerPermissionError(next, current, source) {
  if (!next || Array.isArray(next) || typeof next !== "object" || !current || !stringList(next.users) || !stringList(next.groups) || typeof next.public !== "boolean") return "Include users, groups, and public in the full permissions object.";
  if ((next.public && !current.public) || (!current.public && (!subset(next.users, current.users) || !subset(next.groups, current.groups)))) return "Indexed grants can only be removed.";
  const native = next.native;
  const previous = current.native;
  if (!native || Array.isArray(native) || typeof native !== "object" || !previous || native.source !== source || previous.source !== source) return "Include matching native source permissions.";
  switch (source) {
    case "slack":
      if (native.channelId !== previous.channelId || !["public", "private"].includes(native.visibility) || !stringList(native.members)) return "Keep the Slack channel ID, visibility, and members fields valid.";
      if (previous.visibility === "private" && (native.visibility !== "private" || !subset(native.members, previous.members))) return "Private Slack members can only be removed.";
      break;
    case "jira":
      if (native.projectKey !== previous.projectKey || !stringList(native.projectViewers) || !subset(native.projectViewers, previous.projectViewers) || !restrictedList(native.issueViewers, previous.issueViewers)) return "Keep the Jira project key and only remove project or issue viewers.";
      break;
    case "confluence":
      if (native.spaceKey !== previous.spaceKey || !stringList(native.spaceViewers) || !subset(native.spaceViewers, previous.spaceViewers) || !restrictedList(native.pageViewers, previous.pageViewers)) return "Keep the Confluence space key and only remove space or page viewers.";
      break;
    case "drive":
      if (native.fileId !== previous.fileId || native.owner !== previous.owner || !stringList(native.sharedUsers) || !subset(native.sharedUsers, previous.sharedUsers)) return "Keep the Drive file ID and owner, and only remove shared users.";
      break;
    default: return "Unknown source permissions.";
  }
  return null;
}
