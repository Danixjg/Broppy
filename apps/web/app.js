import { narrowerPermissionError } from "./permissions.js";
import { answerLines, auditSummary, isDemoAddress, isRoutineSync, leftOutNote, looksLikeAuditQuestion, numberSources, quotedRanges } from "./answer.js";
import { showMoreLabel, visibleItems } from "./lists.js";
import { chosenProject } from "./projects.js";
import { linkedTask } from "./links.js";

const API = "/api/brain";
const $ = id => document.getElementById(id);
const emptyWorkspace = () => ({ projects: [], latest: [], duplicates: [], suggestions: [], commitments: [], owners: [], capabilities: {} });
let deepLinkApplied = false;
const state = { chat: [], docs: [], workspace: emptyWorkspace(), project: null, selected: null, selectedQuotes: [], view: "workspace", identity: 0, audit: null, auditEntries: [], proof: null, landingApplied: false, authConfig: null, authMode: "loading", signedIn: false, me: null, nativeLoad: 0, nativeDoc: null, nativeCurrent: null };
const roles = { maya: "admin", nur: "compliance" };
// The lists opened in full since the last search, project or person change.
const expandedLists = new Set();
const safeText = value => typeof value === "string" ? value : "";
const fmtDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const fmtDay = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
};
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
const clear = element => element.replaceChildren();
const reveal = (element, block = "nearest") => element?.scrollIntoView({ block, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
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
// A document's own page at its platform. The demo's documents have placeholder addresses that no browser can open.
function sourceLink(url, source) {
  if (isDemoAddress(url)) return node("span", "muted demo-note", `Demo document: there's no live ${sourceName(source)} page.`);
  return externalLink(url, `Open in ${sourceName(source)} ↗`);
}
// The document's text with the lines an answer quoted from it marked.
function highlighted(content, quotes) {
  const paragraph = node("p", "document-text");
  let position = 0;
  for (const [start, end] of quotedRanges(content, quotes)) {
    paragraph.append(content.slice(position, start), node("mark", "", content.slice(start, end)));
    position = end;
  }
  paragraph.append(content.slice(position));
  return paragraph;
}
function statusBadge(doc) {
  const status = documentStatus(doc);
  const tone = { "in review": "review", draft: "draft", superseded: "superseded" }[status] || "";
  return node("span", `status-badge ${tone}`, status);
}
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
// load: whether opening Compliance loads the whole audit; a caller about to search it passes false.
// Source controls edit the practice data and its demo people directly; a company on its live tools changes access at
// the tools themselves, so the page isn't shown there.
const practiceControls = () => role() === "admin" && state.workspace.capabilities.mode !== "live";
function setView(view, { load = true } = {}) {
  if (view === "admin" && !practiceControls()) view = "workspace";
  if (view === "compliance" && role() !== "compliance") view = "workspace";
  state.view = view;
  for (const name of ["workspace", "admin", "compliance", "operations"]) {
    $(`${name}View`).hidden = name !== view;
    const button = document.querySelector(`[data-view="${name}"]`);
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (view === "compliance" && load) loadAudit();
  if (view === "operations") loadHealth();
}
function resetIdentity() {
  state.identity++;
  deepLinkApplied = false;
  state.chat = []; state.docs = []; state.workspace = emptyWorkspace(); state.project = null; expandedLists.clear(); state.selected = null; state.selectedQuotes = []; state.audit = null; state.auditEntries = []; state.proof = null; state.nativeLoad++; state.nativeDoc = null;
  for (const id of ["projectSelect", "slackList", "jiraList", "suggestion", "masterContent", "conclusions", "driveList", "duplicate", "allSources", "selectedDetail", "workspaceTrace", "chatHistory", "previewResult", "auditSummary", "routineHidden", "auditRows", "proofPanel", "tracePanel", "healthCards"]) clear($(id));
  $("duplicate").hidden = true; $("selectedDetail").hidden = true; $("workspaceTrace").hidden = true; $("catchUpResult").hidden = true; $("proofPanel").hidden = true; $("tracePanel").hidden = true;
  for (const id of ["queryStatus", "adminStatus", "auditStatus", "healthStatus", "globalStatus"]) setMessage($(id), "");
  for (const id of ["question", "adminContent", "auditSearch", "memberGroup", "memberChannelDoc"]) $(id).value = "";
  $("hideRoutine").checked = true;
  for (const id of ["masterBadge", "activityCount", "driveCount", "latestExplanation", "adminDoc"]) clear($(id));
  clearNativeEditor();
  $("adminTab").hidden = !practiceControls();
  let connectorLink = document.getElementById("connectorSettings");
  if (!connectorLink) { connectorLink = node("a", "", "Connectors settings"); connectorLink.id = "connectorSettings"; $("adminView").prepend(connectorLink); }
  connectorLink.href = `./connectors.html?user=${encodeURIComponent($("user").value)}`;
  connectorLink.hidden = role() !== "admin";
  let peopleLink = document.getElementById("peopleSettings");
  if (!peopleLink) { peopleLink = node("a", "", "People and access"); peopleLink.id = "peopleSettings"; peopleLink.style.marginLeft = "1rem"; connectorLink.after(peopleLink); }
  peopleLink.href = "./people.html";
  // Adding people is a signed-in admin's job; the public demo has no directory to add to.
  peopleLink.hidden = role() !== "admin" || state.authMode === "demo";
  let setupLink = document.getElementById("setupGuide");
  if (!setupLink) { setupLink = node("a", "", "Guided setup"); setupLink.id = "setupGuide"; setupLink.style.marginLeft = "1rem"; peopleLink.after(setupLink); }
  setupLink.href = "./setup.html";
  setupLink.hidden = role() !== "admin" || state.authMode === "demo";
  $("complianceTab").hidden = role() !== "compliance";
  $("retrySync").hidden = role() !== "admin";
  setView("workspace");
  if (state.authMode === "demo" || state.me) loadWorkspace();
  else $("workspaceNotice").textContent = state.signedIn ? "Your accessible documents are unavailable for this account." : "Log in to view your accessible documents.";
}
function updateAuthUi(message = "") {
  const signedInMode = state.authMode === "auth0";
  const demo = state.authMode === "demo";
  $("demoIdentity").hidden = !demo;
  $("user").disabled = !demo;
  $("authIdentity").hidden = !signedInMode && !demo;
  $("authName").textContent = demo ? "" : state.me?.name || "";
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
const docById = docId => state.docs.find(doc => doc.docId === docId);
function currentProject() { return state.workspace.projects.find(project => project.key === state.project); }
function inProject(docId) { const project = currentProject(); return !project || project.docIds.includes(docId); }
function filteredDocs(source) {
  const term = $("search").value.trim().toLocaleLowerCase();
  return state.docs.filter(doc => (!source || doc.source === source) && inProject(doc.docId) && (!term || `${doc.title} ${doc.source} ${safeText(doc.content)} ${safeText(doc.metadata?.status)} ${safeText(doc.metadata?.project)}`.toLocaleLowerCase().includes(term)));
}
// quotes: the lines an answer took from this document, marked in its text. focus: opened from an answer, so the
// panel takes the keyboard focus.
function selectDoc(doc, quotes = [], { focus = false } = {}) {
  if (!state.docs.some(item => item.docId === doc.docId)) return;
  state.selected = doc.docId; state.selectedQuotes = quotes;
  const box = $("selectedDetail"); clear(box); box.hidden = false;
  appendText(box, "p", "eyebrow", `${sourceName(doc.source)} · ${documentStatus(doc)}`);
  const heading = node("h3", "", doc.title); heading.tabIndex = -1; box.append(heading);
  appendText(box, "p", "detail-meta", `Version ${doc.version} · Edited ${fmtDate(doc.updatedAt)} · Tier ${doc.tier}`);
  if (doc.lastIndexedAt) appendText(box, "p", "detail-meta", `Indexed ${fmtDate(doc.lastIndexedAt)}`);
  if (doc.lastPermissionSyncAt) appendText(box, "p", "detail-meta", `Permissions synced ${fmtDate(doc.lastPermissionSyncAt)}`);
  appendText(box, "p", "detail-meta", `Access tier ${doc.tier} narrows source access; native source permissions still apply.`);
  if (doc.content) box.append(highlighted(doc.content, quotes));
  else appendText(box, "p", "muted", "Preview is loading from the workspace API. Open the source or ask the Brain for a cited summary.");
  box.append(sourceLink(doc.url, doc.source));
  renderLinked(box, doc);
  if (focus) heading.focus({ preventScroll: true });
  // A marked line is centred, so the reader sees it with the text around it.
  const mark = box.querySelector("mark");
  if (mark) reveal(mark, "center"); else reveal(box);
}
// A document an answer cited, opened here with the answer's lines from it marked. Every cited document is one this
// person may open, so the workspace lists it.
function openSource(source, quotes) {
  const doc = docById(source.docId);
  if (doc) (doc.source === "jira" ? openTask : selectDoc)(doc, quotes, { focus: true });
}
// Items linked to this one that this person may also open: the API never lists any others.
function linkedDocs(doc) { return (Array.isArray(doc.links) ? doc.links : []).map(docById).filter(Boolean); }
function renderLinked(box, doc) {
  const linked = linkedDocs(doc);
  if (!linked.length) return;
  const wrap = node("div", "linked-items"); appendText(wrap, "strong", "", "Linked items");
  for (const item of linked) {
    const button = node("button", "text-button", `${sourceName(item.source)} · ${item.title}`); button.type = "button";
    button.addEventListener("click", () => item.source === "jira" ? openTask(item) : selectDoc(item));
    wrap.append(button);
  }
  box.append(wrap);
}
// Appends the first items, and a "Show N more" button that appends the rest and moves the focus to the first of them.
function appendLimited(box, items, noun, render) {
  const { shown, hidden } = visibleItems(items, expandedLists.has(box.id));
  for (const item of shown) box.append(render(item));
  if (!hidden) return;
  const more = node("button", "text-button show-more", showMoreLabel(hidden, noun)); more.type = "button";
  more.addEventListener("click", () => {
    expandedLists.add(box.id);
    const rest = items.slice(shown.length).map(render);
    more.replaceWith(...rest);
    rest[0]?.focus();
  });
  box.append(more);
}
function activityButton(doc, source) {
  const button = node("button", "activity-item"); button.type = "button";
  button.append(node("span", "item-title", doc.title), node("span", "item-meta", `${sourceName(source)} · ${documentStatus(doc)} · ${fmtDate(doc.updatedAt)}`));
  button.addEventListener("click", () => source === "jira" ? openTask(doc) : selectDoc(doc));
  return button;
}
const sentencesOf = text => safeText(text).split(/\n|(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
// A Jira task with the section of its linked page or file that names it, and Mark done.
function openTask(doc, quotes = [], options = {}) {
  selectDoc(doc, quotes, options);
  const box = $("selectedDetail");
  const key = doc.docId.split(":")[1] || "";
  const work = linkedDocs(doc).filter(item => ["confluence", "drive"].includes(item.source));
  const target = work.find(item => sentencesOf(item.content).some(sentence => sentence.includes(key))) || work[0];
  const wrap = node("div", "answer-block");
  if (target) {
    appendText(wrap, "strong", "", `Working doc: ${target.title}`);
    const sentence = sentencesOf(target.content).find(item => item.includes(key)) || sentencesOf(target.content)[0] || "";
    appendText(wrap, "p", "", sentence);
    const open = node("button", "text-button", `Open ${target.title}`); open.type = "button";
    open.addEventListener("click", () => selectDoc(target, sentence ? [sentence] : [], { focus: true }));
    wrap.append(open);
    if (!isDemoAddress(target.url)) wrap.append(" ", sourceLink(target.url, target.source));
  } else appendText(wrap, "p", "muted", "No linked page or file that you can open.");
  if (documentStatus(doc) === "done") appendText(wrap, "p", "muted", "This task is done.");
  else if (state.workspace.capabilities.markDone === true) {
    const done = node("button", "secondary-button", "Mark done"); done.type = "button";
    done.addEventListener("click", () => markDone(doc, done));
    wrap.append(done);
  } else wrap.append(sourceLink(doc.url, "jira"));
  box.append(wrap);
}
async function markDone(doc, button) {
  const generation = state.identity;
  button.disabled = true; $("globalStatus").textContent = "Marking the task done…";
  try {
    await post("/v1/tasks/done", { docId: doc.docId });
    if (generation !== state.identity) return;
    await loadWorkspace();
    if (generation === state.identity) $("globalStatus").textContent = `${doc.title} is done.`;
  } catch (error) { if (generation === state.identity) { $("globalStatus").textContent = error.message; button.disabled = false; } }
}
// Agreements in this project's threads that could become a Jira task. The API offers them only from threads this
// person may open, and only when creating the task here is possible; with live sources it links to Jira instead.
function renderSuggestions() {
  const box = $("suggestion"); clear(box);
  const items = state.workspace.commitments.filter(item => inProject(item.threadDocId) && docById(item.threadDocId));
  if (!items.length) { appendText(box, "p", "empty", "No commitment is awaiting review in your accessible, imported threads."); return; }
  for (const item of items) {
    const card = node("div", "agreement"); card.dataset.proposalId = item.id; card.tabIndex = -1;
    appendText(card, "strong", "", `Commitment in ${docById(item.threadDocId).title}`);
    appendText(card, "blockquote", "", item.sentence);
    if (item.permalink) card.append(externalLink(item.permalink, "Open exact Slack message ↗"));
    else appendText(card, "p", "muted", "Legacy thread evidence. An exact message reference is unavailable.");
    if (item.status !== "pending") {
      appendText(card, "p", "", `${item.status === "created" ? "Created" : "Linked to"} ${safeText(item.issueTitle)}.`);
      const open = node("button", "text-button", "Open linked Jira task"); open.type = "button";
      open.addEventListener("click", () => { const doc = docById(item.issueDocId); if (doc) openTask(doc); });
      card.append(open); box.append(card); continue;
    }
    appendText(card, "p", "muted", item.notice);
    if (item.importNotice) appendText(card, "p", "muted", item.importNotice);
    const form = node("form", "commitment-review");
    const summaryLabel = node("label", "", "Summary"); const summary = node("input", ""); summary.value = item.summary; summary.maxLength = 200; summary.required = true;
    summaryLabel.append(summary);
    const ownerLabel = node("label", "", "Owner"); const owner = node("select", "");
    const unknown = node("option", "", "Unknown / unassigned"); unknown.value = ""; owner.append(unknown);
    for (const person of state.workspace.owners) { const option = node("option", "", person.name); option.value = person.slackId; owner.append(option); }
    if (item.ownerSlackId && !state.workspace.owners.some(person => person.slackId === item.ownerSlackId)) {
      const unresolved = node("option", "", "Source owner unresolved"); unresolved.value = item.ownerSlackId; owner.append(unresolved);
    }
    owner.value = item.ownerSlackId || ""; ownerLabel.append(owner);
    const dueLabel = node("label", "", "Due date (blank means unknown)"); const due = node("input", ""); due.type = "date"; due.value = item.dueDate || ""; dueLabel.append(due);
    const save = node("button", "secondary-button", "Save review"); save.type = "submit";
    form.append(summaryLabel, ownerLabel, dueLabel, save);
    const dirty = () => { create.disabled = summary.value !== item.summary || owner.value !== (item.ownerSlackId || "") || due.value !== (item.dueDate || ""); };
    form.addEventListener("submit", event => { event.preventDefault(); reviewCommitment(item,
      { action: "edit", summary: summary.value, ownerSlackId: owner.value, dueDate: due.value }, save); });
    card.append(form);
    const create = node("button", "", `Create Jira task in ${item.project} ↗`); create.type = "button";
    for (const field of [summary, owner, due]) field.addEventListener("input", dirty);
    if (item.canCreate && state.workspace.capabilities.createTask === true) {
      create.addEventListener("click", () => createTask(item, create)); card.append(create);
      if (state.workspace.capabilities.mode === "live") appendText(card, "p", "muted",
        `This creates the issue in your company's Jira. Everyone who can see the ${item.project} project there will see its title.`);
    } else if (item.jiraUrl) card.append(externalLink(item.jiraUrl, `Open ${item.project} in Jira ↗`));
    const dismiss = node("button", "text-button", "Dismiss"); dismiss.type = "button";
    dismiss.addEventListener("click", () => reviewCommitment(item, { action: "dismiss" }, dismiss)); card.append(dismiss);
    if (item.candidates?.length) {
      appendText(card, "p", "muted", "Possible existing work. Similarity requires your review.");
      for (const candidate of item.candidates) {
        const row = node("div", "candidate-review");
        row.append(externalLink(candidate.url, candidate.title));
        const link = node("button", "secondary-button", "Link existing"); link.type = "button";
        link.addEventListener("click", () => reviewCommitment(item, { action: "link", issueDocId: candidate.docId }, link));
        row.append(link); card.append(row);
      }
    } else appendText(card, "p", "muted", "No title or text match found in the visible project sources. This does not establish that work is untracked.");
    const visibleIssues = state.docs.filter(doc => doc.source === "jira" && doc.metadata?.project === item.project);
    if (visibleIssues.length) {
      const label = node("label", "commitment-review", "Review another visible Jira issue"); const select = node("select", "");
      const placeholder = node("option", "", "Choose an issue"); placeholder.value = ""; select.append(placeholder);
      for (const issue of visibleIssues) { const option = node("option", "", issue.title); option.value = issue.docId; select.append(option); }
      const review = node("button", "text-button", "Open selected issue"); review.type = "button"; review.disabled = true;
      review.addEventListener("click", () => { const doc = docById(select.value); if (doc) openTask(doc); });
      const link = node("button", "secondary-button", "Link selected issue"); link.type = "button"; link.disabled = true;
      select.addEventListener("change", () => { review.disabled = !select.value; link.disabled = !select.value; });
      link.addEventListener("click", () => reviewCommitment(item, { action: "link", issueDocId: select.value }, link));
      label.append(select, review, link); card.append(label);
    }
    box.append(card);
  }
}
async function reviewCommitment(item, command, button) {
  const generation = state.identity; button.disabled = true;
  try {
    await post("/v1/commitments/review", { id: item.id, revision: item.revision, ...command });
    if (generation !== state.identity) return;
    await loadWorkspace();
    if (generation === state.identity) $("globalStatus").textContent = command.action === "edit" ? "Review saved. Create or link after reviewing the saved fields." : "Commitment review saved.";
  } catch (error) { if (generation === state.identity) { $("globalStatus").textContent = error.message; button.disabled = false; } }
}
async function createTask(item, button) {
  const generation = state.identity;
  button.disabled = true; $("globalStatus").textContent = "Creating the Jira task…";
  try {
    const result = await post("/v1/tasks", { threadDocId: item.threadDocId, sentence: item.sentence, proposalId: item.id, revision: item.revision });
    if (generation !== state.identity) return;
    await loadWorkspace();
    if (generation !== state.identity) return;
    $("globalStatus").textContent = `Created ${safeText(result.title)}.`;
    const created = docById(result.docId);
    if (created) { state.selected = created.docId; openTask(created); }
  } catch (error) { if (generation === state.identity) { $("globalStatus").textContent = error.message; button.disabled = false; } }
}
function renderActivity() {
  const slack = filteredDocs("slack"); const jira = filteredDocs("jira");
  clear($("slackList")); clear($("jiraList"));
  appendLimited($("slackList"), slack, "thread", doc => activityButton(doc, "slack"));
  appendLimited($("jiraList"), jira, "task", doc => activityButton(doc, "jira"));
  if (!slack.length) appendText($("slackList"), "p", "empty", "No accessible Slack threads match.");
  if (!jira.length) appendText($("jiraList"), "p", "empty", "No accessible Jira tasks match.");
  $("activityCount").textContent = `${slack.length + jira.length}`;
  renderSuggestions();
}
function renderProjects() {
  const select = $("projectSelect"); clear(select);
  for (const project of state.workspace.projects) {
    const option = node("option", "", project.name); option.value = project.key; select.append(option);
  }
  const all = node("option", "", "All sources"); all.value = ""; select.append(all);
  select.value = state.project;
  select.disabled = !state.workspace.projects.length;
}
// The project on screen, or the one this person last chose, if they may still open it, else their first.
function chooseProject() {
  let saved = null;
  try { saved = localStorage.getItem("brain-project"); } catch { saved = null; }
  state.project = chosenProject(state.project, saved, state.workspace.projects.map(project => project.key));
}
function renderMaster() {
  const project = currentProject();
  const master = project && docById(project.masterDocId);
  clear($("masterContent")); clear($("conclusions")); clear($("masterBadge"));
  $("projectCrumb").textContent = project ? project.name : "All sources";
  if (!master) {
    $("docHeading").textContent = "All accessible sources";
    appendText($("masterContent"), "p", "empty", state.workspace.projects.length ? "Choose a project to see its master page." :
      "No project's master page is shared with you. Your accessible sources are listed below.");
    appendText($("conclusions"), "p", "empty", "Conclusions appear on a project's master page.");
    return;
  }
  $("docHeading").textContent = project.name;
  $("masterBadge").append(statusBadge(master));
  if (master.content) appendText($("masterContent"), "p", "", master.content);
  else appendText($("masterContent"), "p", "muted", "Master content will appear when the workspace API provides it.");
  const meta = node("p", "detail-meta", `Version ${master.version} · Edited ${fmtDate(master.updatedAt)}`);
  $("masterContent").append(meta, sourceLink(master.url, master.source));
  const conclusions = sentencesOf(master.content);
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
// What a merge would do, shown without changing anything: the five-stage plan asked for a clickable preview.
function previewMerge(pair, area, button) {
  const open = area.querySelector(".merge-preview");
  if (open) { open.remove(); button.setAttribute("aria-expanded", "false"); return; }
  const keep = docById(pair.keep); const other = docById(pair.other);
  const preview = node("div", "merge-preview");
  appendText(preview, "strong", "", "Merge preview");
  appendText(preview, "p", "", `Keep ${keep.title}. ${other.title} would be marked superseded, with a link to ${keep.title}.`);
  for (const [doc, only] of [[other, pair.onlyInOther], [keep, pair.onlyInKeep]]) {
    if (!only.length) continue;
    appendText(preview, "p", "", `Only in ${doc.title}:`);
    const list = node("ul", ""); for (const sentence of only) appendText(list, "li", "", sentence); preview.append(list);
  }
  appendText(preview, "p", "muted", "Preview only: nothing was changed.");
  area.append(preview); button.setAttribute("aria-expanded", "true");
}
function renderDrive() {
  const docs = filteredDocs("drive"); clear($("driveList")); clear($("duplicate")); clear($("latestExplanation"));
  $("duplicate").hidden = true;
  $("driveCount").textContent = `${docs.length} accessible`;
  const latest = state.workspace.latest.find(item => (item.project || "") === state.project && docById(item.docId));
  if (latest) {
    appendText($("latestExplanation"), "p", "", `Latest: ${docById(latest.docId).title}. Superseded copies never count.`);
    const why = node("details", "latest-reasons"); appendText(why, "summary", "", "Why latest?");
    const list = node("ul", ""); for (const reason of latest.reasons) appendText(list, "li", "", reason); why.append(list);
    $("latestExplanation").append(why);
  }
  appendLimited($("driveList"), docs, "file", doc => {
    const button = node("button", "file-row"); button.type = "button";
    button.append(node("span", "file-icon", "D"));
    const main = node("span", "file-main"); main.append(node("span", "item-title", doc.title), node("span", "item-meta", `Edited ${fmtDate(doc.updatedAt)} · v${doc.version}`));
    button.append(main, statusBadge(doc));
    if (latest?.docId === doc.docId) button.append(node("span", "badge", "Latest"));
    button.addEventListener("click", () => selectDoc(doc));
    return button;
  });
  if (!docs.length) appendText($("driveList"), "p", "empty", "No accessible Drive documents match.");
  const shown = new Set(docs.map(doc => doc.docId));
  for (const pair of state.workspace.duplicates.filter(item => (shown.has(item.keep) || shown.has(item.other)) && docById(item.keep) && docById(item.other))) {
    const area = node("div", "duplicate-pair"); $("duplicate").hidden = false;
    appendText(area, "strong", "", "Possible duplicate · review before merging");
    appendText(area, "p", "", `${docById(pair.other).title} looks like a copy of ${docById(pair.keep).title}: ${pair.reasons.join("; ")}.`);
    const button = node("button", "", "Preview merge"); button.type = "button"; button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => previewMerge(pair, area, button));
    area.append(button); $("duplicate").append(area);
  }
}
function renderSources() {
  clear($("allSources")); const docs = filteredDocs();
  appendLimited($("allSources"), docs, "source", doc => {
    const button = node("button", "source-item"); button.type = "button";
    button.append(node("span", "item-title", doc.title), node("span", "item-meta", `${sourceName(doc.source)} · ${documentStatus(doc)}`));
    button.addEventListener("click", () => selectDoc(doc));
    return button;
  });
  if (!docs.length) appendText($("allSources"), "p", "empty", "No accessible sources match your search.");
  const selectedAdminDoc = $("adminDoc").value;
  clear($("adminDoc"));
  for (const doc of state.docs) { const option = node("option", "", `${doc.title} · ${doc.docId}`); option.value = doc.docId; $("adminDoc").append(option); }
  if (state.docs.some(doc => doc.docId === selectedAdminDoc)) $("adminDoc").value = selectedAdminDoc;
}
function renderWorkspace() { renderProjects(); renderActivity(); renderMaster(); renderDrive(); renderSources(); }
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
    const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
    state.workspace = {
      projects: list(result.projects).filter(project => typeof project.key === "string" && typeof project.name === "string" && Array.isArray(project.docIds)),
      latest: list(result.latest).filter(item => typeof item.docId === "string" && Array.isArray(item.reasons)),
      duplicates: list(result.duplicates).filter(item => typeof item.keep === "string" && typeof item.other === "string" && Array.isArray(item.reasons) && Array.isArray(item.onlyInKeep) && Array.isArray(item.onlyInOther)),
      suggestions: list(result.suggestions).filter(item => typeof item.threadDocId === "string" && typeof item.sentence === "string" && typeof item.project === "string"),
      commitments: list(result.commitments).filter(item => typeof item.id === "string" && typeof item.threadDocId === "string" && typeof item.sentence === "string"),
      owners: list(result.owners).filter(item => typeof item.slackId === "string" && typeof item.name === "string"),
      capabilities: result.capabilities || {}
    };
    $("workspaceMode").textContent = state.workspace.capabilities.mode === "live" ? "Live workspace" :
      state.workspace.capabilities.mode === "demo" ? "Demo workspace" : "Workspace";
    $("adminTab").hidden = !practiceControls();
    if (state.view === "admin" && !practiceControls()) setView("workspace");
    const onScreen = state.project;
    chooseProject();
    // A reload after an action leaves the lists as the person had them, unless their project is gone.
    if (state.project !== onScreen) expandedLists.clear();
    renderWorkspace();
    if (practiceControls()) await loadNativePermissions();
    if (generation !== state.identity) return;
    $("workspaceNotice").textContent = `${state.docs.length} accessible sources · Contents and links are limited to this identity.${result.importNotice ? ` ${result.importNotice}` : ""}`;
    if (state.selected) { const doc = state.docs.find(item => item.docId === state.selected); if (doc) (doc.source === "jira" ? openTask : selectDoc)(doc, state.selectedQuotes); else { clear($("selectedDetail")); $("selectedDetail").hidden = true; state.selected = null; state.selectedQuotes = []; } }
    applyLandingPreference();
    applyDeepLink();
    if (!state.landingApplied) {
      state.landingApplied = true;
      if ($("landingPreference").value !== "master" || window.innerWidth <= 700) requestAnimationFrame(focusLanding);
    }
    return true;
  } catch (error) { if (generation === state.identity) $("workspaceNotice").textContent = `Workspace unavailable: ${error.message}`; return false; }
}
function applyDeepLink() {
  if (deepLinkApplied) return;
  const params = new URLSearchParams(location.search);
  if (!["task", "ask", "doc", "proposal", "project"].some(key => params.has(key))) return;
  deepLinkApplied = true;
  const project = params.get("project");
  if (project && !state.workspace.projects.some(item => item.key === project)) {
    $("globalStatus").textContent = "The linked project is unavailable to this identity."; return;
  }
  const proposal = state.workspace.commitments.find(item => item.id === params.get("proposal"));
  const requested = params.get("doc");
  const doc = requested ? docById(requested) : proposal?.issueDocId ? docById(proposal.issueDocId) : linkedTask(state.docs, params.get("task"));
  const containing = doc && state.workspace.projects.find(item => item.docIds.includes(doc.docId));
  if (project || containing) { state.project = project || containing.key; renderWorkspace(); }
  if (doc) (doc.source === "jira" ? openTask : selectDoc)(doc, [], { focus: true });
  else if (proposal) {
    const containing = state.workspace.projects.find(item => item.docIds.includes(proposal.threadDocId));
    if (containing) { state.project = containing.key; renderWorkspace(); }
    const card = [...$("suggestion").children].find(item => item.dataset.proposalId === proposal.id);
    if (card) { card.focus(); reveal(card); }
  } else if (params.has("task")) {
    $("search").value = params.get("task").slice(0, 200); renderWorkspace();
    $("globalStatus").textContent = "Searching your accessible sources for the linked task title.";
  } else if (params.has("doc") || params.has("proposal")) $("globalStatus").textContent = "The linked item is unavailable to this identity.";
  const question = params.get("ask");
  if (question && question.length <= 500) {
    if (!project) { state.project = null; renderWorkspace(); }
    $("question").value = question; $("queryForm").requestSubmit();
  }
}
// The answer's sources, numbered as its lines cite them. Each opens in the workspace with its quoted lines marked.
function renderCitations(parent, sources, lines) {
  if (!sources.length) return;
  const list = node("div", "citation-list"); appendText(list, "strong", "", "Sources");
  const items = node("ol", "source-list");
  for (const source of sources) {
    const via = typeof source.linkedFrom === "string" ? ` · linked from ${docById(source.linkedFrom)?.title || source.linkedFrom}` : "";
    const label = `${safeText(source.title)} · v${source.version} · edited ${fmtDate(source.updatedAt)}${via}`;
    const item = node("li", "");
    if (docById(source.docId)) {
      const quotes = lines.filter(line => line.refs.includes(source.number)).flatMap(quotesOf);
      const button = node("button", "source-button", label); button.type = "button";
      button.addEventListener("click", () => openSource(source, quotes));
      item.append(button);
    } else item.append(isDemoAddress(source.url) || !safeUrl(source.url) ? node("span", "", label) : externalLink(source.url, label));
    items.append(item);
  }
  list.append(items);
  parent.append(list);
}
// Where the answer looked first and the dates it kept to, when the question named them, and the project it kept to.
function scopeText(scope) {
  const names = Array.isArray(scope?.sources) ? scope.sources.map(sourceName).join(" and ") : "";
  const dates = scope?.from && scope?.to ? `${fmtDay(scope.from)} – ${fmtDay(scope.to)}` : "";
  const project = safeText(scope?.project) ? `Kept to ${safeText(scope.project)}.` : "";
  const searched = names && dates ? `Searched ${names} (${dates}) first, then the other sources at any date.` :
    names ? `Searched ${names} first, then the other sources.` : dates ? `Searched everything from ${dates}.` : "";
  return [project, searched].filter(Boolean).join(" ");
}
// One line per claim, each followed by numbered chips for the sources it was copied from.
// What to highlight in a line's source: a copied line's own words, or the sentences that back a reworded one.
const quotesOf = line => line.kind === "reworded" && line.support?.length ? line.support : [line.text];
function renderAnswer(target, result, question) {
  clear(target); target.hidden = false;
  if (question) appendText(target, "p", "", question);
  const sources = numberSources(result.citations);
  const lines = answerLines(safeText(result.text) || "No answer returned.", sources, result.check);
  const body = node("div", "answer-lines");
  for (const line of lines) {
    const row = node("p", "answer-line", line.text);
    if (line.kind === "reworded") {
      const tag = node("span", "reworded-tag", "reworded");
      tag.title = "In the writer's words. Open its source to see the sentence it's based on.";
      row.append(" ", tag);
    }
    for (const number of line.refs) {
      const source = sources[number - 1];
      const chip = node("button", "cite", String(number)); chip.type = "button";
      chip.title = safeText(source.title);
      chip.setAttribute("aria-label", `Source ${number}: ${safeText(source.title)}`);
      chip.addEventListener("click", () => openSource(source, quotesOf(line)));
      row.append(" ", chip);
    }
    body.append(row);
  }
  target.append(body);
  const note = leftOutNote(result.check);
  if (note) appendText(target, "p", "checker-note", note);
  const scope = scopeText(result.scope);
  if (scope) appendText(target, "p", "muted", scope);
  renderCitations(target, sources, lines);
  if (result.traceId) {
    const button = node("button", "text-button", "Why this result? View trace ↗"); button.type = "button";
    button.addEventListener("click", () => showTrace(result.traceId)); target.append(button);
  }
}
// The chat searches documents, so an audit question typed there finds nothing. Compliance staff are offered the audit
// log instead; nobody else sees a difference.
function appendAuditHint(target, question) {
  const hint = node("div", "audit-hint");
  appendText(hint, "p", "", "This looks like a question for the audit log, which records who asked and opened what.");
  const button = node("button", "secondary-button", "Search the audit log"); button.type = "button";
  button.addEventListener("click", () => {
    setView("compliance", { load: false });
    $("auditSearch").value = question;
    searchAudit(question);
  });
  hint.append(button);
  target.append(hint);
}
// While an answer is on its way: a spinner and the seconds so far, so a long wait doesn't look frozen. The chat is a
// live region, so the counter is hidden from screen readers, which hear the label once.
function showPending(target, label) {
  clear(target); target.hidden = false;
  const line = node("p", "pending");
  const spinner = node("span", "spinner"); spinner.setAttribute("aria-hidden", "true");
  const seconds = node("span", "pending-seconds"); seconds.setAttribute("aria-hidden", "true");
  line.append(spinner, label, seconds);
  target.append(line);
  const started = Date.now();
  const timer = setInterval(() => { seconds.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  return () => clearInterval(timer);
}
async function ask(question, target, displayQuestion = false) {
  const generation = state.identity;
  const stop = showPending(target, "Checking permissions and sources…");
  let result;
  try { result = await post("/v1/query", { question, ...(state.chat.length ? { history: state.chat } : {}), ...(state.project ? { project: state.project } : {}) }); } finally { stop(); }
  if (generation !== state.identity) return null;
  if (result.kind === "action" && result.proposal) renderProposal(target, result);
  else renderAnswer(target, result, displayQuestion ? question : "");
  if (result.importNotice) appendText(target, "p", "muted", result.importNotice);
  // The last few turns go back with the next question, so a follow-up can lean on them. Citation markers stay out.
  state.chat = [...state.chat, { role: "user", text: question }, { role: "assistant", text: safeText(result.text).replace(/\s*\[[^\]]+\]/g, "") }].slice(-6);
  return result;
}
// A ticket the chat prepared. Nothing exists in Jira until the person presses Confirm; the project is always theirs to name.
function renderProposal(target, result) {
  clear(target); target.hidden = false;
  const proposal = result.proposal;
  appendText(target, "p", "", safeText(result.text));
  const form = node("form", "proposal");
  const field = (label, control) => { const wrap = node("label", "proposal-field"); wrap.append(node("span", "", label), control); form.append(wrap); return control; };
  const project = field("Project key (required)", node("input"));
  project.value = safeText(proposal.project); project.maxLength = 10; project.required = true; project.placeholder = "For example DB"; project.pattern = "[A-Za-z][A-Za-z0-9]{0,9}";
  const summary = field("Title", node("input")); summary.value = safeText(proposal.summary); summary.maxLength = 250; summary.required = true;
  const description = field("Description", node("textarea")); description.value = safeText(proposal.description); description.maxLength = 5000; description.rows = 4;
  const due = field("Due date (optional)", node("input")); due.type = "date"; due.value = safeText(proposal.dueDate);
  const actions = node("div", "proposal-actions");
  const confirm = node("button", "", "Confirm and create"); confirm.type = "submit";
  const cancel = node("button", "text-button", "Cancel"); cancel.type = "button";
  const status = node("p", "muted"); status.setAttribute("role", "status");
  actions.append(confirm, cancel); form.append(actions, status); target.append(form);
  cancel.addEventListener("click", () => { form.remove(); appendText(target, "p", "muted", "Cancelled. Nothing was created."); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const generation = state.identity; confirm.disabled = true; status.textContent = "Creating the ticket…";
    try {
      const created = await post("/v1/actions/jira-issue", { proposalId: proposal.id, project: project.value.trim().toUpperCase(), summary: summary.value.trim(), description: description.value,
        ...(due.value ? { dueDate: due.value } : {}) });
      if (generation !== state.identity) return;
      form.remove();
      const line = node("p", "", "Created "); const link = node("a", "", safeText(created.key));
      if (/^https:\/\//.test(safeText(created.url))) { link.href = created.url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
      line.append(link, "."); target.append(line);
      state.chat = [...state.chat, { role: "assistant", text: `Created Jira ticket ${safeText(created.key)}.` }].slice(-6);
    } catch (error) {
      if (generation !== state.identity) return;
      // The same confirmation can be pressed again: the API creates one ticket per proposal.
      status.textContent = error.message; confirm.disabled = false;
    }
  });
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
    case "candidate_linked": return ["Linked item", `Reached by a link from an item you may open, score ${data.score ?? "unknown"}${ref}`];
    case "candidate_ranked": return ["Candidate ranked", `Rank ${rank} · score ${data.score ?? "unknown"}${ref} · chunk ref ${String(data.chunkRef || "").slice(0, 12)}…`];
    case "access_decision": return ["FGA and tier check", `${data.allowed ? "Allowed" : "Denied"}${ref} · reason ${safeText(data.reason) || "unspecified"}`];
    case "live_access_decision": return ["Live source check", `${data.allowed ? "Allowed" : "Denied"}${ref}${data.sourceVersion ? ` · source v${data.sourceVersion}` : ""}${data.refreshed === true ? " · refreshed" : data.refreshed === false ? " · version current" : ""}`];
    case "context_sent": return ["Context sent to LLM", `${Array.isArray(data.chunkIds) ? data.chunkIds.length : 0} authorized fresh chunks passed${Array.isArray(data.chunkIds) && data.chunkIds.length ? ` · ${data.chunkIds.join(", ")}` : ""}.`];
    case "answer_returned": return ["Answer returned", data.empty ? "Fixed no-result response." : `${Array.isArray(data.citationIds) ? data.citationIds.length : 0} citations returned after output check${Array.isArray(data.citationIds) && data.citationIds.length ? ` · ${data.citationIds.join(", ")}` : ""}.${leftOutNote(data.check) ? ` ${leftOutNote(data.check)}` : ""}`];
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
$("search").addEventListener("input", () => { expandedLists.clear(); renderActivity(); renderDrive(); renderSources(); });
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
  const response = node("div", "message answer"); history.append(response);
  $("askButton").disabled = true; $("queryStatus").textContent = "Checking permissions and source versions…";
  history.scrollTop = history.scrollHeight;
  try {
    const result = await ask(question, response); if (generation !== state.identity) return;
    if (role() === "compliance" && looksLikeAuditQuestion(question)) appendAuditHint(response, question);
    $("queryStatus").textContent = result.kind === "action" ? "Review the ticket, then confirm." : result.kind === "chat" ? "" : result.citations?.length ? "Answer grounded in authorized sources." : "No accessible result."; $("question").value = "";
  }
  catch (error) { if (generation === state.identity) { response.textContent = error.message; $("queryStatus").textContent = "Query failed."; } }
  finally { $("askButton").disabled = false; history.scrollTop = history.scrollHeight; }
});
// A catch-up chosen by the API from this person's role and groups, kept to the chosen project.
$("catchUp").addEventListener("click", async () => {
  const target = $("catchUpResult"); const generation = state.identity;
  const stop = showPending(target, "Preparing your catch-up…");
  try {
    const result = await post("/v1/catch-up", state.project ? { project: state.project } : {});
    stop();
    if (generation !== state.identity) return;
    if (result.kind === "audit") {
      clear(target); appendText(target, "strong", "", "Audit trail, last 7 days");
      const list = node("ul", ""); for (const line of Array.isArray(result.lines) ? result.lines : []) appendText(list, "li", "", line);
      target.append(list);
    } else renderAnswer(target, { ...result.answer, traceId: result.traceId }, `Asked: ${safeText(result.question)}`);
    if (result.importNotice) appendText(target, "p", "muted", result.importNotice);
  } catch (error) { if (generation === state.identity) target.textContent = error.message; }
  finally { stop(); }
});
$("projectSelect").addEventListener("change", () => {
  state.project = $("projectSelect").value;
  try { localStorage.setItem("brain-project", state.project); } catch { /* The choice is only remembered when storage works. */ }
  clear($("catchUpResult")); $("catchUpResult").hidden = true;
  expandedLists.clear();
  renderWorkspace();
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
$("hideRoutine").addEventListener("change", () => renderAudit(state.auditEntries));
$("refreshHealth").addEventListener("click", loadHealth);
$("retrySync").addEventListener("click", async () => {
  const generation = state.identity; $("healthStatus").textContent = "Running connector sync…";
  try { await post("/v1/admin/sync", {}); if (generation !== state.identity || role() !== "admin") return; await Promise.all([loadHealth(), loadWorkspace()]); $("healthStatus").textContent = "Connector sync complete."; }
  catch (error) { if (generation === state.identity && role() === "admin") $("healthStatus").textContent = error.message; }
});
$("loginButton").addEventListener("click", () => location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname + location.search })}`));
$("logoutButton").addEventListener("click", () => location.assign(state.authMode === "demo" ? "/demo/exit" : "/auth/logout"));
initAuth();
