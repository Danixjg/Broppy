import { narrowerPermissionError } from "./permissions.js";
import { auditSummary, isRoutineSync } from "./answer.js";
import { eventSummary, traceDetails } from "./src/lib/trace.js";
import { IDENTITY_CHANGED, SEARCH_AUDIT, SHOW_TRACE, TASKS_CHANGED, WORKSPACE_DATA, WORKSPACE_RELOAD } from "./src/tasks/events";

// The controller keeps the views React has not taken over yet: the admin's source controls, the compliance
// console and the sync health. The workspace surface is React's; the two talk over the broppy: events.
const API = "/api/brain";
const $ = id => document.getElementById(id);
const state = { view: "workspace", identity: 0, audit: null, auditEntries: [], proof: null, authMode: "loading", signedIn: false, me: null, nativeLoad: 0, nativeDoc: null, nativeCurrent: null, docs: [], docsMode: "" };
const roles = { maya: "admin", nur: "compliance" };
const safeText = value => typeof value === "string" ? value : "";
const fmtDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
const clear = element => element.replaceChildren();
const appendText = (parent, tag, className, text) => parent.append(node(tag, className, text));
const setMessage = (element, message) => { element.textContent = message; };
const sourceName = source => ({ slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Drive" })[source] || "Source";
const reveal = (element, block = "nearest") => element?.scrollIntoView({ block, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });

async function call(path, options = {}) {
  if (!["auth0", "demo"].includes(state.authMode)) throw new Error("Please sign in with SSO.");
  // Demo visitors act as the persona chosen in the header; the host ignores this header for signed-in users.
  const persona = state.authMode === "demo" ? { "x-demo-user": $("user").value } : {};
  const response = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", ...persona, ...(options.headers || {}) },
    cache: "no-store"
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("API returned an invalid response"); }
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? payload.error : "Request failed");
    error.status = response.status;
    error.payload = payload && typeof payload === "object" ? payload : null;
    if (response.status === 401 && state.authMode !== "demo") {
      // The proxy marks an API rejection of a live session; anything else means the session is gone.
      if (payload.code !== "account_rejected") state.signedIn = false;
      state.me = null; updateAuthUi(error.message); resetIdentity();
    }
    throw error;
  }
  return payload;
}
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });
// Source controls edit the practice data and its demo people directly; a company on its live tools changes access at
// the tools themselves, so the page isn't shown there.
// Shown only once the workspace has said it is the demo: a slow or failed load must never show demo people in a real company.
const practiceControls = () => role() === "admin" && state.docsMode === "demo";
function role() { return state.authMode === "demo" ? roles[$("user").value] || "member" : state.me?.role || "member"; }
function setView(view, { load = true } = {}) {
  if (view === "admin" && !practiceControls()) view = "workspace";
  if (view === "compliance" && role() !== "compliance") view = "workspace";
  state.view = view;
  for (const name of ["workspace", "tasks", "admin", "compliance", "operations"]) {
    $(`${name}View`).hidden = name !== view;
    const button = document.querySelector(`[data-view="${name}"]`);
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (view === "admin") renderAdminDocuments();
  if (view === "compliance" && load) loadAudit();
  if (view === "operations") loadHealth();
}
function resetIdentity() {
  state.identity++;
  state.audit = null; state.auditEntries = []; state.proof = null; state.nativeLoad++; state.nativeDoc = null;
  state.docs = [];
  for (const id of ["previewResult", "auditSummary", "routineHidden", "auditRows", "proofPanel", "tracePanel", "healthCards"]) clear($(id));
  for (const id of ["adminStatus", "auditStatus", "healthStatus", "globalStatus"]) setMessage($(id), "");
  for (const id of ["adminContent", "auditSearch", "memberGroup", "memberChannelDoc"]) $(id).value = "";
  $("hideRoutine").checked = true;
  clearNativeEditor();
  $("adminTab").hidden = !practiceControls();
  // Settings links in the top bar, for admins. The public demo has no directory or tools of its own to set up.
  $("adminLinks").hidden = role() !== "admin" || state.authMode === "demo";
  $("complianceTab").hidden = role() !== "compliance";
  $("retrySync").hidden = role() !== "admin";
  setView("workspace");
  // The React workspace surface reads its own snapshot from here: who is looking, and what they may open.
  document.dispatchEvent(new CustomEvent(IDENTITY_CHANGED, { detail: { role: role(), mode: state.authMode, signedIn: state.signedIn } }));
}
function updateAuthUi(message = "") {
  const signedInMode = state.authMode === "auth0";
  const demo = state.authMode === "demo";
  $("demoIdentity").hidden = !demo;
  $("user").disabled = !demo;
  $("authIdentity").hidden = !signedInMode && !demo;
  $("authName").textContent = demo ? "" : [state.me?.name, state.me?.company].filter(Boolean).join(" · ");
  $("loginButton").hidden = demo || state.signedIn || !signedInMode;
  $("logoutButton").hidden = !demo && (!signedInMode || !state.signedIn);
  $("logoutButton").textContent = demo ? "Leave demo" : "Log out";
  $("authStatus").hidden = !message;
  $("authStatus").textContent = message;
}
async function initAuth() {
  updateAuthUi("Loading sign-in configuration…");
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (response.status === 401) { location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname + location.search })}`); return; }
    if (!response.ok) throw new Error("SSO session is unavailable.");
    if ((await response.json()).demo === true) {
      state.authMode = "demo";
      updateAuthUi("Demo mode: all people and data are fictional. Choose who you are viewing as.");
      resetIdentity();
      return;
    }
    state.authMode = "auth0";
    state.signedIn = true;
    state.me = await call("/v1/me");
    if (!state.me || typeof state.me.id !== "string" || typeof state.me.name !== "string" || !Array.isArray(state.me.groups) || !["member", "admin", "compliance"].includes(state.me.role)) throw new Error("The API returned an invalid identity.");
    updateAuthUi(); resetIdentity();
  } catch (error) {
    if (state.authMode === "auth0") { state.me = null; }
    else state.authMode = "invalid";
    updateAuthUi(error.message);
    resetIdentity();
  }
}
// The workspace surface owns the documents; the admin's document list reads them from there.
function renderAdminDocuments() {
  const select = $("adminDoc");
  const chosen = select.value;
  clear(select);
  for (const doc of state.docs) {
    const option = node("option", "", `${doc.title} · ${doc.docId}`);
    option.value = doc.docId;
    select.append(option);
  }
  if (state.docs.some(doc => doc.docId === chosen)) select.value = chosen;
}
function clearNativeEditor() {
  state.nativeCurrent = null;
  $("nativeDocLabel").textContent = "Select an accessible document.";
  $("nativeRestriction").textContent = "";
  $("nativePermissions").value = "";
  $("nativeStatus").textContent = "";
  $("saveNativePermissions").disabled = true;
}
function nativeRestriction(source, native) {
  if (!native || native.source !== source) return "Native permission details are unavailable.";
  switch (source) {
    case "slack": return `Slack channel ${native.channelId}: visibility is ${native.visibility}; members control private channel access. You may change public to private or remove members.`;
    case "jira": return `Jira project ${native.projectKey}: projectViewers control project access; issueViewers further restrict this issue when present. Remove viewers to narrow.`;
    case "confluence": return `Confluence space ${native.spaceKey}: spaceViewers control space access; pageViewers further restrict this page when present. Remove viewers to narrow.`;
    case "drive": return `Drive file ${native.fileId}: owner ${native.owner} remains fixed; remove sharedUsers to narrow.`;
    default: return "Unknown source restrictions.";
  }
}
async function loadNativePermissions() {
  const docId = $("adminDoc").value;
  const request = ++state.nativeLoad;
  const generation = state.identity;
  state.nativeDoc = null;
  clearNativeEditor();
  if (role() !== "admin" || !docId) return;
  const doc = state.docs.find(item => item.docId === docId);
  $("nativeDocLabel").textContent = `${doc?.title || docId} · ${sourceName(doc?.source)}`;
  $("nativeStatus").textContent = "Loading current source permissions…";
  try {
    const result = await call(`/v1/admin/permissions?docId=${encodeURIComponent(docId)}`);
    if (request !== state.nativeLoad || generation !== state.identity || role() !== "admin" || $("adminDoc").value !== docId) return;
    if (result.docId !== docId || result.source !== doc?.source || !result.permissions || typeof result.permissions !== "object") throw new Error("The API returned invalid source permissions.");
    if (narrowerPermissionError(result.permissions, result.permissions, result.source)) throw new Error("The API returned incomplete source permissions.");
    state.nativeDoc = docId;
    state.nativeCurrent = result.permissions;
    $("nativeRestriction").textContent = nativeRestriction(result.source, result.permissions.native);
    $("nativePermissions").value = JSON.stringify(result.permissions, null, 2);
    $("nativeStatus").textContent = "Current permissions loaded. Only narrower changes will be accepted.";
    $("saveNativePermissions").disabled = false;
  } catch (error) { if (request === state.nativeLoad && generation === state.identity) $("nativeStatus").textContent = error.message; }
}
async function saveNativePermissions(event) {
  event.preventDefault();
  const docId = $("adminDoc").value;
  if (docId !== state.nativeDoc) { $("nativeStatus").textContent = "Load this document’s current permissions first."; return; }
  let permissions;
  try { permissions = JSON.parse($("nativePermissions").value); }
  catch { $("nativeStatus").textContent = "Enter valid JSON permissions."; return; }
  const error = narrowerPermissionError(permissions, state.nativeCurrent, state.docs.find(doc => doc.docId === docId)?.source);
  if (error) { $("nativeStatus").textContent = error; return; }
  const generation = state.identity;
  $("saveNativePermissions").disabled = true;
  $("nativeStatus").textContent = "Applying narrower source permissions…";
  try {
    await post("/v1/admin/permissions", { docId, permissions });
    if (generation !== state.identity || docId !== $("adminDoc").value || role() !== "admin") return;
    requestWorkspaceReload();
    $("nativeStatus").textContent = "Source permissions saved and workspace refreshed.";
  } catch (error) {
    if (generation === state.identity && docId === $("adminDoc").value) {
      $("nativeStatus").textContent = error.message;
      $("saveNativePermissions").disabled = false;
    }
  }
}
async function adminAction(path, body, success) {
  const generation = state.identity;
  $("adminStatus").textContent = "Applying change…";
  try {
    await post(path, body); if (generation !== state.identity || role() !== "admin") return;
    $("adminStatus").textContent = success;
    requestWorkspaceReload();
  }
  catch (error) { if (generation === state.identity && role() === "admin") $("adminStatus").textContent = error.message; }
}
// "3 minutes ago", for when a source last synced; the exact time is in the title.
function timeAgo(value) {
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"]]) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "";
}
// One plain line for where a source stands, from the API's view of this company only.
// What went wrong, in words an admin can act on; the source's own error text is kept for the tooltip.
function plainSourceError(error = "") {
  if (/credential was rejected|reconnect the source|\(401\)|\(403\)/i.test(error)) return "Broppy's access was turned off or expired. Reconnect it.";
  if (/Reading stopped before it finished/i.test(error)) return "Reading stopped part-way. It carries on at the next sync, or press Sync now.";
  if (/\(429\)|rate/i.test(error)) return "The tool asked Broppy to slow down. It tries again at the next sync.";
  if (/timed? ?out|aborted|fetch failed|\(5\d\d\)/i.test(error)) return "The tool didn't answer in time. Broppy tries again at the next sync.";
  return "The last sync didn't finish. Press Sync now, or reconnect it.";
}
function healthLine(item) {
  if (item.status === "Not connected") return { text: role() === "admin" ? "Not connected" : "Not connected · your admin can connect it", kind: "muted" };
  if (item.status === "Error") return { text: `Needs attention: ${plainSourceError(item.error)}`, kind: "bad", detail: item.error };
  if (item.job?.status === "running" || item.status === "Importing") {
    const done = item.job ? item.job.indexed : 0;
    return { text: item.job?.found ? `Reading · ${done} of ${item.job.found} items` : "Reading…", kind: "" };
  }
  if (item.job?.status === "failed") return { text: "The last import failed. Try Sync now, or reconnect it.", kind: "bad" };
  if ((!item.job || item.scope === "none") && item.items === 0) return { text: "Connected · reading nothing yet. Choose what Broppy reads.", kind: "warn" };
  if (item.items === 0) return { text: "Connected · 0 items found. Check what Broppy reads, and that the connected account can see something.", kind: "warn" };
  return { text: `Ready · ${item.items} item${item.items === 1 ? "" : "s"}${item.job?.failed ? ` · ${item.job.failed} couldn't be read` : ""}`, kind: "good" };
}
async function loadHealth() {
  const generation = state.identity; $("healthStatus").textContent = "Loading…";
  try {
    const result = await call("/v1/sync-health"); if (generation !== state.identity) return;
    clear($("healthCards"));
    for (const item of result.sources || []) {
      const card = node("div", "surface"); appendText(card, "h2", "", sourceName(item.source));
      const line = healthLine(item); const lineNode = node("p", line.kind, line.text); if (line.detail) lineNode.title = line.detail; card.append(lineNode);
      if (item.status !== "Not connected") {
        const synced = node("p", "muted", item.lastSync ? `Last synced ${timeAgo(item.lastSync) || fmtDate(item.lastSync)}` : "Not synced yet");
        if (item.lastSync) synced.title = fmtDate(item.lastSync);
        card.append(synced);
        if (item.pending) appendText(card, "p", "muted", `${item.pending} item${item.pending === 1 ? "" : "s"} still to read`);
        if (role() === "admin" && state.authMode !== "demo") {
          const change = node("a", "", "Change what Broppy reads"); change.href = "./setup.html?step=read"; card.append(change);
        }
      } else if (role() === "admin" && state.authMode !== "demo") {
        const link = node("a", "", "Connect it in setup"); link.href = "./setup.html"; card.append(link);
      }
      $("healthCards").append(card);
    }
    const connected = (result.sources || []).filter(item => item.status !== "Not connected").length;
    $("healthStatus").textContent = `${connected} of ${(result.sources || []).length} tools connected`;
    // While something is being read, keep the page current on its own.
    clearTimeout(state.healthTimer);
    if ((result.sources || []).some(item => item.job?.status === "running" || item.status === "Importing")) state.healthTimer = setTimeout(() => { if (state.view === "operations" && generation === state.identity) loadHealth(); }, 4000);
  } catch (error) {
    if (generation !== state.identity) return;
    $("healthStatus").textContent = `${error.message} Trying again…`;
    clearTimeout(state.healthTimer); state.healthTimer = setTimeout(() => { if (state.view === "operations" && generation === state.identity) loadHealth(); }, 5000);
  }
}
function localAuditSearch(entries, query) {
  const text = query.trim().toLowerCase(); if (!text) return entries;
  const terms = text.split(/\s+/).filter(term => !["for", "the", "a", "an", "show", "find", "me", "events", "event", "about"].includes(term));
  const normalized = terms.map(term => ({ denied: "false", allowed: "true", permission: "permission", access: "access" })[term] || term);
  return entries.filter(entry => normalized.every(term => `${entry.type} ${entry.actor} ${eventSummary(entry)}`.toLowerCase().includes(term)));
}
// The list on screen may leave out routine sync checks; state.auditEntries, the search and the CSV export keep every entry.
function renderAudit(entries) {
  state.auditEntries = entries; clear($("auditRows"));
  const shown = $("hideRoutine").checked ? entries.filter(entry => !isRoutineSync(entry)) : entries;
  const hidden = entries.length - shown.length;
  $("routineHidden").textContent = hidden ? `${hidden} hidden` : "";
  for (const entry of shown) {
    const row = node("tr", "");
    appendText(row, "td", "", `#${entry.sequence} · ${fmtDate(entry.timestamp)}`);
    appendText(row, "td", "", entry.type);
    appendText(row, "td", "", entry.actor);
    const details = node("td", ""); appendText(details, "p", "audit-line", auditSummary(entry));
    // The full entry is written out only when someone opens it, so a long log stays light.
    const raw = node("details", "raw-data"); appendText(raw, "summary", "", "Raw data");
    raw.addEventListener("toggle", () => { if (raw.open && !raw.querySelector("pre")) appendText(raw, "pre", "", JSON.stringify(entry, null, 2)); });
    details.append(raw); row.append(details);
    const cell = node("td", ""); const button = node("button", "", "Inspect proof"); button.type = "button";
    button.addEventListener("click", () => inspectProof(entry.sequence)); cell.append(button); row.append(cell);
    $("auditRows").append(row);
  }
  if (!shown.length) {
    const row = node("tr", "");
    const cell = node("td", "empty", hidden ? "Only routine sync checks match. Untick “Hide routine sync checks” to see them." : "No matching audit events.");
    cell.colSpan = 5; row.append(cell); $("auditRows").append(row);
  }
}
async function loadAudit() {
  if (role() !== "compliance") return;
  const generation = state.identity; $("auditStatus").textContent = "Loading audit…";
  try {
    const result = await call("/v1/audit"); if (generation !== state.identity) return;
    state.audit = result; renderAudit(result.entries || []);
    $("auditSummary").textContent = `${result.entries?.length || 0} events · ${result.batches?.length || 0} sealed batches · Chain ${result.chainValid ? "valid" : "invalid"}`;
    $("auditStatus").textContent = "";
  } catch (error) { if (generation === state.identity) $("auditStatus").textContent = error.message; }
}
async function searchAudit(query) {
  const generation = state.identity;
  if (!state.audit) await loadAudit(); if (!state.audit) return;
  $("auditStatus").textContent = "Searching audit…";
  try {
    const result = await call(`/v1/audit/search?${new URLSearchParams({ q: query, ...($("auditFrom").value ? { from: $("auditFrom").value } : {}), ...($("auditTo").value ? { to: $("auditTo").value } : {}) })}`);
    if (generation !== state.identity || role() !== "compliance") return;
    const entries = Array.isArray(result.entries) ? result.entries : Array.isArray(result) ? result : [];
    renderAudit(entries); $("auditStatus").textContent = `${entries.length} matching event${entries.length === 1 ? "" : "s"}`;
  } catch (error) {
    if (generation !== state.identity || role() !== "compliance") return;
    if (error.status !== 404) { $("auditStatus").textContent = error.message; return; }
    const entries = localAuditSearch(state.audit.entries || [], query);
    renderAudit(entries); $("auditStatus").textContent = `${entries.length} matching event${entries.length === 1 ? "" : "s"} · local search`;
  }
}
async function inspectProof(sequence) {
  const generation = state.identity;
  const box = $("proofPanel"); clear(box); box.hidden = false;
  appendText(box, "h2", "", `Merkle proof · event #${sequence}`);
  try {
    const result = await call(`/v1/audit/proof?sequence=${sequence}`);
    if (generation !== state.identity || role() !== "compliance") return;
    state.proof = { sequence, proof: result.proof };
    appendText(box, "p", "muted", `Leaf ${result.proof.leaf}`);
    for (const [index, sibling] of result.proof.siblings.entries()) {
      const step = node("div", "proof-step"); appendText(step, "strong", "", `Step ${index + 1} · ${sibling.position} sibling `); appendText(step, "code", "", sibling.hash); box.append(step);
    }
    appendText(box, "p", "muted", `Root ${result.proof.root}`);
    const button = node("button", "secondary-button", "Verify proof"); button.type = "button";
    button.addEventListener("click", () => verifyProof(sequence)); box.append(button);
  } catch (error) { if (generation === state.identity && role() === "compliance") appendText(box, "p", "muted", error.message); }
  reveal(box);
}
async function hashPair(left, right) {
  const bytes = new TextEncoder().encode(`${left}:${right}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function verifyLocally(sequence) {
  const proof = state.proof?.proof;
  const batch = state.audit?.batches?.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
  const entry = state.audit?.entries?.find(item => item.sequence === sequence);
  if (!proof || !batch || !entry || entry.hash !== proof.leaf) return false;
  let current = proof.leaf;
  for (const sibling of proof.siblings) current = sibling.position === "left" ? await hashPair(sibling.hash, current) : await hashPair(current, sibling.hash);
  return current === batch.root && proof.root === batch.root;
}
async function verifyProof(sequence) {
  const generation = state.identity;
  const box = $("proofPanel");
  try {
    let result;
    try { result = await post("/v1/audit/verify", { sequence }); }
    catch (error) { if (error.status !== 404) throw error; result = { valid: await verifyLocally(sequence), local: true }; }
    if (generation !== state.identity || role() !== "compliance") return;
    const verified = result.verified ?? result.valid;
    appendText(box, "p", verified ? "badge" : "status-badge superseded", verified ? `Proof verified${result.local ? " locally against the loaded audit batch" : ""}` : "Proof verification failed");
  } catch (error) { if (generation === state.identity && role() === "compliance") appendText(box, "p", "muted", error.message); }
}
// Compliance reads a trace in its own console; the workspace surface reads the same trace in its own panel.
async function showTrace(traceId) {
  const generation = state.identity;
  const box = $("tracePanel");
  clear(box); box.hidden = false; appendText(box, "h2", "", "Query trace");
  try {
    const result = await call(`/v1/trace?traceId=${encodeURIComponent(traceId)}`);
    if (generation !== state.identity) return;
    appendText(box, "p", "detail-meta", `Trace ${safeText(result.traceId)}`);
    const entries = Array.isArray(result.entries) ? [...result.entries].sort((a, b) => a.sequence - b.sequence) : [];
    if (!entries.length) appendText(box, "p", "empty", "No trace events available.");
    const list = node("ol", "trace-events"); let rank = 0;
    for (const entry of entries) {
      if (entry.type === "candidate_ranked") rank++;
      const [title, description] = traceDetails(entry, rank);
      const row = node("li", "trace-event");
      appendText(row, "span", "trace-time", `#${entry.sequence} · ${fmtDate(entry.timestamp)}`);
      appendText(row, "strong", "", title);
      appendText(row, "p", "", description);
      list.append(row);
    }
    box.append(list);
  } catch (error) { if (generation === state.identity) appendText(box, "p", "muted", error.status === 404 ? "Trace endpoint is not available yet." : error.message); }
  reveal(box);
}
function csvCell(value) {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}
function exportAudit() {
  const entries = state.auditEntries;
  const lines = [["sequence", "timestamp", "type", "actor", "details", "hash"].map(csvCell).join(",")];
  for (const entry of entries) lines.push([entry.sequence, entry.timestamp, entry.type, entry.actor, JSON.stringify(entry.data || {}), entry.hash].map(csvCell).join(","));
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = node("a", ""); link.href = url; link.download = "internal-brain-audit.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function requestWorkspaceReload() {
  document.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD));
}
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
document.addEventListener(WORKSPACE_DATA, event => {
  const documents = event.detail?.documents;
  state.docs = Array.isArray(documents) ? documents.filter(doc => doc && typeof doc.docId === "string" && typeof doc.title === "string") : [];
  state.docsMode = event.detail?.capabilities?.mode ?? "";
  $("adminTab").hidden = !practiceControls();
  if (state.view === "admin" && !practiceControls()) setView("workspace");
  if (state.view === "admin") renderAdminDocuments();
});
// A task write changes the corpus, so the workspace surface reads it again.
document.addEventListener(TASKS_CHANGED, () => { requestWorkspaceReload(); });
document.addEventListener(SHOW_TRACE, event => {
  const traceId = event.detail?.traceId;
  if (!traceId || role() !== "compliance") return;
  setView("compliance");
  void showTrace(traceId);
});
document.addEventListener(SEARCH_AUDIT, event => {
  const question = event.detail?.question;
  if (!question) return;
  setView("compliance", { load: false });
  $("auditSearch").value = question;
  void searchAudit(question);
});
$("user").addEventListener("change", resetIdentity);
$("contentForm").addEventListener("submit", event => { event.preventDefault(); adminAction("/v1/admin/content", { docId: $("adminDoc").value, content: $("adminContent").value }, "Content updated and synced."); });
$("adminDoc").addEventListener("change", loadNativePermissions);
$("reloadNativePermissions").addEventListener("click", loadNativePermissions);
$("nativePermissionForm").addEventListener("submit", saveNativePermissions);
$("applyTier").addEventListener("click", () => adminAction("/v1/admin/tier", { docId: $("adminDoc").value, tier: $("tier").value }, "Access tier narrowed."));
$("revokeBrain").addEventListener("click", () => adminAction("/v1/admin/permissions", { docId: $("adminDoc").value, permissions: { users: [], groups: [], public: false } }, "Brain grants revoked and synced. Native permissions remain unchanged."));
$("removeGroup").addEventListener("click", () => {
  const group = $("memberGroup").value.trim();
  if (!group) { $("adminStatus").textContent = "Enter a group name."; return; }
  adminAction("/v1/admin/group", { userId: $("memberUser").value, group }, "Group membership removed. The next query uses updated access.");
});
$("removeChannelMember").addEventListener("click", () => {
  const docId = $("memberChannelDoc").value.trim();
  if (!docId) { $("adminStatus").textContent = "Enter a Slack channel document ID."; return; }
  adminAction("/v1/admin/channel-member", { docId, userId: $("memberUser").value }, "Channel membership removed. The next query uses updated live access.");
});
$("previewAccess").addEventListener("click", async () => {
  const generation = state.identity;
  const box = $("previewResult"); box.textContent = "Loading preview…";
  try {
    const result = await call(`/v1/admin/preview?user=${encodeURIComponent($("previewUser").value)}`);
    if (generation !== state.identity || role() !== "admin") return;
    clear(box); appendText(box, "strong", "", `${result.user.name} · ${result.documents.length} accessible documents`);
    const list = node("ul", "");
    for (const doc of result.documents) {
      const reasons = Array.isArray(result.reasons?.[doc.docId]) ? result.reasons[doc.docId].join(" · ") : `Tier: ${doc.tier}`;
      appendText(list, "li", "", `${doc.title} · ${reasons}`);
    }
    if (!result.documents.length) appendText(box, "p", "empty", "No accessible documents for this identity.");
    else box.append(list);
  } catch (error) { if (generation === state.identity && role() === "admin") box.textContent = error.message; }
});
$("auditSearchForm").addEventListener("submit", event => { event.preventDefault(); searchAudit($("auditSearch").value); });
$("refreshAudit").addEventListener("click", loadAudit);
$("sealAudit").addEventListener("click", async () => { const generation = state.identity; try { const result = await post("/v1/audit/seal", {}); if (generation !== state.identity || role() !== "compliance") return; await loadAudit(); $("auditStatus").textContent = result.batch ? "Audit batch sealed." : "No new events to seal."; } catch (error) { if (generation === state.identity && role() === "compliance") $("auditStatus").textContent = error.message; } });
$("exportAudit").addEventListener("click", exportAudit);
$("hideRoutine").addEventListener("change", () => renderAudit(state.auditEntries));
$("refreshHealth").addEventListener("click", loadHealth);
$("retrySync").addEventListener("click", async () => {
  const button = $("retrySync"); if (button.disabled) return; button.disabled = true;
  try { await syncNow(); } finally { button.disabled = false; }
});
async function syncNow() {
  const generation = state.identity; $("healthStatus").textContent = "Syncing your connected tools… this can take a minute.";
  try {
    const result = await post("/v1/admin/sync", {}); if (generation !== state.identity || role() !== "admin") return;
    await loadHealth(); requestWorkspaceReload();
    const results = Array.isArray(result?.results) ? result.results : [];
    const failed = results.filter(item => !item.ok).map(item => sourceName(item.source));
    $("healthStatus").textContent = !results.length ? "No tools are connected yet, so there was nothing to sync."
      : failed.length ? `Synced, except ${failed.join(", ")}. Check ${failed.length === 1 ? "it" : "them"} below.`
      : `Synced ${results.map(item => sourceName(item.source)).join(", ")}.`;
  }
  catch (error) { if (generation === state.identity && role() === "admin") $("healthStatus").textContent = error.message; }
}
$("loginButton").addEventListener("click", () => location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname + location.search })}`));
$("logoutButton").addEventListener("click", () => location.assign(state.authMode === "demo" ? "/demo/exit" : "/auth/logout"));
initAuth();
