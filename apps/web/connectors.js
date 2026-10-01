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
      const label = element("label", "Scope: native item IDs, separated by commas (empty means all available)");
      const ids = document.createElement("input"); ids.value = (connection.scope.ids || []).join(","); label.append(ids);
      const sinceLabel = element("label", "History since"); const since = document.createElement("input"); since.type = "date"; since.value = (connection.scope.since || "").slice(0,10); sinceLabel.append(since);
      const containerLabel = element("label", "Channels / project keys / space IDs / shared drive IDs"); const containers = document.createElement("input"); containers.value = (connection.scope.containers || []).join(","); containerLabel.append(containers);
      section.append(containerLabel, label, sinceLabel);
      for (const [name, handler] of [["Connect", () => action(connection.source, "authorize")],
        ["Save scope", () => action(connection.source, "scope", "PUT", { containers: containers.value.split(",").map(s => s.trim()).filter(Boolean), ids: ids.value.split(",").map(s => s.trim()).filter(Boolean), ...(since.value ? { since: new Date(since.value).toISOString() } : {}) })],
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
