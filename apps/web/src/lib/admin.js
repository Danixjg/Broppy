// Pure helpers for the admin view: what a source's own permissions mean, in the words of that source, so an
// admin knows which fields may be narrowed and which may not.

/**
 * @param {string} source
 * @param {any} native
 * @returns {string}
 */
export function nativeRestriction(source, native) {
  if (!native || native.source !== source) return "Native permission details are unavailable.";
  switch (source) {
    case "slack":
      return `Slack channel ${native.channelId}: visibility is ${native.visibility}; members control private channel access. You may change public to private or remove members.`;
    case "jira":
      return `Jira project ${native.projectKey}: projectViewers control project access; issueViewers further restrict this issue when present. Remove viewers to narrow.`;
    case "confluence":
      return `Confluence space ${native.spaceKey}: spaceViewers control space access; pageViewers further restrict this page when present. Remove viewers to narrow.`;
    case "drive":
      return `Drive file ${native.fileId}: owner ${native.owner} remains fixed; remove sharedUsers to narrow.`;
    default:
      return "Unknown source restrictions.";
  }
}
