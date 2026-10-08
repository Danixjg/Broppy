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
      results.append(element("li", `${email}: ${auth0Note(result, "added")}.`));
    } catch (error) { results.append(element("li", `${email}: ${error.message}`)); failed.push(email); }
  }
  // Keep only the emails that need another try.
  document.getElementById("emails").value = failed.join("\n");
  status.textContent = "";
  await load();
});
void load();
