const api = "/api/brain";
const status = document.getElementById("status");
const persona = new URLSearchParams(location.search).get("user");
const names = { slack: "Slack", jira: "Jira", confluence: "Confluence", drive: "Google Drive" };
async function request(path, method = "GET") {
  const response = await fetch(api + path, { method, headers: { "content-type": "application/json", ...(persona ? { "x-demo-user": persona } : {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
async function act(source, method, verb = "") {
  try {
    const result = await request(`/v1/me/connections/${source}${verb}`, method);
    if (result.url) { location.assign(result.url); return; }
    await load();
  } catch (error) { status.textContent = error.message; }
}
async function load() {
  try {
    const { available, connections } = await request("/v1/me/connections");
    const container = document.getElementById("accounts");
    container.replaceChildren();
    if (!available) status.textContent = "Account connections are not enabled for this workspace.";
    for (const connection of connections) {
      const section = document.createElement("section");
      section.append(element("h2", names[connection.source]),
        element("p", connection.connected ? "Connected" : connection.configured ? "Not connected" : "Not available"));
      if (connection.configured) {
        const button = element("button", connection.connected ? "Disconnect" : "Connect");
        button.onclick = () => connection.connected ? act(connection.source, "DELETE") : act(connection.source, "POST", "/authorize");
        section.append(button);
      }
      container.append(section);
    }
  } catch (error) { status.textContent = error.message; }
}
void load();
