import { TOOLS, plainError, returnMessage, toolName, toolState } from "./setup-state.js";

const api = "/api/brain";
const $ = id => document.getElementById(id);
// In demo mode the workspace links here with the persona it was viewing as; the host ignores it for signed-in users.
const persona = new URLSearchParams(location.search).get("user");

async function request(path, method = "GET", data) {
  let response;
  try {
    response = await fetch(api + path, { method, headers: { "content-type": "application/json", ...(persona ? { "x-demo-user": persona } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  } catch (error) { throw new Error(plainError(error.message)); }
  let result = {};
  // A busy or starting server can answer with a page instead of JSON; the status below says enough.
  try { result = await response.json(); } catch { /* not JSON */ }
  if (response.status === 401 && result.code === "signed_out") { location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname })}`); return new Promise(() => undefined); }
  if (!response.ok) throw new Error(plainError(result.error || (response.status >= 500 ? "Broppy is busy or starting up. Try again in a moment." : "Request failed")));
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
  const box = $("status");
  box.hidden = !message; box.textContent = message?.text ?? ""; box.className = `notice ${message?.kind ?? ""}`;
}
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

// Coming back from a tool's approval page: say how it went, then tidy the address so a reload doesn't repeat it.
const returned = returnMessage(new URLSearchParams(location.search));
if (returned) { notice(returned); history.replaceState(null, "", location.pathname + (persona ? `?user=${encodeURIComponent(persona)}` : "")); }

/** Runs a button's action once at a time, and says what went wrong in place of failing silently. */
async function run(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } catch (error) { notice({ kind: "bad", text: error.message }); } finally { button.disabled = false; }
}
async function connect(source) {
  const result = await request(`/v1/admin/connections/${source}/authorize`, "POST", {});
  if (result.url) { location.assign(result.url); return new Promise(() => undefined); }
  await load();
}

// ---- tools ----
const open = new Set(); // tools whose "what Broppy reads" form is open: never redrawn under the admin
function scopeForm(connection) {
  const scope = connection.scope || {};
  const mode = scope.mode && !(scope.mode === "none" && !(connection.count > 0)) ? scope.mode : "all";
  const labels = { all: "Everything it can see (recommended)", selected: "Only the parts I choose", none: "Nothing for now" };
  const radios = Object.entries(labels).map(([value, text]) => h("label", { class: "radio" }, h("input", { type: "radio", name: `mode-${connection.source}`, value, ...(value === mode ? { checked: true } : {}) }), ` ${text}`));
  const picker = h("div", { class: "picker", hidden: mode !== "selected" });
  let loaded = false;
  const loadPicker = async () => {
    if (loaded) return; loaded = true;
    picker.replaceChildren(h("p", { class: "muted" }, "Finding what's there…"));
    try {
      const { containers } = await request(`/v1/admin/connections/${connection.source}/containers`);
      picker.replaceChildren(...(containers.length ? containers.map(item => h("label", { class: "check" },
        h("input", { type: "checkbox", value: item.id, ...((scope.containers || []).includes(item.id) ? { checked: true } : {}) }), ` ${item.name}`)) : [h("p", { class: "muted" }, "Nothing to choose from yet.")]));
    } catch (error) { loaded = false; picker.replaceChildren(h("p", { class: "bad" }, error.message)); }
  };
  const future = h("input", { type: "checkbox", ...(scope.futureOnly ? { checked: true } : {}) });
  const since = h("input", { type: "date", value: scope.futureOnly ? "" : (scope.since || "").slice(0, 10) });
  const history = h("div", { class: "form" }, h("label", { class: "check" }, future, " Only what is new or changed from now on"), h("label", {}, "Or start from ", since));
  const chosen = () => radios.map(label => label.firstChild).find(input => input.checked)?.value;
  const save = h("button", { type: "submit", class: "btn primary" }, "Save and start reading");
  const sync = () => {
    picker.hidden = chosen() !== "selected"; history.hidden = chosen() === "none"; since.disabled = future.checked;
    save.textContent = chosen() === "none" ? "Save" : "Save and start reading";
    if (chosen() === "selected") void loadPicker();
  };
  for (const label of radios) label.firstChild.onchange = sync;
  future.onchange = sync;
  if (mode === "selected") void loadPicker();
  const form = h("form", { class: "form" }, h("fieldset", {}, h("legend", {}, `What should Broppy read from ${toolName(connection.source)}?`), radios), picker, history, save);
  form.onsubmit = event => {
    event.preventDefault();
    void run(save, async () => {
      const containers = [...picker.querySelectorAll("input:checked")].map(input => input.value);
      if (chosen() === "selected" && !containers.length) throw new Error(`Choose at least one part of ${toolName(connection.source)}, or pick another option.`);
      await request(`/v1/admin/connections/${connection.source}/scope`, "PUT", { mode: chosen(),
        ...(chosen() === "selected" ? { containers } : {}),
        ...(chosen() !== "none" && future.checked ? { futureOnly: true } : chosen() !== "none" && since.value ? { since: new Date(since.value).toISOString() } : {}) });
      notice({ kind: "good", text: chosen() === "none" ? `${toolName(connection.source)} reads nothing for now.` : `Saved. Broppy is reading ${toolName(connection.source)}.` });
      open.delete(connection.source);
      await load();
    });
  };
  sync();
  return form;
}
function toolCard(tool, connection, job) {
  const status = toolState(connection, job);
  const card = h("article", { class: `tool ${status.state}` }, h("h3", {}, tool.name), h("p", { class: "muted" }, tool.reads));
  const line = status.state === "not_connected" ? "Not connected"
    : status.state === "reading" ? (status.found ? `Reading… ${status.done} of ${status.found} items` : "Getting started…")
    : status.state === "attention" ? (status.reconnect ? "Broppy's access was turned off or expired" : "The last reading didn't finish")
    : status.state === "connected" ? "Connected · reading nothing yet"
    : `✓ ${status.items} item${status.items === 1 ? "" : "s"} ready to ask about`;
  const lineNode = h("p", { class: "tool-status" }, line);
  if (status.detail) lineNode.title = status.detail;
  card.append(lineNode);
  if (connection?.lastSync) card.append(h("p", { class: "muted", title: new Date(connection.lastSync).toLocaleString() }, `Last synced ${timeAgo(connection.lastSync)}`));
  const actions = h("div", { class: "row" });
  if (status.state === "not_connected" || status.reconnect) {
    const label = status.reconnect ? "Reconnect" : tool.source === "slack" ? "Add to Slack" : "Connect";
    const button = h("button", { type: "button", class: "btn primary" }, label);
    button.onclick = () => run(button, () => connect(tool.source));
    actions.append(button);
  } else {
    if (status.state !== "reading") {
      const again = h("button", { type: "button", class: status.state === "attention" ? "btn primary" : "btn" }, status.state === "attention" ? "Read again" : "Sync now");
      again.onclick = () => run(again, async () => { await request(`/v1/admin/connections/${tool.source}/import`, "POST", {}); notice({ kind: "good", text: `Reading ${tool.name} now.` }); await load(); });
      actions.append(again);
    }
    const disconnect = h("button", { type: "button", class: "btn danger" }, "Disconnect");
    disconnect.onclick = () => {
      if (!confirm(`Disconnect ${tool.name}? Broppy forgets everything it read from ${tool.name}, and nobody can ask about it until you connect it again.`)) return;
      void run(disconnect, async () => { await request(`/v1/admin/connections/${tool.source}`, "DELETE"); notice({ kind: "good", text: `${tool.name} is disconnected.` }); await load(); });
    };
    actions.append(disconnect);
  }
  card.append(actions);
  if (connection && status.state !== "not_connected" && !status.reconnect) {
    const details = h("details", { ...(open.has(tool.source) ? { open: true } : {}) }, h("summary", {}, "Change what Broppy reads"), scopeForm(connection));
    details.ontoggle = () => { if (details.open) open.add(tool.source); else open.delete(tool.source); };
    card.append(details);
  }
  return card;
}

// ---- Slack bot ----
function botCard(installation) {
  const label = $("slack-bot-status");
  const actions = $("slack-bot-actions"); actions.replaceChildren();
  if (installation.state === "not_installed" && !installation.configured) {
    label.textContent = "Adding Broppy to Slack isn't switched on for this workspace yet."; return;
  }
  label.textContent = installation.state === "active" ? `✓ Added to ${installation.teamName}.`
    : installation.state === "not_installed" ? "Not added to Slack yet."
    : `${installation.teamName} is ${installation.state === "uninstalled" ? "uninstalled from Slack" : "disconnected from Broppy"}.`;
  const add = h("button", { type: "button", class: installation.state === "active" ? "btn" : "btn primary" }, installation.state === "active" ? "Add to Slack again" : "Add to Slack");
  add.onclick = () => run(add, async () => { const result = await request("/v1/admin/slack-installation/authorize", "POST", {}); if (result.url) { location.assign(result.url); return new Promise(() => undefined); } });
  actions.append(add);
  if (installation.state === "active") {
    const refresh = h("button", { type: "button", class: "btn" }, "Refresh settings in Slack");
    refresh.onclick = () => run(refresh, async () => { await request("/v1/admin/slack-installation/refresh", "POST", { generation: installation.generation }); notice({ kind: "good", text: "Slack has Broppy's latest settings." }); await load(); });
    const disconnect = h("button", { type: "button", class: "btn danger" }, "Disconnect the bot");
    disconnect.onclick = () => {
      if (!confirm(`Disconnect Broppy from ${installation.teamName}? The bot stops answering there. To remove it from Slack completely, also uninstall it in Slack's app settings.`)) return;
      void run(disconnect, async () => { await request("/v1/admin/slack-installation", "DELETE", { generation: installation.generation }); await load(); });
    };
    actions.append(refresh, disconnect);
  }
}

// ---- AI model ----
const modelProvider = $("model-provider");
const syncModelForm = () => { $("model-url-label").hidden = modelProvider.value !== "openai_compatible"; };
modelProvider.onchange = syncModelForm;
const modelLabels = { organization: "Your company's model writes the answers.", operator: "Broppy's own model writes the answers. You can choose your own below.", "built-in": "No AI model is set. Broppy answers with short quotes from your tools." };
async function loadModel() {
  try {
    const { model, source } = await request("/v1/admin/model");
    $("model-status").textContent = model ? `${modelLabels[source]} Using ${model.model}.` : modelLabels[source];
    if (model && !$("model-form").contains(document.activeElement)) {
      modelProvider.value = model.provider; $("model-name").value = model.model; $("model-url").value = model.baseUrl || ""; syncModelForm();
    }
    $("model-remove").hidden = !model;
  } catch (error) { $("model-status").textContent = error.message; }
}
$("model-form").onsubmit = event => {
  event.preventDefault();
  const button = $("model-form").querySelector("button[type=submit]");
  void run(button, async () => {
    const key = $("model-key");
    $("model-status").textContent = "Testing the connection…";
    try {
      await request("/v1/admin/model", "PUT", { provider: modelProvider.value, model: $("model-name").value,
        ...(modelProvider.value === "openai_compatible" || $("model-url").value ? { baseUrl: $("model-url").value } : {}),
        ...(key.value ? { apiKey: key.value } : {}) });
    } finally { await loadModel(); }
    key.value = ""; notice({ kind: "good", text: "Saved. Your model answered the test." });
  });
};
$("model-remove").onclick = () => {
  if (!confirm("Remove your company's AI model? Broppy goes back to its own default.")) return;
  void run($("model-remove"), async () => { await request("/v1/admin/model", "DELETE"); await loadModel(); });
};

// ---- loading ----
let timer, failing = false;
async function load() {
  clearTimeout(timer);
  try {
    const [result, progress, installation] = await Promise.all([request("/v1/admin/connections"), request("/v1/admin/import-jobs"), request("/v1/admin/slack-installation").catch(() => ({ state: "not_installed", configured: false }))]);
    if (failing) { failing = false; notice(undefined); }
    botCard(installation);
    const cards = TOOLS.map(tool => {
      if (open.has(tool.source)) return document.querySelector(`[data-tool="${tool.source}"]`) ?? undefined;
      const card = toolCard(tool, result.connections.find(item => item.source === tool.source), progress.jobs.find(job => job.source === tool.source));
      card.dataset.tool = tool.source; return card;
    }).filter(Boolean);
    $("connections").replaceChildren(...cards);
    $("onboard").hidden = result.liveMode !== false;
    const missing = new Set((result.unmatched || []).map(item => item.user));
    $("unmatched").hidden = !missing.size;
    $("unmatched").textContent = missing.size ? `${missing.size} ${missing.size === 1 ? "person hasn't" : "people haven't"} been matched to their accounts in every tool yet, so they won't see that tool's content in Broppy. They're matched by email when they sign in.` : "";
    // Keep the page current: quickly while something is being read, slowly otherwise.
    const reading = progress.jobs.some(job => job.status === "running") || result.connections.some(item => item.status === "Importing");
    timer = setTimeout(load, reading ? 3000 : 30000);
  } catch (error) {
    failing = true; notice({ kind: "bad", text: `${error.message} Trying again…` });
    timer = setTimeout(load, 5000);
  }
}
$("onboard").onclick = () => run($("onboard"), async () => { await request("/v1/admin/onboard", "POST"); await load(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void load(); });
void loadModel();
void load();
