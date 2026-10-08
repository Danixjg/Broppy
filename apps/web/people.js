const api = "/api/brain";
const status = document.getElementById("status");
const labels = { invited: "Invited, hasn't signed in yet", active: "Signed in", removed: "Removed" };
let me = null;
async function request(path, method = "GET", data) {
  const response = await fetch(api + path, { method, headers: { "content-type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  let result;
  try { result = await response.json(); } catch { throw new Error("Request failed"); }
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
// What happened on the Auth0 side of a change, in words an admin can act on.
function auth0Note(result, verb) {
  if (result.auth0 === "invited") return "invitation emailed";
  if (result.auth0 === "restored") return "access restored in Auth0";
  if (result.auth0 === "withdrawn") return "access withdrawn in Auth0";
  if (result.auth0 === "not_configured") return verb === "added" ? "added to Broppy, but Auth0 invitations aren't set up, so add them to your Auth0 organization yourself" : "removed from Broppy; also remove them from your Auth0 organization";
  return `saved in Broppy, but Auth0 said: ${result.auth0Error || "it could not be reached"}`;
}
const SOURCES = [["slack", "Slack"], ["jira", "Jira"], ["confluence", "Confluence"], ["drive", "Drive"]];
const checkLabels = { found: "found", not_found: "not found there", not_connected: "source not connected yet", unavailable: "couldn't be checked", not_checked: "no lookup, shares are matched by email", no_identity: "no account set" };
// What each source said about the person's account, one line.
function checkNote(checks) { return SOURCES.map(([key, name]) => `${name}: ${checkLabels[checks[key]] || checks[key]}`).join("; "); }
async function check(person, shown) {
  try { const { checks } = await request(`/v1/admin/people/${person.id}/check`, "POST"); shown.textContent = checkNote(checks); }
  catch (error) { shown.textContent = error.message; }
}
// A row of fields under the person, one per source, for accounts that don't use the work email.
function editAccounts(person, cell) {
  if (cell.firstChild) { cell.replaceChildren(); return; }
  const form = document.createElement("form"); const inputs = {};
  for (const [key, name] of SOURCES) {
    const label = document.createElement("label"); label.append(`${name} `);
    const input = document.createElement("input"); input.type = "email"; input.maxLength = 254; input.value = person.identities[key] || ""; input.placeholder = person.email; input.setAttribute("autocomplete", "off");
    inputs[key] = input; label.append(input); form.append(label, " ");
  }
  const save = element("button", "Save accounts"); save.type = "submit"; form.append(save);
  form.onsubmit = async event => {
    event.preventDefault(); status.textContent = "Saving and reading their access…";
    const identities = {}; for (const [key] of SOURCES) if (inputs[key].value.trim() !== (person.identities[key] || "")) identities[key] = inputs[key].value;
    if (!Object.keys(identities).length) { status.textContent = "Nothing changed."; return; }
    try {
      const { access } = await request(`/v1/admin/people/${person.id}/identities`, "POST", { identities });
      status.textContent = `${person.email}: accounts saved; ${access.added} item${access.added === 1 ? "" : "s"} added to what they can see${access.remaining ? `, ${access.remaining} left for the next pass` : ""}.`; await load();
    } catch (error) { status.textContent = error.message; }
  };
  cell.append(form);
}
async function act(person, method, suffix, verb) {
  status.textContent = "Working…";
  try { const result = await request(`/v1/admin/people/${person.id}${suffix}`, method); status.textContent = `${person.email}: ${auth0Note(result, verb)}.`; await load(); }
  catch (error) { status.textContent = error.message; }
}
async function load() {
  try {
    me = me || await request("/v1/me");
    const { people } = await request("/v1/admin/people");
    const rows = document.getElementById("people");
    rows.replaceChildren();
    for (const person of people) {
      const row = document.createElement("tr");
      const actions = document.createElement("td");
      if (person.status === "invited") {
        const resend = element("button", "Resend invitation"); resend.type = "button";
        resend.onclick = () => act(person, "POST", "/invite", "invited"); actions.append(resend);
      }
      if (person.status !== "removed" && person.id !== me.id) {
        const remove = element("button", "Remove access"); remove.type = "button";
        remove.onclick = () => { if (confirm(`Remove ${person.email}? They lose access to Broppy immediately.`)) act(person, "DELETE", "", "removed"); };
        actions.append(remove);
      }
      if (person.status !== "removed") {
        const detail = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5;
        const shown = document.createElement("span"); shown.setAttribute("role", "status");
        const accounts = element("button", "Source accounts"); accounts.type = "button"; accounts.onclick = () => editAccounts(person, form);
        const test = element("button", "Check"); test.type = "button"; test.onclick = () => { shown.textContent = "Checking…"; void check(person, shown); };
        const form = document.createElement("div");
        actions.append(accounts, test); cell.append(shown, form); detail.append(cell);
        row.append(element("td", person.name), element("td", person.email), element("td", person.role), element("td", labels[person.status]), actions);
        rows.append(row, detail); continue;
      }
      row.append(element("td", person.name), element("td", person.email), element("td", person.role), element("td", labels[person.status]), actions);
      rows.append(row);
    }
  } catch (error) { status.textContent = error.message; }
}
document.getElementById("add-form").addEventListener("submit", async event => {
  event.preventDefault();
  const emails = [...new Set(document.getElementById("emails").value.split(/[\s,;]+/).filter(Boolean))];
  const groups = document.getElementById("groups").value.split(",").map(group => group.trim()).filter(Boolean);
  const results = document.getElementById("results");
  results.replaceChildren();
  const failed = [];
  for (const email of emails) {
    try {
      const result = await request("/v1/admin/people", "POST", { email, role: document.getElementById("role").value, groups });
      const line = element("li", `${email}: ${auth0Note(result, "added")}. `); results.append(line);
      // Tell the admin now if a source doesn't know this email, instead of leaving them to find an empty workspace.
      const shown = document.createElement("span"); line.append(shown); await check(result.person, shown);
    } catch (error) { results.append(element("li", `${email}: ${error.message}`)); failed.push(email); }
  }
  // Keep only the emails that need another try.
  document.getElementById("emails").value = failed.join("\n");
  status.textContent = "";
  await load();
});
document.getElementById("refresh-access").addEventListener("click", async () => {
  status.textContent = "Reading permissions at the sources… this can take a minute.";
  const total = { checked: 0, failed: 0, filled: 0 };
  try {
    // One call reads for a limited time and says where it stopped; carry on until every item has been read.
    for (let from = 0; ;) {
      const result = await request("/v1/admin/access/refresh", "POST", { from });
      total.checked += result.checked; total.failed += result.failed; total.filled += result.identitiesFilled;
      if (!result.remaining || typeof result.next !== "number") break;
      from = result.next; status.textContent = `Reading permissions at the sources… ${result.remaining} items to go.`;
    }
    status.textContent = `Checked ${total.checked} item${total.checked === 1 ? "" : "s"}${total.failed ? `, ${total.failed} couldn't be read` : ""}${total.filled ? `. Filled in source accounts for ${total.filled} ${total.filled === 1 ? "person" : "people"}` : ""}.`;
    await load();
  } catch (error) { status.textContent = error.message; }
});
void load();
