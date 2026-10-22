import { demoRole, setCurrentIdentity } from "./src/lib/identity";
import { IDENTITY_CHANGED, TASKS_CHANGED, WORKSPACE_DATA, WORKSPACE_RELOAD } from "./src/tasks/events";

// The controller keeps what React has not taken over: sign-in, the identity, the view switch, and the seams
// the React surfaces listen to. The workspace, tasks, admin, compliance and sync health surfaces are React's
// now, and they read the identity from the module that holds it.
const API = "/api/brain";
const $ = id => document.getElementById(id);
const state = { view: "workspace", authMode: "loading", signedIn: false, me: null, docsMode: "" };

async function loadMe() {
  const response = await fetch(`${API}/v1/me`, { headers: { "content-type": "application/json" }, cache: "no-store" });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("API returned an invalid response"); }
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? payload.error : "Request failed");
    error.status = response.status;
    if (response.status === 401) {
      // The proxy marks an API rejection of a live session; anything else means the session is gone.
      if (payload.code !== "account_rejected") state.signedIn = false;
      state.me = null; updateAuthUi(error.message); resetIdentity();
    }
    throw error;
  }
  return payload;
}
function role() { return state.authMode === "demo" ? demoRole($("user").value) : state.me?.role || "member"; }
// Source controls edit the practice data and its demo people directly; a company on its live tools changes access at
// the tools themselves, so the page isn't shown there.
// Shown only once the workspace has said it is the demo: a slow or failed load must never show demo people in a real company.
const practiceControls = () => role() === "admin" && state.docsMode === "demo";
function setView(view) {
  if (view === "admin" && !practiceControls()) view = "workspace";
  if (view === "compliance" && role() !== "compliance") view = "workspace";
  state.view = view;
  for (const name of ["workspace", "tasks", "admin", "compliance", "operations"]) {
    $(`${name}View`).hidden = name !== view;
    const button = document.querySelector(`[data-view="${name}"]`);
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
}
function resetIdentity() {
  const identity = { role: role(), mode: state.authMode, signedIn: state.signedIn };
  setCurrentIdentity(identity);
  $("globalStatus").textContent = "";
  $("adminTab").hidden = !practiceControls();
  // Settings links in the top bar, for admins. The public demo has no directory or tools of its own to set up.
  $("adminLinks").hidden = role() !== "admin" || state.authMode === "demo";
  $("complianceTab").hidden = role() !== "compliance";
  setView("workspace");
  document.dispatchEvent(new CustomEvent(IDENTITY_CHANGED, { detail: identity }));
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
    state.me = await loadMe();
    if (!state.me || typeof state.me.id !== "string" || typeof state.me.name !== "string" || !Array.isArray(state.me.groups) || !["member", "admin", "compliance"].includes(state.me.role)) throw new Error("The API returned an invalid identity.");
    updateAuthUi(); resetIdentity();
  } catch (error) {
    if (state.authMode === "auth0") { state.me = null; }
    else state.authMode = "invalid";
    updateAuthUi(error.message);
    resetIdentity();
  }
}
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
// The workspace surface owns the documents, and says which mode it is in: the practice controls are shown
// only when the company is the demo.
document.addEventListener(WORKSPACE_DATA, event => {
  state.docsMode = event.detail?.capabilities?.mode ?? "";
  $("adminTab").hidden = !practiceControls();
  if (state.view === "admin" && !practiceControls()) setView("workspace");
});
// A task write changes the corpus, so the workspace surface reads it again.
document.addEventListener(TASKS_CHANGED, () => { document.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD)); });
$("user").addEventListener("change", resetIdentity);
$("loginButton").addEventListener("click", () => location.assign(`/auth/login?${new URLSearchParams({ returnTo: location.pathname + location.search })}`));
$("logoutButton").addEventListener("click", () => location.assign(state.authMode === "demo" ? "/demo/exit" : "/auth/logout"));
initAuth();
