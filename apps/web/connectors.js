const api = "/api/brain";
const status = document.getElementById("status");
// In demo mode the workspace links here with the persona it was viewing as; the host ignores it for signed-in users.
const persona = new URLSearchParams(location.search).get("user");
async function request(path, method = "GET", data) {
  const response = await fetch(api + path, { method, headers: { "content-type": "application/json", ...(persona ? { "x-demo-user": persona } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
async function action(source, verb, method = "POST", data) {
  try { const result = await request(`/v1/admin/connections/${source}${verb ? `/${verb}` : ""}`, method, data); if (result.url) { location.assign(result.url); return; } await load(); }
  catch (error) { status.textContent = error.message; }
}
function scopeControls(connection) {
  const form = document.createElement("div");
  const scope = connection.scope || {};
  const mode = scope.mode || (scope.containers?.length || scope.ids?.length ? "selected" : "all");
  const choices = [["all", "Include everything"], ["selected", "Include only what I select"], ["none", "Include nothing"]];
  const radios = choices.map(([value, text]) => {
    const label = document.createElement("label"); const input = document.createElement("input");
    input.type = "radio"; input.name = `mode-${connection.source}`; input.value = value; input.checked = value === mode;
    label.append(input, ` ${text}`); form.append(label, document.createElement("br")); return input;
  });
  const picker = document.createElement("div"); picker.hidden = mode !== "selected";
  const boxes = [];
  const loadPicker = async () => {
    try {
      const { containers } = await request(`/v1/admin/connections/${connection.source}/containers`);
      picker.replaceChildren();
      for (const item of containers) {
        const label = document.createElement("label"); const box = document.createElement("input");
        box.type = "checkbox"; box.value = item.id; box.checked = (scope.containers || []).includes(item.id);
        label.append(box, ` ${item.name}`); picker.append(label, document.createElement("br")); boxes.push(box);
      }
      if (!containers.length) picker.append(element("p", "Nothing to select yet."));
    } catch (error) { picker.append(element("p", error.message)); }
  };
  const futureLabel = document.createElement("label"); const future = document.createElement("input");
  future.type = "checkbox"; future.checked = Boolean(scope.futureOnly);
  futureLabel.append(future, " Only content that is new or changed from now on");
  const sinceLabel = element("label", "Or history since "); const since = document.createElement("input");
  since.type = "date"; since.value = scope.futureOnly ? "" : (scope.since || "").slice(0, 10); sinceLabel.append(since);
  const selected = () => radios.find(radio => radio.checked)?.value;
  const refresh = () => { picker.hidden = selected() !== "selected"; futureLabel.hidden = sinceLabel.hidden = selected() === "none"; };
  for (const radio of radios) radio.onchange = () => { refresh(); if (selected() === "selected" && !boxes.length) void loadPicker(); };
  future.onchange = () => { since.disabled = future.checked; };
  since.disabled = future.checked;
  if (mode === "selected") void loadPicker();
  refresh();
  const save = element("button", "Save and import");
  save.onclick = () => action(connection.source, "scope", "PUT", { mode: selected(),
    ...(selected() === "selected" ? { containers: boxes.filter(box => box.checked).map(box => box.value) } : {}),
    ...(selected() !== "none" && future.checked ? { futureOnly: true } : selected() !== "none" && since.value ? { since: new Date(since.value).toISOString() } : {}) });
  form.append(picker, futureLabel, document.createElement("br"), sinceLabel, document.createElement("br"), save);
  return form;
}
async function load() {
  const [result, progress] = await Promise.all([request("/v1/admin/connections"), request("/v1/admin/import-jobs")]);
  const container = document.getElementById("connections");
  // Avoid replacing an admin's scope edits while polling progress.
  if (!container.contains(document.activeElement)) {
    container.replaceChildren();
    for (const connection of result.connections) {
      const section = document.createElement("section");
      const job = progress.jobs.find(job => job.source === connection.source);
      const percent = job?.found ? Math.floor(100 * (job.indexed + job.skipped) / job.found) : 0;
      section.append(element("h2", connection.source), element("p", `${connection.status}${job?.status === "running" ? ` ${percent}%` : ""} · ${connection.count} items · Last sync: ${connection.lastSync || "Never"}`));
      if (job) section.append(element("p", `Found ${job.found}, indexed ${job.indexed}, skipped ${job.skipped}, failed ${job.failed}${job.error ? `: ${job.error}` : ""}`));
      section.append(scopeControls(connection));
      for (const [name, handler] of [["Connect", () => action(connection.source, "authorize")],
        ["Re-sync", () => action(connection.source, "import")], ["Disconnect", () => action(connection.source, "", "DELETE")]]) {
        const button = element("button", name); button.onclick = handler; section.append(button);
      }
      container.append(section);
    }
  }
  document.getElementById("onboard").hidden = result.liveMode;
  const unmatched = document.getElementById("unmatched"); unmatched.replaceChildren();
  for (const person of result.unmatched) unmatched.append(element("li", `${person.user}: ${person.source}`));
  if (!result.unmatched.length) unmatched.append(element("li", "All directory users have source identities."));
}
document.getElementById("onboard").onclick = async () => { try { await request("/v1/admin/onboard", "POST"); await load(); } catch (error) { status.textContent = error.message; } };
try { await load(); setInterval(() => load().catch(error => { status.textContent = error.message; }), 3000); }
catch (error) { status.textContent = error.message; }
