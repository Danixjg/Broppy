// Pure helpers for the sync health view: what a source's state means in words an admin can act on, and how
// long ago it last synced. The source's own error text is kept beside the words, never instead of them.

/**
 * "3 minutes ago", for when a source last synced; the exact time is in the title.
 *
 * @param {string} value
 * @returns {string}
 */
export function timeAgo(value) {
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"]]) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "";
}

/**
 * What went wrong, in words an admin can act on.
 *
 * @param {string} error
 * @returns {string}
 */
export function plainSourceError(error = "") {
  if (/credential was rejected|reconnect the source|\(401\)|\(403\)/i.test(error)) return "Broppy's access was turned off or expired. Reconnect it.";
  if (/Reading stopped before it finished/i.test(error)) return "Reading stopped part-way. It carries on at the next sync, or press Sync now.";
  if (/\(429\)|rate/i.test(error)) return "The tool asked Broppy to slow down. It tries again at the next sync.";
  if (/timed? ?out|aborted|fetch failed|\(5\d\d\)/i.test(error)) return "The tool didn't answer in time. Broppy tries again at the next sync.";
  return "The last sync didn't finish. Press Sync now, or reconnect it.";
}

/**
 * One plain line for where a source stands, from the API's view of this company only.
 *
 * @param {any} item
 * @param {boolean} isAdmin
 * @returns {{ text: string, kind: string, detail?: string }}
 */
export function healthLine(item, isAdmin) {
  if (item.status === "Not connected") {
    return { text: isAdmin ? "Not connected" : "Not connected · your admin can connect it", kind: "muted" };
  }
  if (item.status === "Error") {
    return { text: `Needs attention: ${plainSourceError(item.error)}`, kind: "bad", detail: item.error };
  }
  if (item.job?.status === "running" || item.status === "Importing") {
    const done = item.job ? item.job.indexed : 0;
    return { text: item.job?.found ? `Reading · ${done} of ${item.job.found} items` : "Reading…", kind: "" };
  }
  if (item.job?.status === "failed") {
    return { text: "The last import failed. Try Sync now, or reconnect it.", kind: "bad" };
  }
  if ((!item.job || item.scope === "none") && item.items === 0) {
    return { text: "Connected · reading nothing yet. Choose what Broppy reads.", kind: "warn" };
  }
  if (item.items === 0) {
    return { text: "Connected · 0 items found. Check what Broppy reads, and that the connected account can see something.", kind: "warn" };
  }
  return {
    text: `Ready · ${item.items} item${item.items === 1 ? "" : "s"}${item.job?.failed ? ` · ${item.job.failed} couldn't be read` : ""}`,
    kind: "good"
  };
}
