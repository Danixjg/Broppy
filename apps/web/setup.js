import { ANTHROPIC_MODELS, FIRST_QUESTIONS, TOOLS, addedMessage, checkLines, currentStep, parseEmails, plainError, returnMessage, setupSteps, toolName, toolState } from "./setup-state.js";

const api = "/api/brain";
// In demo mode the workspace links here with the persona it was viewing as; the host ignores it for signed-in users.
const persona = new URLSearchParams(location.search).get("user");
const requestedStep = new URLSearchParams(location.search).get("step");
const $ = id => document.getElementById(id);
const SKIPPED_KEY = "broppy-setup-skipped";

const state = { connections: [], jobs: [], people: [], peopleAvailable: true, model: undefined, skipped: [], open: undefined, lastCurrent: undefined, timer: undefined,
  requested: ["connect", "read", "team", "ai"].includes(requestedStep) ? requestedStep : undefined };
try { state.skipped = JSON.parse(localStorage.getItem(SKIPPED_KEY) || "[]").filter(item => ["team", "model"].includes(item)); } catch { /* A private window forgets what was skipped; that is fine. */ }
const skip = step => { if (!state.skipped.includes(step)) state.skipped.push(step); try { localStorage.setItem(SKIPPED_KEY, JSON.stringify(state.skipped)); } catch { /* Nothing to save to. */ } };

async function request(path, method = "GET", data) {
  let response;
  try {
    response = await fetch(api + path, { method, headers: { "content-type": "application/json", ...(persona ? { "x-demo-user": persona } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  } catch (error) { throw new Error(plainError(error.message)); }
  let result = {};
  try { result = await response.json(); } catch { /* The status below says enough. */ }
  if (response.status === 401 && result.code === "signed_out") { location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname })}`); return new Promise(() => undefined); }
  if (!response.ok) throw new Error(plainError(result.error || "Request failed"));
  return result;
}

function h(tag, attributes = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") el.className = value; else if (name.startsWith("on")) el[name] = value; else if (value !== false && value !== undefined) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children.flat().filter(child => child !== undefined && child !== false));
  return el;
}

function notice(message) {
  const box = $("notice");
  box.hidden = !message; box.textContent = message?.text ?? ""; box.className = `notice ${message?.kind ?? ""}`;
}

// ---- the five steps, opened one at a time ----
function renderSteps() {
  const steps = setupSteps({ connections: state.connections, jobs: state.jobs, people: state.people, model: state.model, skipped: state.skipped, personal: state.personal });
  const current = currentStep(steps);
  // A link can ask for a step (setup.html?step=read), such as "Change what Broppy reads" on Sync health.
  if (state.requested) { state.open = state.requested; state.lastCurrent = current; state.requested = undefined; }
  else if (current !== state.lastCurrent) { state.open = current; state.lastCurrent = current; }
  const done = steps.filter(step => step.status === "done").length;
  const total = steps.length - 1;
  // A personal workspace has no team step at all.
  document.querySelector('[data-step="team"]').hidden = state.personal;
  $("bar").style.width = `${Math.round(100 * done / total)}%`;
  $("progress").setAttribute("aria-valuemax", String(total));
  $("progress").setAttribute("aria-valuenow", String(done));
  $("progress-label").textContent = done === total ? `All set. Broppy is ready${state.personal ? "" : " for your team"}.` : `${done} of ${total} steps done`;
  for (const step of steps) {
    const item = document.querySelector(`[data-step="${step.id}"]`);
    const button = item.querySelector("button"), panel = item.querySelector(".panel");
    const open = state.open === step.id;
    button.setAttribute("aria-expanded", String(open)); panel.hidden = !open;
    item.dataset.status = step.status;
    const optional = (step.id === "team" || step.id === "ai") && step.status !== "done";
    item.querySelector(".chip").textContent = step.status === "done" ? (state.skipped.includes(step.id === "ai" ? "model" : step.id) ? "Skipped" : "Done")
      : step.id === "ready" ? (step.status === "current" ? "Finished" : "") : optional ? "Optional" : step.status === "current" ? "Next" : "";
    item.querySelector(".badge").textContent = step.status === "done" ? "✓" : String(step.number);
  }
}
for (const button of document.querySelectorAll(".step h2 button")) {
  button.onclick = () => { const id = button.closest(".step").dataset.step; state.open = state.open === id ? undefined : id; renderSteps(); };
}

// ---- step 1: connect ----
async function connect(source, button) {
  button.disabled = true; notice(undefined);
  try {
    const result = await request(`/v1/admin/connections/${source}/authorize`, "POST", { via: "setup" });
    if (result.url) { location.assign(result.url); return; }
    await refresh();
  } catch (error) { notice({ kind: "bad", text: `${toolName(source)}: ${error.message}` }); button.disabled = false; }
}
async function readAgain(source, button) {
  button.disabled = true; notice(undefined);
  try { await request(`/v1/admin/connections/${source}/import`, "POST", {}); await refresh(); }
  catch (error) { notice({ kind: "bad", text: `${toolName(source)}: ${error.message}` }); button.disabled = false; }
}
function renderTools() {
  $("tools").replaceChildren(...TOOLS.map(tool => {
    const connection = state.connections.find(item => item.source === tool.source);
    const status = toolState(connection, state.jobs.find(job => job.source === tool.source));
    const attention = status.state === "attention";
    const connected = status.state !== "not_connected" && !attention;
    const add = tool.source === "slack" ? "Add to Slack" : "Connect";
    const label = connected ? "Connect again" : attention ? (status.reconnect ? "Reconnect" : "Read again") : add;
    const button = h("button", { type: "button", class: connected ? "btn" : "btn primary" }, label);
    button.onclick = () => attention && !status.reconnect ? readAgain(tool.source, button) : connect(tool.source, button);
    return h("article", { class: `tool ${status.state}` },
      h("h3", {}, tool.name), h("p", { class: "muted" }, tool.reads),
      h("p", { class: "tool-status" }, connected ? "✓ Connected" : attention
        ? (status.reconnect ? "Broppy's access was turned off or expired" : "Connected · the last reading didn't finish")
        : status.label), button);
  }));
}

// ---- step 2: what to read ----
const panels = new Map();
function readPanel(source) {
  const mode = { all: "Everything it can see (recommended)", selected: "Only the parts I choose", none: "Nothing for now" };
  const radios = Object.entries(mode).map(([value, text]) => h("label", { class: "radio" }, h("input", { type: "radio", name: `mode-${source}`, value }), ` ${text}`));
  const picker = h("div", { class: "picker", hidden: true });
  const status = h("div", { class: "read-status", role: "status" });
  const save = h("button", { type: "submit", class: "btn primary" }, "Save and start reading");
  const form = h("form", { class: "form" }, h("fieldset", {}, h("legend", {}, `What should Broppy read from ${toolName(source)}?`), radios), picker, save);
  const root = h("article", { class: "read" }, h("h3", {}, toolName(source)), status, form);
  const chosen = () => radios.map(label => label.firstChild).find(input => input.checked)?.value;
  let loaded = false;
  const loadPicker = async scope => {
    if (loaded) return; loaded = true;
    picker.replaceChildren(h("p", { class: "muted" }, "Finding what's there…"));
    try {
      const { containers } = await request(`/v1/admin/connections/${source}/containers`);
      picker.replaceChildren(...(containers.length ? containers.map(item => h("label", { class: "check" },
        h("input", { type: "checkbox", value: item.id, checked: (scope.containers || []).includes(item.id) }), ` ${item.name}`)) : [h("p", { class: "muted" }, "Nothing to choose from yet.")]));
    } catch (error) { loaded = false; picker.replaceChildren(h("p", { class: "bad" }, error.message)); }
  };
  const sync = () => {
    picker.hidden = chosen() !== "selected"; if (chosen() === "selected") void loadPicker(panel.scope);
    save.textContent = chosen() === "none" ? "Save" : "Save and start reading";
  };
  for (const label of radios) label.firstChild.onchange = sync;
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true; notice(undefined);
    const containers = [...picker.querySelectorAll("input:checked")].map(input => input.value);
    if (chosen() === "selected" && !containers.length) { notice({ kind: "bad", text: `Choose at least one part of ${toolName(source)}, or pick another option.` }); save.disabled = false; return; }
    try {
      await request(`/v1/admin/connections/${source}/scope`, "PUT", { mode: chosen(), ...(chosen() === "selected" ? { containers } : {}) });
      await refresh();
    } catch (error) { notice({ kind: "bad", text: `${toolName(source)}: ${error.message}` }); }
    save.disabled = false;
  };
  const panel = { root, scope: {},
    update(connection, job) {
      panel.scope = connection.scope || {};
      const info = toolState(connection, job);
      // Leave the admin's choices alone while they are working in the form.
      if (!form.contains(document.activeElement) && !radios.some(label => label.firstChild.checked)) {
        // A tool just connected starts at "nothing"; suggest the recommended choice rather than the one that reads nothing.
        const initial = panel.scope.mode && !(panel.scope.mode === "none" && !(connection.count > 0)) ? panel.scope.mode : "all";
        for (const label of radios) label.firstChild.checked = label.firstChild.value === initial;
        sync();
      }
      status.className = `read-status ${info.state}`;
      status.replaceChildren(info.state === "reading" ? h("div", {}, h("div", { class: "progress small", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(info.percent) }, h("span", { style: `width:${info.percent}%` })),
          h("p", { class: "muted" }, info.found ? `Reading… ${info.done} of ${info.found} items` : "Getting started…"))
        : info.state === "ready" ? h("p", {}, `✓ ${info.items} item${info.items === 1 ? "" : "s"} ready to ask about${info.failed ? `. ${info.failed} couldn't be read.` : ""}`)
        : info.state === "attention" ? h("p", { class: "bad" }, `Needs attention${info.detail ? `: ${info.detail}` : ""}`)
        : h("p", { class: "muted" }, "Not read yet. Choose an option and press Save."));
      for (const control of form.querySelectorAll("input, button")) control.disabled = info.state === "reading";
    } };
  return panel;
}
function renderReads() {
  const connected = state.connections.filter(connection => connection.status !== "Not connected");
  $("reads-empty").hidden = connected.length > 0;
  for (const connection of connected) {
    if (!panels.has(connection.source)) panels.set(connection.source, readPanel(connection.source));
    panels.get(connection.source).update(connection, state.jobs.find(job => job.source === connection.source));
  }
  const order = TOOLS.map(tool => tool.source).filter(source => connected.some(connection => connection.source === source));
  $("reads").replaceChildren(...order.map(source => panels.get(source).root));
}

// ---- step 3: team ----
function renderPeople() {
  $("team-form").hidden = !state.peopleAvailable;
  if (!state.peopleAvailable) $("team-results").replaceChildren(h("li", { class: "bad" }, "Adding people isn't available in this workspace yet. Tell whoever runs Broppy for your company."));
  const people = state.people.filter(person => person.status !== "removed");
  $("people-title").hidden = !people.length;
  $("people").replaceChildren(...people.map(person => h("li", {}, h("span", {}, person.name || person.email), h("span", { class: "muted" }, ` ${person.email}`),
    h("span", { class: `pill ${person.status}` }, person.status === "active" ? "Signed in" : "Invited"))));
}
$("team-form").onsubmit = async event => {
  event.preventDefault();
  const { valid, invalid } = parseEmails($("emails").value);
  const results = $("team-results"); results.replaceChildren();
  if (invalid.length) results.append(h("li", { class: "bad" }, `These don't look like email addresses: ${invalid.join(", ")}`));
  if (!valid.length) { if (!invalid.length) results.append(h("li", { class: "bad" }, "Type at least one work email.")); return; }
  $("team-submit").disabled = true;
  const failed = [];
  for (const email of valid) {
    const line = h("li", {}, `${email}: adding…`); results.append(line);
    try {
      const result = await request("/v1/admin/people", "POST", { email, role: $("role").value });
      line.textContent = addedMessage(email, result);
      try {
        const { checks } = await request(`/v1/admin/people/${result.person.id}/check`, "POST");
        const problems = checkLines(checks);
        if (problems.length) line.append(h("span", { class: "bad" }, ` Heads up: ${problems.join("; ")}. They won't see anything from ${problems.length === 1 ? "that tool" : "those tools"} until it's fixed in People and access.`));
      } catch { /* The invitation went out; the check is a bonus. */ }
    } catch (error) { line.textContent = `${email}: ${error.message}`; line.className = "bad"; failed.push(email); }
  }
  $("emails").value = [...failed, ...invalid].join("\n");
  $("team-submit").disabled = false;
  await refresh();
};
$("team-skip").onclick = () => { skip("team"); state.open = undefined; renderSteps(); };

// ---- step 4: AI ----
const aiModelChoice = $("ai-model-choice");
aiModelChoice.replaceChildren(...ANTHROPIC_MODELS.map(model => h("option", { value: model.id }, model.label)));
function syncProvider() {
  const provider = $("ai-provider").value;
  aiModelChoice.hidden = provider !== "anthropic"; $("ai-model").hidden = provider === "anthropic";
  $("ai-url-field").hidden = provider !== "openai_compatible";
  $("ai-model-label").setAttribute("for", provider === "anthropic" ? "ai-model-choice" : "ai-model");
}
$("ai-provider").onchange = syncProvider; syncProvider();
$("ai-own").onclick = () => { const open = $("ai-form").hidden; $("ai-form").hidden = !open; $("ai-own").setAttribute("aria-expanded", String(open)); };
$("ai-default").onclick = async () => {
  try { if (state.model) await request("/v1/admin/model", "DELETE"); skip("model"); state.model = undefined; $("ai-form").hidden = true; state.open = undefined; await refresh(); }
  catch (error) { notice({ kind: "bad", text: error.message }); }
};
$("ai-form").onsubmit = async event => {
  event.preventDefault();
  const provider = $("ai-provider").value;
  const model = provider === "anthropic" ? aiModelChoice.value : $("ai-model").value.trim();
  if (!model) { $("ai-status").textContent = "Enter the model name from your AI account."; return; }
  $("ai-submit").disabled = true; $("ai-status").textContent = "Testing the connection…";
  try {
    await request("/v1/admin/model", "PUT", { provider, model, ...(provider === "openai_compatible" ? { baseUrl: $("ai-url").value.trim() } : {}), apiKey: $("ai-key").value });
    $("ai-key").value = ""; $("ai-form").hidden = true; await refresh();
  } catch (error) { $("ai-status").textContent = /refused|reached/i.test(error.message) ? error.message : `That didn't work: ${error.message}`; }
  $("ai-submit").disabled = false;
};
function renderAi() {
  if (state.model) $("ai-status").textContent = `Connected: Broppy answers with ${state.model.model}.`;
  else $("ai-status").textContent = state.skipped.includes("model") ? "Using Broppy's built-in assistant." : "";
}

// ---- step 5: ready ----
function renderReady() {
  const connected = state.connections.filter(connection => connection.status !== "Not connected");
  const items = connected.reduce((sum, connection) => sum + (connection.count || 0), 0);
  const team = state.people.filter(person => person.status !== "removed").length;
  $("summary").replaceChildren(
    h("li", {}, `${connected.length} tool${connected.length === 1 ? "" : "s"} connected: ${connected.map(connection => toolName(connection.source)).join(", ") || "none yet"}`),
    h("li", {}, `${items} item${items === 1 ? "" : "s"} ready to ask about`),
    ...(state.personal ? [] : [h("li", {}, team > 1 ? `${team} people on your team` : "Just you so far. Add your team any time from People and access.")]),
    h("li", {}, state.model ? `Answers written by ${state.model.model}` : "Answers written by Broppy's built-in assistant"));
  $("questions").replaceChildren(...FIRST_QUESTIONS.map(question => h("a", { class: "question", href: `./index.html?${new URLSearchParams({ ask: question })}` }, question)));
}

// ---- loading ----
function renderAll() { renderTools(); renderReads(); renderPeople(); renderAi(); renderReady(); renderSteps(); }
async function refresh() {
  const [connections, jobs, people, model] = await Promise.all([
    request("/v1/admin/connections"), request("/v1/admin/import-jobs"),
    request("/v1/admin/people").catch(() => undefined), request("/v1/admin/model").catch(() => undefined)]);
  state.connections = connections.connections; state.jobs = jobs.jobs;
  state.peopleAvailable = Boolean(people); state.people = people?.people ?? []; state.model = model?.source === "organization" ? model.model : undefined;
  renderAll();
  clearTimeout(state.timer);
  // Keep watching while something is being read. A check that fails (a slow start, a dropped connection) is tried
  // again rather than ending the watch, or the page would freeze on old progress while the reading carries on.
  if (state.jobs.some(job => job.status === "running") || state.connections.some(connection => connection.status === "Importing")) state.timer = setTimeout(watch, 3000);
}
function watch() {
  refresh().catch(() => { clearTimeout(state.timer); state.timer = setTimeout(watch, 5000); });
}
async function start() {
  try {
    const me = await request("/v1/me");
    // Someone who has just accepted an invitation lands here; only the company's first admin has setup to do.
    if (me.role !== "admin") {
      if (new URLSearchParams(location.search).has("welcome")) { location.replace("./index.html"); return; }
      $("gate").hidden = false; return;
    }
    const message = returnMessage(new URLSearchParams(location.search));
    if (message) { notice(message); history.replaceState(null, "", location.pathname + (persona ? `?user=${encodeURIComponent(persona)}` : "")); }
    $("setup").hidden = false;
    // Known before the first render, so a personal workspace never flashes a team step.
    const company = await request("/v1/admin/company").catch(() => undefined);
    state.personal = company?.personal === true;
    if (company?.address) { $("address-value").textContent = company.address; $("address").hidden = false; }
    await refresh();
    // Coming back from another tab or a tool's approval page shows where things are now.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) watch(); });
  } catch (error) {
    $("gate").hidden = false; $("gate-title").textContent = "We couldn't open setup";
    $("gate-text").textContent = error.message;
  }
}
void start();
