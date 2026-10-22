// What a query trace says, in plain words. The workspace panel and the compliance panel read the same
// trace, so both take their wording from here.

import { leftOutNote } from "../../answer.js";

export function eventSummary(entry) {
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  return Object.entries(data).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
}

export function traceDetails(entry, rank) {
  const data = entry.data || {};
  const ref = data.docRef ? ` · doc ref ${String(data.docRef).slice(0, 12)}…` : "";
  switch (entry.type) {
    case "query_received": return ["Question received", "Question recorded as a hash."];
    case "candidates_found": return ["Hybrid candidates", `${data.count ?? 0} document IDs retrieved before authorization.`];
    case "candidate_linked": return ["Linked item", `Reached by a link from an item you may open, score ${data.score ?? "unknown"}${ref}`];
    case "candidate_ranked": return ["Candidate ranked", `Rank ${rank} · score ${data.score ?? "unknown"} · chunk ref ${String(data.chunkRef || "").slice(0, 12)}…`];
    case "access_decision": return ["FGA and tier check", `${data.allowed ? "Allowed" : "Denied"}${ref} · reason ${typeof data.reason === "string" && data.reason ? data.reason : "unspecified"}`];
    case "live_access_decision": return ["Live source check", `${data.allowed ? "Allowed" : "Denied"}${ref}${data.sourceVersion ? ` · source v${data.sourceVersion}` : ""}${data.refreshed === true ? " · refreshed" : data.refreshed === false ? " · version current" : ""}`];
    case "context_sent": return ["Context sent to LLM", `${Array.isArray(data.chunkIds) ? data.chunkIds.length : 0} authorized fresh chunks passed${Array.isArray(data.chunkIds) && data.chunkIds.length ? ` · ${data.chunkIds.join(", ")}` : ""}.`];
    case "answer_returned": return ["Answer returned", data.empty ? "Fixed no-result response." : `${Array.isArray(data.citationIds) ? data.citationIds.length : 0} citations returned after output check${Array.isArray(data.citationIds) && data.citationIds.length ? ` · ${data.citationIds.join(", ")}` : ""}.${leftOutNote(data.check) ? ` ${leftOutNote(data.check)}` : ""}`];
    default: return [entry.type.replaceAll("_", " "), eventSummary(entry) || "Recorded in audit log."];
  }
}
