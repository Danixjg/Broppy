import { narrowerPermissionError } from "./permissions.js";

const API = "/api/brain";
const $ = id => document.getElementById(id);
const state = { docs: [], selected: null, view: "workspace", identity: 0, audit: null, auditEntries: [], proof: null, landingApplied: false, authConfig: null, authMode: "loading", signedIn: false, me: null, nativeLoad: 0, nativeDoc: null, nativeCurrent: null };
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
const reveal = element => element?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
const appendText = (parent, tag, className, text) => parent.append(node(tag, className, text));
const setMessage = (element, message) => { element.textContent = message; };
const sourceName = source => ({ slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Drive" })[source] || "Source";
const documentStatus = doc => safeText(doc.metadata?.status) || "source";
const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
};
function externalLink(url, text) {
  const href = safeUrl(url);
  if (!href) return node("span", "muted", "Source link unavailable");
  const link = node("a", "", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function statusBadge(doc) {
  const status = documentStatus(doc);
  const tone = { "in review": "review", draft: "draft", superseded: "superseded" }[status] || "";
  return node("span", `status-badge ${tone}`, status);
}
async function call(path, options = {}) {
  if (state.authMode !== "auth0") throw new Error("Please sign in with SSO.");
  const response = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    cache: "no-store"
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("API returned an invalid response"); }
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? payload.error : "Request failed");
    error.status = response.status;
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
function role() { return state.authMode === "demo" ? roles[$("user").value] || "member" : state.me?.role || "member"; }
function setView(view) {
  if (view === "admin" && role() !== "admin") view = "workspace";
  if (view === "compliance" && role() !== "compliance") view = "workspace";
  state.view = view;
  for (const name of ["workspace", "admin", "compliance", "operations"]) {
    $(`${name}View`).hidden = name !== view;
    const button = document.querySelector(`[data-view="${name}"]`);
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (view === "compliance") loadAudit();
  if (view === "operations") loadHealth();
}
function resetIdentity() {
  state.identity++;
  state.docs = []; state.selected = null; state.audit = null; state.auditEntries = []; state.proof = null; state.nativeLoad++; state.nativeDoc = null;
  for (const id of ["slackList", "jiraList", "suggestion", "masterContent", "conclusions", "driveList", "duplicate", "allSources", "selectedDetail", "workspaceTrace", "chatHistory", "previewResult", "auditSummary", "auditRows", "proofPanel", "tracePanel", "healthCards"]) clear($(id));
  $("duplicate").hidden = true; $("selectedDetail").hidden = true; $("workspaceTrace").hidden = true; $("catchUpResult").hidden = true; $("proofPanel").hidden = true; $("tracePanel").hidden = true;
  for (const id of ["queryStatus", "adminStatus", "auditStatus", "healthStatus", "globalStatus"]) setMessage($(id), "");
  for (const id of ["question", "adminContent", "auditSearch", "memberGroup", "memberChannelDoc"]) $(id).value = "";
  for (const id of ["masterBadge", "activityCount", "driveCount", "latestExplanation", "adminDoc"]) clear($(id));
  clearNativeEditor();
  $("adminTab").hidden = role() !== "admin";
  let connectorLink = document.getElementById("connectorSettings");
  if (!connectorLink) { connectorLink = node("a", "", "Connectors settings"); connectorLink.id = "connectorSettings"; $("adminView").prepend(connectorLink); }
  connectorLink.href = `./connectors.html?user=${encodeURIComponent($("user").value)}`;
  connectorLink.hidden = role() !== "admin";
  $("complianceTab").hidden = role() !== "compliance";
  $("retrySync").hidden = role() !== "admin";
  setView("workspace");
  if (state.authMode === "demo" || state.me) loadWorkspace();
  else $("workspaceNotice").textContent = state.signedIn ? "Your accessible documents are unavailable for this account." : "Log in to view your accessible documents.";
}
function updateAuthUi(message = "") {
  const signedInMode = state.authMode === "auth0";
  $("demoIdentity").hidden = signedInMode;
  $("user").disabled = signedInMode;
  $("authIdentity").hidden = !signedInMode;
  $("authName").textContent = state.me?.name || "";
  $("loginButton").hidden = state.signedIn || state.authMode !== "auth0";
  $("logoutButton").hidden = !signedInMode || !state.signedIn;
  $("authStatus").hidden = !message;
  $("authStatus").textContent = message;
}
async function initAuth() {
  updateAuthUi("Loading sign-in configuration…");
  try {
    state.authMode = "auth0";
    const response = await fetch("/api/session", { cache: "no-store" });
    if (response.status === 401) { location.assign("/auth/login"); return; }
    if (!response.ok) throw new Error("SSO session is unavailable.");
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
function filteredDocs(source) {
  const term = $("search").value.trim().toLocaleLowerCase();
  return state.docs.filter(doc => (!source || doc.source === source) && (!term || `${doc.title} ${doc.source} ${safeText(doc.content)} ${safeText(doc.metadata?.status)} ${safeText(doc.metadata?.project)}`.toLocaleLowerCase().includes(term)));
}
function selectDoc(doc) {
  if (!state.docs.some(item => item.docId === doc.docId)) return;
  state.selected = doc.docId;
  const box = $("selectedDetail"); clear(box); box.hidden = false;
  appendText(box, "p", "eyebrow", `${sourceName(doc.source)} · ${documentStatus(doc)}`);
  appendText(box, "h3", "", doc.title);
  appendText(box, "p", "detail-meta", `Version ${doc.version} · Edited ${fmtDate(doc.updatedAt)} · Tier ${doc.tier}`);
  if (doc.lastIndexedAt) appendText(box, "p", "detail-meta", `Indexed ${fmtDate(doc.lastIndexedAt)}`);
  if (doc.lastPermissionSyncAt) appendText(box, "p", "detail-meta", `Permissions synced ${fmtDate(doc.lastPermissionSyncAt)}`);
  appendText(box, "p", "detail-meta", `Access tier ${doc.tier} narrows source access; native source permissions still apply.`);
  if (doc.content) appendText(box, "p", "", doc.content);
  else appendText(box, "p", "muted", "Preview is loading from the workspace API. Open the source or ask the Brain for a cited summary.");
  box.append(externalLink(doc.url, "Open source ↗"));
  reveal(box);
}
function activityButton(doc, source) {
  const button = node("button", "activity-item"); button.type = "button";
  button.append(node("span", "item-title", doc.title), node("span", "item-meta", `${sourceName(source)} · ${documentStatus(doc)} · ${fmtDate(doc.updatedAt)}`));
  button.addEventListener("click", () => source === "jira" ? openJiraSection(doc) : selectDoc(doc));
  return button;
}
function openJiraSection(doc) {
  selectDoc(doc);
  const key = doc.docId.split(":")[1];
  const workDocs = state.docs.filter(item => ["confluence", "drive"].includes(item.source));
  const target = workDocs.find(item => item.content?.toLowerCase().includes(key.toLowerCase())) ||
    workDocs.find(item => item.content?.toLowerCase().includes(key.split("-")[0].toLowerCase()));
  if (!target) { appendText($("selectedDetail"), "p", "muted", "No matching section in accessible project documents."); return; }
  const box = $("selectedDetail");
  const section = target.content?.split(/\n|(?<=[.!?])\s+/).find(part => part.toLowerCase().includes(key.toLowerCase())) ||
    target.content?.split(/\n|(?<=[.!?])\s+/).find(part => part.toLowerCase().includes(key.split("-")[0].toLowerCase()));
  const wrap = node("div", "answer-block");
  appendText(wrap, "strong", "", `Relevant ${sourceName(target.source)} section`);
  appendText(wrap, "p", "", section || "No matching section in this document.");
  wrap.append(externalLink(target.url, `Open ${target.title} ↗`));
  box.append(wrap);
}
function relatedJira(slack) {
  const jira = state.docs.filter(doc => doc.source === "jira");
  if (!jira.length) return null;
  const text = `${safeText(slack.content)} ${slack.title}`.toLowerCase();
  const byKey = jira.find(doc => text.includes(doc.docId.split(":")[1].toLowerCase()));
  return byKey || jira.find(doc => /payment|cutover/i.test(doc.title) && /payment|cutover/i.test(text)) || null;
}
function renderActivity() {
  const slack = filteredDocs("slack"); const jira = filteredDocs("jira");
  clear($("slackList")); clear($("jiraList")); clear($("suggestion"));
  for (const doc of slack) $("slackList").append(activityButton(doc, "slack"));
  for (const doc of jira) $("jiraList").append(activityButton(doc, "jira"));
  if (!slack.length) appendText($("slackList"), "p", "empty", "No accessible Slack threads match.");
  if (!jira.length) appendText($("jiraList"), "p", "empty", "No accessible Jira tasks match.");
  $("activityCount").textContent = `${slack.length + jira.length}`;
  const suggestion = slack.map(item => ({ slack: item, jira: relatedJira(item) })).find(item => item.jira);
  if (suggestion) {
    appendText($("suggestion"), "strong", "", suggestion.slack.title);
    appendText($("suggestion"), "p", "", `Related task: ${suggestion.jira.title}`);
    const button = node("button", "", "View task and related section ↗"); button.type = "button";
    button.addEventListener("click", () => openJiraSection(suggestion.jira)); $("suggestion").append(button);
  } else appendText($("suggestion"), "p", "empty", "No accessible thread and task pair found.");
}
function scoreDoc(doc) {
  const status = documentStatus(doc);
  const points = { final: 40, "in review": 20, draft: 8, superseded: -100 }[status] || 0;
  const age = Math.max(0, (Date.now() - new Date(doc.updatedAt).getTime()) / 86400000);
  return points + Math.max(0, 30 - age) + Math.min(Number(doc.version) || 0, 10);
}
function latestDoc(docs) { return [...docs].filter(doc => documentStatus(doc) !== "superseded").sort((a,b) => scoreDoc(b)-scoreDoc(a))[0]; }
function renderMaster() {
  const master = state.docs.find(doc => doc.source === "confluence" && doc.metadata?.space === "PAY");
  clear($("masterContent")); clear($("conclusions")); clear($("masterBadge"));
  if (!master) {
    $("docHeading").textContent = "Payment migration";
    appendText($("masterContent"), "p", "empty", "No accessible Confluence master page in this workspace.");
    appendText($("conclusions"), "p", "empty", "No conclusions available from the master page.");
    return;
  }
  $("docHeading").textContent = master.title;
  $("masterBadge").append(statusBadge(master));
  if (master.content) appendText($("masterContent"), "p", "", master.content);
  else appendText($("masterContent"), "p", "muted", "Master content will appear when the workspace API provides it.");
  const meta = node("p", "detail-meta", `Version ${master.version} · Edited ${fmtDate(master.updatedAt)}`);
  $("masterContent").append(meta, externalLink(master.url, "Open Confluence master ↗"));
  const conclusions = safeText(master.content).split(/\n|(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  if (conclusions.length) for (const text of conclusions) appendText($("conclusions"), "div", "conclusion", text);
  else appendText($("conclusions"), "p", "empty", "Conclusions will appear with authorized master content.");
  if (role() === "admin" && master.content) {
    const form = node("form", "conclusion-form");
    const label = node("label", "", "Append conclusion to master"); label.htmlFor = "newConclusion";
    const input = node("textarea", ""); input.id = "newConclusion"; input.required = true; input.maxLength = 1000; input.placeholder = "Write a conclusion grounded in the project sources";
    const button = node("button", "", "Append conclusion"); button.type = "submit";
    form.append(label, input, button);
    form.addEventListener("submit", async event => {
      event.preventDefault(); const value = input.value.trim(); if (!value) return;
      button.disabled = true; $("globalStatus").textContent = "Saving conclusion…";
      try { await post("/v1/admin/content", { docId: master.docId, content: `${master.content.trim()}\n${value}` }); await loadWorkspace(); $("globalStatus").textContent = "Conclusion saved to Confluence master."; }
      catch (error) { $("globalStatus").textContent = error.message; }
      finally { button.disabled = false; }
    });
    $("conclusions").append(form);
  }
}
function duplicatePair(docs) {
  const normalize = title => title.toLowerCase().replace(/\b(copy|draft|final|v\d+)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const old of docs.filter(doc => documentStatus(doc) === "superseded")) {
    const current = docs.find(doc => doc.docId !== old.docId && documentStatus(doc) !== "superseded" && normalize(doc.title) === normalize(old.title));
    if (current) return { old, current };
  }
  return null;
}
function renderDrive() {
  const docs = filteredDocs("drive"); clear($("driveList")); clear($("duplicate")); $("duplicate").hidden = true;
  $("driveCount").textContent = `${docs.length} accessible`;
  const latest = latestDoc(state.docs.filter(doc => doc.source === "drive"));
  $("latestExplanation").textContent = latest ? `Latest: ${latest.title}. Score favors final status, recent edits, and higher versions; superseded copies are excluded.` : "";
  for (const doc of docs) {
    const button = node("button", "file-row"); button.type = "button";
    button.append(node("span", "file-icon", "D"));
    const main = node("span", "file-main"); main.append(node("span", "item-title", doc.title), node("span", "item-meta", `Edited ${fmtDate(doc.updatedAt)} · v${doc.version}`));
    button.append(main, statusBadge(doc));
    if (latest?.docId === doc.docId) {
      const badge = node("span", "badge", "Latest"); badge.title = "Highest weighted score: final status, recent edit, and version. Superseded files are excluded."; button.append(badge);
    }
    button.addEventListener("click", () => selectDoc(doc)); $("driveList").append(button);
  }
  if (!docs.length) appendText($("driveList"), "p", "empty", "No accessible Drive documents match.");
  const pair = duplicatePair(docs);
  if (pair) {
    const area = $("duplicate"); area.hidden = false;
    appendText(area, "strong", "", "Possible duplicate · review before merging");
    appendText(area, "p", "", `${pair.old.title} is superseded by ${pair.current.title}.`);
    const button = node("button", "", "Compare documents ↗"); button.type = "button";
    button.addEventListener("click", () => {
      selectDoc(pair.current);
      const box = $("selectedDetail"); const compare = node("div", "answer-block");
      appendText(compare, "strong", "", "Superseded copy");
      appendText(compare, "p", "", pair.old.content || "Open the source to compare its content.");
      compare.append(externalLink(pair.old.url, `Open ${pair.old.title} ↗`)); box.append(compare);
    }); area.append(button);
  }
}
function renderSources() {
  clear($("allSources")); const docs = filteredDocs();
  for (const doc of docs) {
    const button = node("button", "source-item"); button.type = "button";
    button.append(node("span", "item-title", doc.title), node("span", "item-meta", `${sourceName(doc.source)} · ${documentStatus(doc)}`));
    button.addEventListener("click", () => selectDoc(doc)); $("allSources").append(button);
  }
  if (!docs.length) appendText($("allSources"), "p", "empty", "No accessible sources match your search.");
  const selectedAdminDoc = $("adminDoc").value;
  clear($("adminDoc"));
  for (const doc of state.docs) { const option = node("option", "", `${doc.title} · ${doc.docId}`); option.value = doc.docId; $("adminDoc").append(option); }
  if (state.docs.some(doc => doc.docId === selectedAdminDoc)) $("adminDoc").value = selectedAdminDoc;
}
function renderWorkspace() { renderActivity(); renderMaster(); renderDrive(); renderSources(); }
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
    const refreshed = await loadWorkspace();
    if (generation !== state.identity || docId !== $("adminDoc").value) return;
    $("nativeStatus").textContent = !refreshed ? "Source permissions saved, but the workspace refresh failed." : state.nativeDoc !== docId ? "Source permissions saved, but current permissions could not be reloaded. Use Reload current permissions." : "Source permissions saved and workspace refreshed.";
  } catch (error) {
    if (generation === state.identity && docId === $("adminDoc").value) {
      $("nativeStatus").textContent = error.message;
      $("saveNativePermissions").disabled = false;
    }
  }
}
async function loadWorkspace() {
  const generation = state.identity;
  $("workspaceNotice").textContent = "Loading accessible documents…";
  try {
    const result = await call("/v1/workspace");
    if (generation !== state.identity) return;
    state.docs = Array.isArray(result.documents) ? result.documents.filter(doc => doc && typeof doc.docId === "string" && typeof doc.title === "string") : [];
    renderWorkspace();
    if (role() === "admin") await loadNativePermissions();
    if (generation !== state.identity) return;
    $("workspaceNotice").textContent = `${state.docs.length} accessible sources · Contents and links are limited to this identity.`;
    if (state.selected) { const doc = state.docs.find(item => item.docId === state.selected); if (doc) selectDoc(doc); else { clear($("selectedDetail")); $("selectedDetail").hidden = true; state.selected = null; } }
    applyLandingPreference();
    if (!state.landingApplied) {
      state.landingApplied = true;
      if ($("landingPreference").value !== "master" || window.innerWidth <= 700) requestAnimationFrame(focusLanding);
    }
    return true;
  } catch (error) { if (generation === state.identity) $("workspaceNotice").textContent = `Workspace unavailable: ${error.message}`; return false; }
}
function renderCitations(parent, citations) {
  if (!Array.isArray(citations) || !citations.length) return;
  const list = node("div", "citation-list"); appendText(list, "strong", "", "Sources");
  for (const citation of citations) {
    if (!citation || !safeUrl(citation.url)) continue;
    list.append(externalLink(citation.url, `${safeText(citation.title)} · v${citation.version} · edited ${fmtDate(citation.updatedAt)}`));
  }
  parent.append(list);
}
function renderAnswer(target, result, question) {
  clear(target); target.hidden = false;
  if (question) appendText(target, "p", "", question);
  appendText(target, "div", "", safeText(result.text) || "No answer returned.");
  renderCitations(target, result.citations);
  if (result.traceId) {
    const button = node("button", "text-button", "Why this result? View trace ↗"); button.type = "button";
    button.addEventListener("click", () => showTrace(result.traceId)); target.append(button);
  }
}
async function ask(question, target, displayQuestion = false) {
  const generation = state.identity;
  target.hidden = false; setMessage(target, "Checking accessible sources…");
  const result = await post("/v1/query", { question });
  if (generation !== state.identity) return null;
  renderAnswer(target, result, displayQuestion ? question : "");
  if (result.importNotice) appendText(target, "p", "muted", result.importNotice);
  return result;
}
function applyLandingPreference() {
  const preference = localStorage.getItem("brain-landing") || "master";
  $("landingPreference").value = ["master", "activity", "files"].includes(preference) ? preference : "master";
}
function focusLanding() {
  const target = { master: $("docHeading"), activity: $("slackTitle"), files: $("driveList") }[$("landingPreference").value];
  reveal(target);
}
async function adminAction(path, body, success) {
  const generation = state.identity;
  $("adminStatus").textContent = "Applying change…";
  try { await post(path, body); if (generation !== state.identity || role() !== "admin") return; $("adminStatus").textContent = success; await loadWorkspace(); }
  catch (error) { if (generation === state.identity && role() === "admin") $("adminStatus").textContent = error.message; }
}
async function loadHealth() {
  const generation = state.identity; $("healthStatus").textContent = "Loading health…";
  try {
    const result = await call("/health"); if (generation !== state.identity) return;
    clear($("healthCards"));
    for (const item of result.sync || []) {
      const card = node("div", "surface"); appendText(card, "h2", "", sourceName(item.source));
      appendText(card, "p", "", `Cursor ${item.cursor} · Last sync ${fmtDate(item.lastSuccessfulSyncAt)}`);
      const pending = (result.pending || []).find(run => run.source === item.source);
      appendText(card, "p", "muted", pending ? `Run: ${pending.status} · ${pending.pendingIds?.length || 0} pending` : "No pending run");
      $("healthCards").append(card);
    }
    $("healthStatus").textContent = `${result.auditEntries || 0} audit events · ${result.merkleBatches || 0} Merkle batches`;
  } catch (error) { if (generation === state.identity) $("healthStatus").textContent = error.message; }
}
function eventSummary(entry) {
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  return Object.entries(data).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
}
function localAuditSearch(entries, query) {
  const text = query.trim().toLowerCase(); if (!text) return entries;
  const terms = text.split(/\s+/).filter(term => !["for", "the", "a", "an", "show", "find", "me", "events", "event", "about"].includes(term));
  const normalized = terms.map(term => ({ denied: "false", allowed: "true", permission: "permission", access: "access" })[term] || term);
  return entries.filter(entry => normalized.every(term => `${entry.type} ${entry.actor} ${eventSummary(entry)}`.toLowerCase().includes(term)));
}
function renderAudit(entries) {
  state.auditEntries = entries; clear($("auditRows"));
  for (const entry of entries) {
    const row = node("tr", "");
    appendText(row, "td", "", `#${entry.sequence} · ${fmtDate(entry.timestamp)}`);
    appendText(row, "td", "", entry.type);
    appendText(row, "td", "", entry.actor);
    appendText(row, "td", "", eventSummary(entry));
    const cell = node("td", ""); const button = node("button", "", "Inspect proof"); button.type = "button";
    button.addEventListener("click", () => inspectProof(entry.sequence)); cell.append(button); row.append(cell);
    $("auditRows").append(row);
  }
  if (!entries.length) { const row = node("tr", ""); const cell = node("td", "empty", "No matching audit events."); cell.colSpan = 5; row.append(cell); $("auditRows").append(row); }
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
    renderAudit(entries); $("auditStatus").textContent = `${entries.length} matching events`;
  } catch (error) {
    if (generation !== state.identity || role() !== "compliance") return;
    if (error.status !== 404) { $("auditStatus").textContent = error.message; return; }
    const entries = localAuditSearch(state.audit.entries || [], query);
    renderAudit(entries); $("auditStatus").textContent = `${entries.length} matching events · local search`;
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
    const button = node("button", "secondary-button", "Verify proof"); button.type = "button"; button.addEventListener("click", () => verifyProof(sequence)); box.append(button);
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
function traceDetails(entry, rank) {
  const data = entry.data || {};
  const ref = data.docRef ? ` · doc ref ${String(data.docRef).slice(0, 12)}…` : "";
  switch (entry.type) {
    case "query_received": return ["Question received", "Question recorded as a hash."];
    case "candidates_found": return ["Hybrid candidates", `${data.count ?? 0} document IDs retrieved before authorization.`];
    case "candidate_ranked": return ["Candidate ranked", `Rank ${rank} · score ${data.score ?? "unknown"}${ref} · chunk ref ${String(data.chunkRef || "").slice(0, 12)}…`];
    case "access_decision": return ["FGA and tier check", `${data.allowed ? "Allowed" : "Denied"}${ref} · reason ${safeText(data.reason) || "unspecified"}`];
    case "live_access_decision": return ["Live source check", `${data.allowed ? "Allowed" : "Denied"}${ref}${data.sourceVersion ? ` · source v${data.sourceVersion}` : ""}${data.refreshed === true ? " · refreshed" : data.refreshed === false ? " · version current" : ""}`];
    case "context_sent": return ["Context sent to LLM", `${Array.isArray(data.chunkIds) ? data.chunkIds.length : 0} authorized fresh chunks passed${Array.isArray(data.chunkIds) && data.chunkIds.length ? ` · ${data.chunkIds.join(", ")}` : ""}.`];
    case "answer_returned": return ["Answer returned", data.empty ? "Fixed no-result response." : `${Array.isArray(data.citationIds) ? data.citationIds.length : 0} citations returned after output check${Array.isArray(data.citationIds) && data.citationIds.length ? ` · ${data.citationIds.join(", ")}` : ""}.`];
    default: return [entry.type.replaceAll("_", " "), eventSummary(entry) || "Recorded in audit log."];
  }
}
async function showTrace(traceId) {
  const generation = state.identity;
  const box = role() === "compliance" ? $("tracePanel") : $("workspaceTrace");
  if (role() === "compliance") setView("compliance"); else setView("workspace");
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
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
$("user").addEventListener("change", resetIdentity);
$("search").addEventListener("input", () => { renderActivity(); renderDrive(); renderSources(); });
$("landingPreference").addEventListener("change", () => { localStorage.setItem("brain-landing", $("landingPreference").value); focusLanding(); });
$("minimizeChat").addEventListener("click", () => {
  const collapsed = $("chatPanel").classList.toggle("minimized");
  $("workspaceView").classList.toggle("chat-collapsed", collapsed);
  $("minimizeChat").setAttribute("aria-expanded", String(!collapsed));
  $("minimizeChat").setAttribute("aria-label", collapsed ? "Expand chat" : "Minimize chat");
  $("minimizeChat").textContent = collapsed ? "+" : "−";
});
$("queryForm").addEventListener("submit", async event => {
  event.preventDefault(); const question = $("question").value.trim(); if (!question) return;
  const generation = state.identity; const history = $("chatHistory");
  appendText(history, "div", "message question", question);
  const response = node("div", "message answer", "Checking accessible sources…"); history.append(response);
  $("askButton").disabled = true; $("queryStatus").textContent = "Checking permissions and source versions…";
  try { const result = await ask(question, response); if (generation !== state.identity) return; $("queryStatus").textContent = result.citations?.length ? "Answer grounded in authorized sources." : "No accessible result."; $("question").value = ""; }
  catch (error) { if (generation === state.identity) { response.textContent = error.message; $("queryStatus").textContent = "Query failed."; } }
  finally { $("askButton").disabled = false; history.scrollTop = history.scrollHeight; }
});
$("catchUp").addEventListener("click", async () => {
  const target = $("catchUpResult");
  try { await ask("Summarize the current payment migration status, PAY-101, SEC-44, cutover decisions and the chargeback workflow for a new intern. Cite accessible sources only.", target); }
  catch (error) { target.textContent = error.message; }
});
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
$("refreshHealth").addEventListener("click", loadHealth);
$("retrySync").addEventListener("click", async () => {
  const generation = state.identity; $("healthStatus").textContent = "Running connector sync…";
  try { await post("/v1/admin/sync", {}); if (generation !== state.identity || role() !== "admin") return; await Promise.all([loadHealth(), loadWorkspace()]); $("healthStatus").textContent = "Connector sync complete."; }
  catch (error) { if (generation === state.identity && role() === "admin") $("healthStatus").textContent = error.message; }
});
$("loginButton").addEventListener("click", () => location.assign("/auth/login"));
$("logoutButton").addEventListener("click", () => location.assign("/auth/logout"));
initAuth();
