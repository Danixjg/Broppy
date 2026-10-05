// Answer and audit helpers for the workspace. They touch no page, so node checks them (answer.nodecheck.js).

const text = value => typeof value === "string" ? value : "";

/** One entry per cited document, numbered in the order the answer first cites it. Citations come one per passage. */
export function numberSources(citations) {
  const sources = [];
  const byDoc = new Map();
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || typeof citation.docId !== "string" || typeof citation.chunkId !== "string") continue;
    let source = byDoc.get(citation.docId);
    if (!source) {
      const { chunkId: _chunkId, ...rest } = citation;
      source = { ...rest, number: sources.length + 1, chunkIds: [] };
      byDoc.set(citation.docId, source);
      sources.push(source);
    }
    if (!source.chunkIds.includes(citation.chunkId)) source.chunkIds.push(citation.chunkId);
  }
  return sources;
}

/**
 * The answer's lines, each with the numbers of the sources its markers name. A marker naming no source stays as text.
 * With the checker's verdict (`check`, one entry per line), each line also says whether it was copied or reworded, and
 * which source sentences back it.
 */
export function answerLines(answer, sources, check) {
  const numbers = new Map();
  for (const source of Array.isArray(sources) ? sources : []) for (const id of source.chunkIds) numbers.set(id, source.number);
  const lines = text(answer).split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
    const refs = [];
    const rest = line.replace(/\s*\[([^\]]+)\]/g, (marker, id) => {
      const number = numbers.get(id);
      if (number === undefined) return marker;
      if (!refs.includes(number)) refs.push(number);
      return "";
    }).trim();
    return { text: rest, refs };
  });
  const verdicts = Array.isArray(check?.lines) && check.lines.length === lines.length ? check.lines : undefined;
  return verdicts ? lines.map((line, index) => ({ ...line, kind: verdicts[index]?.kind === "reworded" ? "reworded" : "quoted",
    support: Array.isArray(verdicts[index]?.support) ? verdicts[index].support.filter(item => typeof item === "string") : [] })) : lines;
}

// Why the checker left lines out, in the asker's words. The lines themselves never reach the answer (D63).
const LEFT_OUT = {
  new_fact: "had a name, number or date the source doesn't",
  changed_meaning: "changed what the source says",
  new_words: "said more than the source",
  wrong_source: "cited the wrong source",
  no_citation: "had no valid citation",
  unknown_citation: "had no valid citation"
};
/** One sentence on the lines the checker left out of an answer, or nothing when it left none out. */
export function leftOutNote(check) {
  const removed = Array.isArray(check?.removed) ? check.removed : [];
  if (!removed.length) return "";
  const phrases = [...new Set(removed.map(item => LEFT_OUT[item?.reason] ?? "wasn't backed by the sources"))];
  const lines = `${removed.length} line${removed.length === 1 ? "" : "s"} left out`;
  if (phrases.length > 1) return `${lines} because the sources don't back them.`;
  return `${lines}: ${removed.length === 1 ? "it" : "they"} ${phrases[0]}.`;
}

// Answers show a Jira issue's status inside the quoted text: after the key when the text starts with it, "DB-12
// (in progress) tracks…", and in front of it otherwise, "DB-15 (blocked): Replica…". The document has neither.
const JIRA_STATUS = /^([A-Z][A-Z0-9]+-\d+) \([^)]*\)(:?) /;
function withoutStatus(sentence) {
  const match = JIRA_STATUS.exec(sentence);
  if (!match) return undefined;
  const rest = sentence.slice(match[0].length);
  return match[2] ? rest : `${match[1]} ${rest}`;
}

// The text with each run of whitespace as one space, and where each of its characters came from.
function collapse(value) {
  let out = "";
  const at = [];
  for (let index = 0; index < value.length; index++) {
    if (/\s/.test(value[index])) {
      if (!out || out.endsWith(" ")) continue;
      out += " ";
    } else out += value[index];
    at.push(index);
  }
  return { out, at };
}

/** Where each quoted sentence sits in a document's text, as sorted [start, end) ranges with overlaps merged. */
export function quotedRanges(content, sentences) {
  const { out, at } = collapse(text(content));
  const ranges = [];
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    for (const candidate of [text(sentence), withoutStatus(text(sentence))]) {
      const needle = text(candidate).replace(/\s+/g, " ").trim();
      if (!needle) continue;
      const found = [];
      for (let start = out.indexOf(needle); start !== -1; start = out.indexOf(needle, start + needle.length)) {
        found.push([at[start], at[start + needle.length - 1] + 1]);
      }
      if (found.length) { ranges.push(...found); break; }
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The demo's documents live at placeholder addresses on the reserved .example domain, which no browser can open. */
export function isDemoAddress(url) {
  try { return new URL(url).hostname.endsWith(".example"); } catch { return false; }
}

const AUDIT_WORDING = [
  /\baudit\b/i,
  /\b(accessed|retrieved)\b/i,
  /\busers?\s+['"\u2018\u201c]/i,
  /\bwho\s+(retrieved|accessed|viewed|opened|asked|saw)\b/i,
  /\bwhat\s+did\s+\S+\s+(ask|access|open|view|retrieve|see)\b/i
];
/** Questions about who asked or saw what, which the audit log answers rather than the documents. */
export function looksLikeAuditQuestion(question) {
  const value = text(question);
  return AUDIT_WORDING.some(pattern => pattern.test(value));
}

const names = { slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Drive" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const count = value => Number(value) || 0;
const day = value => text(value).slice(0, 10);
const short = (value, limit = 160) => {
  const flat = text(value).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
// Why the access check said no (packages/fga-adapter), and why the built-in writer answered instead of the model.
const DENIED = { fga: "no permission", blocked: "blocked by an admin", tier: "restricted tier" };
const FALLBACK = {
  budget: "the model's token budget is spent",
  daily_limit: "today's model allowance is spent",
  rate_limited: "the model service was busy",
  meter: "the usage meter couldn't be read",
  error: "the model call failed",
  ungrounded: "the model quoted no source word for word"
};
// A citation marker as answers write it: [source:id:passage].
const CITATION = /\s*\[[a-z]+:[^\]\s]+:\d+\]/g;
// References that only tie an entry to others. A reader never needs them, and the raw entry still has them.
const hiddenKey = key => key === "traceId" || key === "orgId" || key === "questionHash" || key.endsWith("Ref");

/** One plain-language line for an audit entry, without the references that only link entries together. */
export function auditSummary(entry) {
  if (!entry || typeof entry !== "object") return "";
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  const doc = text(data.docId);
  const source = names[data.source] ?? text(data.source);
  const allowed = data.allowed === true;
  switch (entry.type) {
    case "query_received": return `Asked: "${short(data.question, 300)}"`;
    case "query_planned": {
      const first = Array.isArray(data.sources) && data.sources.length
        ? `${data.sources.map(item => names[item] ?? text(item)).join(" and ")} first` : "all sources";
      const dates = data.from && data.to ? `, ${day(data.from)} to ${day(data.to)}` : "";
      return `Planned: ${first}${dates}${data.project ? `, kept to ${text(data.project)}` : ""}`;
    }
    case "embedding_fallback": return `Searched by keywords only: the embedding service was ${data.reason === "paused" ? "paused" : "unavailable"}`;
    case "search_fallback": return "Searched the local index only: the Supabase search failed";
    case "candidates_found": return `Found ${plural(count(data.count), "candidate")} before any access check`;
    case "candidate_ranked": return `Ranked ${doc} (score ${data.score})`;
    case "candidate_linked": return `Linked ${doc} from ${text(data.fromDocId)} (score ${data.score})`;
    case "access_decision": return allowed ? `Allowed ${doc}` : `Denied ${doc} (${DENIED[data.reason] ?? (text(data.reason) || "no reason given")})`;
    case "live_access_decision":
      return `Live check ${allowed ? "allowed" : "denied"} ${doc}${data.sourceVersion ? `, version ${data.sourceVersion}` : ""}${data.refreshed === true ? ", refreshed" : ""}`;
    case "live_refresh": return `Refreshed ${doc} from its source${data.version ? `, now version ${data.version}` : ""}`;
    case "live_permission_refresh": return `Refreshed the permissions of ${doc} from its source`;
    case "source_check_failed": return `Couldn't check ${doc} at its source, so it was left out`;
    case "context_sent": {
      const ids = Array.isArray(data.chunkIds) ? data.chunkIds.map(text) : [];
      return `Sent ${plural(ids.length, "passage")} to the writer${ids.length ? `: ${ids.join(", ")}` : ""}`;
    }
    case "llm_fallback": return `The built-in writer answered: ${FALLBACK[data.reason] ?? (text(data.reason) || "the model was unavailable")}`;
    case "output_access_decision": return `Rechecked after writing: ${allowed ? "allowed" : "denied"} ${doc}`;
    case "answer_returned": {
      if (data.empty === true) return "Answered with the fixed no-result reply";
      const cited = Array.isArray(data.citationIds) ? data.citationIds.length : 0;
      const reworded = Array.isArray(data.check?.lines) ? data.check.lines.filter(kind => kind === "reworded").length : 0;
      const removed = Array.isArray(data.check?.removed) ? data.check.removed.length : 0;
      const checked = `${reworded ? `, ${reworded} reworded` : ""}${removed ? `, ${removed} left out` : ""}`;
      return `Answered with ${plural(cited, "citation")}${checked}: "${short(text(data.answer).replace(CITATION, ""))}"`;
    }
    case "document_synced": {
      const changed = data.contentChanged && data.permissionChanged ? "content and permissions changed"
        : data.contentChanged ? "content changed" : data.permissionChanged ? "permissions changed" : "no change";
      return `Synced ${doc}: ${changed}`;
    }
    case "document_deleted": return `Removed ${doc}: it's gone from its source`;
    case "import_started": return `Started importing ${source}${typeof data.found === "number" ? `: ${plural(data.found, "item")}` : ""}`;
    case "import_completed": {
      const extra = [count(data.skipped) && `${count(data.skipped)} skipped`, count(data.failed) && `${count(data.failed)} failed`].filter(Boolean);
      return `Finished importing ${source}: ${plural(count(data.indexed), "item")} indexed${extra.length ? `, ${extra.join(", ")}` : ""}`;
    }
    case "sync_failed": return `Sync failed for ${source}`;
    case "connection_created": return `${data.reconnected ? "Reconnected" : "Connected"} ${source}`;
    case "connection_removed": return `Disconnected ${source}`;
    case "scope_changed": return `Changed what ${source} imports: ${text(data.mode) || "all"}${data.futureOnly ? ", only what is new" : ""}`;
    case "task_created": return `Created ${doc} from ${text(data.fromDocId)}`;
    case "task_status_changed": return `Marked ${doc} ${text(data.status)}`;
    case "tier_narrowed": return `Narrowed ${doc} to the ${text(data.tier)} tier`;
    case "native_permission_changed": return `Changed the source permissions of ${doc}`;
    case "user_blocked": return `Blocked ${text(data.userId)} from ${doc}`;
    case "user_unblocked": return `Unblocked ${text(data.userId)} from ${doc}`;
    case "restricted_grant_created":
      return `Gave ${text(data.userId)} restricted access to ${doc} until ${day(data.expiresAt)}: ${short(data.reason, 120)}`;
    case "restricted_grant_expired": return `Restricted access to ${doc} for ${text(data.userId)} expired`;
    case "group_membership_removed": return `Removed ${text(data.userId)} from the ${text(data.group)} group`;
    case "channel_membership_removed": return `Removed ${text(data.userId)} from ${doc}`;
    case "source_content_changed": return `Edited ${doc} at its source`;
    case "audit_searched": return `Searched the audit for "${short(data.query, 120)}": ${plural(count(data.results), "result")}`;
    case "request_denied": return `Refused ${text(data.method)} ${text(data.path)}`;
    default: {
      const pairs = Object.entries(data).filter(([key]) => !hiddenKey(key))
        .map(([key, value]) => `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      return [text(entry.type).replaceAll("_", " "), ...pairs].join(" · ");
    }
  }
}

/** A sync that re-read a document and found nothing changed: worth recording, rarely worth reading. */
export function isRoutineSync(entry) {
  return entry?.type === "document_synced" && entry.data?.contentChanged === false && entry.data?.permissionChanged === false;
}
