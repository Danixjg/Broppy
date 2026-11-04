// Browser-level regression checks with a local Vite server and an entirely in-memory API.
// Supply BROPPY_PLAYWRIGHT_MODULE when Playwright is installed outside this workspace, and optionally
// BROPPY_BROWSER_EXECUTABLE to use a locally installed Chromium-compatible browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = path.join(root, "apps/web");
const playwright = process.env.BROPPY_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : "playwright");
const port = process.env.BROPPY_BROWSER_WEB_PORT || "4389";
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(web, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", port, "--strictPort"],
  { cwd: web, stdio: "pipe", windowsHide: true });
let output = "";
server.stdout.on("data", data => { output += data; });
server.stderr.on("data", data => { output += data; });
let browser;

async function ready() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${output}`);
    try { if ((await fetch(`${origin}/workspace/index.html`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${output}`);
}

const docs = ["A", "B"].map(key => ({
  docId: `confluence:${key}`, source: "confluence", title: `Project ${key} master`, content: `Private ${key} content.`,
  url: `https://example.com/${key}`, updatedAt: "2026-10-30T00:00:00Z", version: 1, metadata: { project: key }, links: []
}));
const workspace = { documents: docs, projects: docs.map((doc, index) => ({ key: ["A", "B"][index], name: `Project ${["A", "B"][index]}`,
  masterDocId: doc.docId, docIds: [doc.docId] })), latest: [], duplicates: [], suggestions: [], commitments: [], owners: [], capabilities: { mode: "live" } };
const card = { id: "jira:DB-9", key: "DB-9", title: "Private task title", projectKey: "A", projectName: "Project A",
  status: { name: "Done", category: "done" }, dueDate: "2026-01-01", priority: "High", updatedAt: "2026-10-30T00:00:00Z",
  url: "https://example.com/DB-9", mine: true };
const transition = { id: "31", name: "Stay done", target: { name: "Done", category: "done" }, fields: [] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function scenario({ role = "admin", rejected = "", rejectMe = false, fastAuth = false } = {}) {
  const page = await browser.newPage();
  const state = { rejected, rejectMe, workspaceRequests: 0, transitionReads: 0, ticketRequests: 0, createGate: null, releaseCreate: null };
  if (fastAuth) {
    // Hold the workspace mount after the controller starts, forcing the fast-auth ordering.
    await page.route("**/assets/app-*.js", async route => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({ response, body: `${source}\nawait new Promise(resolve => setTimeout(resolve, 100));\n` });
    });
    await page.addInitScript(({ role }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (input === "/api/session") return Promise.resolve(Response.json({ demo: false }));
        if (input === "/api/brain/v1/me") return Promise.resolve(Response.json({ id: "maya", name: "Maya", role, groups: [] }));
        return originalFetch(input, init);
      };
      document.addEventListener("broppy:identity-changed", event => {
        if (event.detail.role === role) window.identityBeforeWorkspace = !document.getElementById("docHeading");
      });
    }, { role });
  }
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === "/api/session") return json(route, { demo: false });
    if (pathname === "/api/brain/v1/me") {
      if (state.rejectMe) return json(route, { code: state.rejected, error: "Please log out and sign in again." }, 401);
      return json(route, { id: "maya", name: "Maya", role, groups: [] });
    }
    if (pathname === "/api/brain/v1/workspace") { state.workspaceRequests++; return json(route, workspace); }
    if (pathname === "/api/brain/v1/tasks/projects") return json(route, { projects: [{ key: "A", name: "Project A" }], priorities: ["High"] });
    if (pathname === "/api/brain/v1/tasks") return json(route, { items: [card], page: { total: 1, hasMore: false, nextCursor: null } });
    if (pathname === "/api/brain/v1/tasks/jira/DB-9" && request.method() === "GET") return json(route, { ...card, revision: "task-r1", capabilities: { edit: true }, links: [] });
    if (pathname === "/api/brain/v1/tasks/jira/DB-9/transitions") {
      if (request.method() === "GET") { state.transitionReads++; return json(route, { taskRevision: "task-r1", transitions: [transition] }); }
      return json(route, { error: { code: "TRANSITION_NO_EFFECT", message: "This move cannot be verified in Broppy. Do it in Jira instead.",
        fieldErrors: { transitionId: "Do it in Jira instead." } }, transitions: [transition] }, 409);
    }
    if (pathname === "/api/brain/v1/query") {
      const { question } = request.postDataJSON();
      if (question === "Reject access") return json(route, { code: state.rejected, error: "Please log out and sign in again." }, 401);
      if (question === "Create a ticket") return json(route, { kind: "action", text: "Review the proposed ticket.", citations: [], importNotice: "Action coverage warning.",
        proposal: { id: "p1", project: "DB", summary: "Test ticket", description: "Description" } });
      return json(route, { text: "Private answer.", citations: [], importNotice: "Answer coverage warning." });
    }
    if (pathname === "/api/brain/v1/catch-up") return role === "compliance"
      ? json(route, { kind: "audit", lines: ["Audit entry"], importNotice: "Audit coverage warning." })
      : json(route, { kind: "question", question: "What changed?", answer: { text: "Catch-up answer.", citations: [], importNotice: "Nested warning." },
        importNotice: "Catch-up coverage warning." });
    if (pathname === "/api/brain/v1/actions/jira-issue") {
      state.ticketRequests++;
      await state.createGate;
      return json(route, { key: "DB-10", url: "https://example.com/DB-10" });
    }
    return json(route, {});
  });
  await page.goto(`${origin}/workspace/index.html`);
  return { page, state };
}

try {
  await ready();
  browser = await chromium.launch({ headless: true, ...(process.env.BROPPY_BROWSER_EXECUTABLE ? { executablePath: process.env.BROPPY_BROWSER_EXECUTABLE } : {}) });
  {
    const { page, state } = await scenario({ fastAuth: true });
    await page.locator("#newConclusion").waitFor();
    assert.equal(await page.evaluate(() => window.identityBeforeWorkspace), true, "An identity that arrived before the workspace mounted is retained");
    await page.selectOption("#projectSelect", "A");
    await page.locator("#newConclusion").fill("Draft for project A");
    await page.selectOption("#projectSelect", "B");
    assert.equal(await page.locator("#newConclusion").inputValue(), "", "A draft must not follow a project switch");

    await page.locator("#question").fill("Ask about coverage");
    await page.locator("#askButton").click();
    await page.getByText("Answer coverage warning.").waitFor();
    await page.locator("#catchUp").click();
    await page.getByText("Catch-up coverage warning.").waitFor();
    await page.getByText("Nested warning.").waitFor();

    await page.locator('[data-view="tasks"]').click();
    await page.locator('#tasksList [data-task-id="jira:DB-9"]').click();
    await page.locator("#tasksMoveTo option").waitFor({ state: "attached" });
    await page.locator('#taskTransitionsForm button[type="submit"]').click();
    await page.getByText(/Do it in Jira instead/).first().waitFor();
    assert.equal(state.transitionReads, 1, "A refused self-transition must not be mistaken for a workflow refresh");

    await page.locator('[data-view="workspace"]').click();
    state.createGate = new Promise(resolve => { state.releaseCreate = resolve; });
    await page.locator("#question").fill("Create a ticket");
    await page.locator("#askButton").click();
    const proposal = page.locator("form.proposal");
    await proposal.waitFor();
    await page.getByText("Action coverage warning.").waitFor();
    await proposal.getByRole("button", { name: "Confirm and create" }).click();
    assert(await proposal.getByRole("button", { name: "Cancel" }).isDisabled(), "Cancellation is disabled while creating");
    assert(await proposal.getByRole("button", { name: "Confirm and create" }).isDisabled(), "Duplicate creation is disabled");
    state.releaseCreate();
    await page.getByText("Created DB-10.").waitFor();
    assert.equal(state.ticketRequests, 1);
    await page.close();
  }
  {
    const { page } = await scenario({ role: "compliance" });
    await page.locator("#catchUp").waitFor();
    await page.locator("#catchUp").click();
    await page.getByText("Audit coverage warning.").waitFor();
    await page.close();
  }
  for (const code of ["account_rejected", "token_unavailable"]) {
    const { page, state } = await scenario({ rejected: code });
    await page.getByText("Private A content.").first().waitFor();
    await page.locator('#personalList [data-task-id="jira:DB-9"]').waitFor();
    await page.locator("#question").fill("Ask about coverage");
    await page.locator("#askButton").click();
    await page.getByText("Private answer.").waitFor();
    await page.locator('[data-view="tasks"]').click();
    await page.locator('#tasksList [data-task-id="jira:DB-9"]').waitFor();
    await page.locator('[data-view="workspace"]').click();
    await page.locator("#question").fill("Reject access");
    await page.locator("#askButton").click();
    await page.getByText("Please log out and sign in again.").waitFor();
    assert(await page.locator("#logoutButton").isVisible(), `${code} retains Log out`);
    assert.equal(await page.getByText("Private A content.").count(), 0, `${code} clears documents`);
    assert.equal(await page.getByText("Private answer.").count(), 0, `${code} clears chat`);
    assert.equal(await page.locator('#personalList [data-task-id="jira:DB-9"]').count(), 0, `${code} clears personal tasks`);
    await page.locator('[data-view="tasks"]').click();
    assert.equal(await page.locator('#tasksList [data-task-id="jira:DB-9"]').count(), 0, `${code} clears task cards`);
    const requests = state.workspaceRequests;
    await page.waitForTimeout(200);
    assert.equal(state.workspaceRequests, requests, `${code} does not trigger a reload loop`);
    await page.close();
  }
  {
    const { page } = await scenario({ rejected: "token_unavailable", rejectMe: true });
    await page.getByText("Please log out and sign in again.").waitFor();
    assert(await page.locator("#logoutButton").isVisible(), "A token failure during sign-in retains Log out");
    assert.equal(await page.getByText("Private A content.").count(), 0, "A token failure during sign-in clears workspace data");
    await page.close();
  }
  console.log("Workspace regression checks passed.");
} finally {
  await browser?.close();
  server.kill();
}
