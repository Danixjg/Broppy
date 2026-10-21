import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = await import(process.env.BROPPY_PLAYWRIGHT_MODULE || "playwright");
const apiPort = process.env.BROPPY_BROWSER_API_PORT || "4380";
const webPort = process.env.BROPPY_BROWSER_WEB_PORT || "4381";
const origin = `http://127.0.0.1:${webPort}`;
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const children = [];
const output = [];
let browser;

function start(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...environment, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.on("data", data => output.push(data.toString()));
  child.stderr.on("data", data => output.push(data.toString()));
  child.on("error", error => output.push(error.message));
  return child;
}

async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}\n${output.join("")}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready at ${url}\n${output.join("")}`);
}

try {
  const api = start(["--import", "tsx", "apps/api/src/server.ts"], root,
    { PORT: apiPort, HOST: "127.0.0.1", PUBLIC_DEMO: "true", MOCK_DATA: "curated" });
  await ready(`http://127.0.0.1:${apiPort}/health`, api);
  const next = start([require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", webPort], web,
    { DEMO_API_URL: `http://127.0.0.1:${apiPort}`, APP_BASE_URL: origin, NEXT_TELEMETRY_DISABLED: "1" });
  await ready(origin, next);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/demo`);
  await page.waitForFunction(() => document.getElementById("workspaceMode")?.textContent === "Demo workspace");
  await page.selectOption("#user", "maya");
  await page.waitForFunction(() => document.querySelectorAll(".agreement[data-proposal-id]").length > 0);
  const workspace = await page.evaluate(async () => (await fetch("/api/brain/v1/workspace", { headers: { "x-demo-user": "maya" } })).json());
  const pending = workspace.commitments.find(item => item.status === "pending" && item.canCreate);
  assert(pending, "The curated demo provides a reviewable commitment");
  await page.selectOption("#projectSelect", pending.project);
  let card = page.locator(`[data-proposal-id="${pending.id}"]`);
  const summary = `${pending.summary} browser review`;
  await card.getByLabel("Summary", { exact: true }).fill(summary);
  assert(await card.getByRole("button", { name: /Create Jira task/ }).isDisabled(), "Unsaved review fields block creation");
  const saved = page.waitForResponse(response => response.url().endsWith("/v1/commitments/review") && response.request().method() === "POST");
  await card.getByRole("button", { name: "Save review", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.waitForFunction(({ id, summary }) => document.querySelector(`[data-proposal-id="${id}"] input`)?.value === summary, { id: pending.id, summary });
  await page.reload();
  await page.waitForFunction(() => document.getElementById("workspaceMode")?.textContent === "Demo workspace");
  await page.selectOption("#projectSelect", pending.project);
  card = page.locator(`[data-proposal-id="${pending.id}"]`);
  assert.equal(await card.getByLabel("Summary", { exact: true }).inputValue(), summary, "Saved review survives page reload");
  const created = page.waitForResponse(response => response.url().endsWith("/v1/tasks") && response.request().method() === "POST");
  await card.getByRole("button", { name: /Create Jira task/ }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const result = await response.json();
  const docId = result.docId || result.task?.docId;
  assert(docId, "Creation returns the new issue document");
  await page.goto(`${origin}/workspace/index.html?${new URLSearchParams({ doc: docId, project: pending.project })}`);
  await page.waitForFunction(() => document.getElementById("selectedDetail")?.hidden === false);
  assert.equal(await page.locator("#projectSelect").inputValue(), pending.project, "Issue deep link selects its project");
  await page.selectOption("#user", "alex");
  await page.waitForFunction(() => document.getElementById("globalStatus")?.textContent === "The linked project is unavailable to this identity.");
  assert.equal(await page.locator("#selectedDetail").isVisible(), false, "Switching identities hides an inaccessible issue");
  await page.selectOption("#user", "maya");
  await page.waitForFunction(() => document.getElementById("selectedDetail")?.hidden === false);
  assert.equal(await page.locator("#projectSelect").inputValue(), pending.project, "Returning to an authorized identity reapplies the exact issue link");
  await page.goto(`${origin}/workspace/index.html?${new URLSearchParams({ task: docId })}`);
  await page.waitForFunction(() => document.getElementById("selectedDetail")?.hidden === false);
  assert.equal(await page.locator("#projectSelect").inputValue(), pending.project, "Slack's exact task URL selects the authorized issue");
  const queried = page.waitForRequest(request => request.url().endsWith("/v1/query") && request.method() === "POST");
  await page.locator("#question").fill("What is the latest status?");
  await page.locator("#askButton").click();
  assert.equal((await queried).postDataJSON().project, pending.project, "Project chat sends its selected scope");
  await page.waitForFunction(() => document.getElementById("askButton")?.disabled === false);
  const unscopedRequest = page.waitForRequest(request => request.url().endsWith("/v1/query") && request.method() === "POST");
  await page.goto(`${origin}/workspace/index.html?${new URLSearchParams({ ask: "What is the latest status?" })}`);
  const unscoped = await unscopedRequest;
  assert.equal(unscoped.postDataJSON().project, undefined, "An unscoped Slack question searches the accessible workspace");
  await page.waitForFunction(() => document.getElementById("askButton")?.disabled === false);
  await page.selectOption("#user", "maya");
  await page.click('[data-view="tasks"]');
  await page.waitForFunction(() => document.querySelectorAll("#tasksList .activity-item").length > 0);
  const listKeys = await page.evaluate(() => [...document.querySelectorAll("#tasksList .item-meta")].map(item => item.textContent.split(" · ")[0]));
  assert(listKeys.includes("PAY-101"), "The Tasks list shows the synced Jira issues this identity may read");
  assert(!listKeys.includes("SEC-44") && !listKeys.includes("OPS-3"), "The Tasks list stays inside the identity's authorized snapshot");
  const fallbackIndex = listKeys.indexOf("SETL-27");
  assert(fallbackIndex !== -1, "The curated demo includes a task without due date and priority");
  const fallbackMeta = await page.evaluate(index => document.querySelectorAll("#tasksList .item-meta")[index].textContent, fallbackIndex);
  assert.equal(fallbackMeta, "SETL-27 · SETL · No due date · No priority", "Absent fields read as fallback words, not fabricated values");
  assert((await page.locator("#tasksCountsText").textContent()).includes("not tracked yet"), "The done count says completion isn't tracked instead of claiming a zero");
  await page.locator("#tasksList .activity-item").filter({ hasText: "PAY-101" }).first().click();
  await page.waitForFunction(() => document.getElementById("tasksDetail")?.hidden === false);
  const selectedHeading = await page.locator("#tasksDetail h3").textContent();
  assert.equal(selectedHeading, "PAY-101 Payment cutover", "A card opens its drawer from the summary key alone");
  await page.click("#tasksBoardView");
  await page.waitForFunction(() => document.getElementById("tasksBoard")?.hidden === false && document.querySelectorAll("#tasksBoard .surface").length > 0);
  assert.equal(await page.locator("#tasksBoard .surface").count(), 4, "The board renders its four fixed columns");
  const boardText = await page.locator("#tasksBoard").textContent();
  assert(boardText.includes("PAY-101") && boardText.includes("Unmapped"), "The board carries the list's identities and its always-present Unmapped column");
  assert.equal(await page.locator("#tasksDetail h3").textContent(), selectedHeading, "Toggling views preserves the open selection");
  await page.click("#tasksListView");
  await page.waitForFunction(() => document.getElementById("tasksList")?.hidden === false);
  const toggledKeys = await page.evaluate(() => [...document.querySelectorAll("#tasksList .item-meta")].map(item => item.textContent.split(" · ")[0]));
  assert.deepEqual(toggledKeys, listKeys, "Back on the list, the same issue identities are shown");
  await page.waitForFunction(() => document.querySelectorAll("#tasksProjects option").length > 1);
  // A save sends only the changed field, and the drawer refetches Jira's accepted value (FT18, FT19).
  const edited = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/v1/tasks/jira/PAY-101"));
  await page.fill("#tasksEditForm input[name=summary]", "Cutover rehearsal");
  await page.click("#tasksEditForm button[type=submit]");
  assert.equal((await edited).status(), 200);
  await page.waitForFunction(() => document.querySelector("#tasksDetail h3")?.textContent === "Cutover rehearsal");
  await page.waitForFunction(() => [...document.querySelectorAll("#tasksList .item-title")].some(item => item.textContent === "Cutover rehearsal"));
  const redated = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/v1/tasks/jira/PAY-101"));
  await page.fill("#tasksEditForm input[name=dueDate]", "2026-11-02");
  await page.click("#tasksEditForm button[type=submit]");
  assert.equal((await redated).status(), 200);
  await page.waitForFunction(() => (document.querySelector("#tasksDetail .detail-meta")?.textContent ?? "").includes("Nov 2"));
  // A move goes through the real workflow id and reads the new state back (FT24).
  await page.locator("#tasksList .activity-item").filter({ hasText: "SETL-27" }).first().click();
  await page.waitForFunction(() => document.querySelectorAll("#taskTransitionsForm select[name=transition] option").length > 1);
  await page.selectOption("#taskTransitionsForm select[name=transition]", "21");
  const moved = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/transitions"));
  await page.click("#taskTransitionsForm button[type=submit]");
  assert.equal((await moved).status(), 200);
  await page.waitForFunction(() => (document.querySelector("#tasksDetail .eyebrow")?.textContent ?? "").includes("in progress"));
  await page.waitForFunction(() => [...document.querySelectorAll("#tasksList .status-badge")].some(item => item.textContent === "in progress"));
  // A stale baseline keeps the draft and names the change instead of dispatching (FT48).
  await page.locator("#tasksList .activity-item").filter({ hasText: "DB-12" }).first().click();
  await page.waitForFunction(() => document.querySelector("#tasksEditForm input[name=summary]")?.value === "DB-12 Ledger database migration");
  await page.evaluate(async () => {
    const detail = await (await fetch("/api/brain/v1/tasks/jira/DB-12", { headers: { "x-demo-user": "maya" } })).json();
    await fetch("/api/brain/v1/tasks/jira/DB-12", { method: "PUT", headers: {
      "x-demo-user": "maya", "content-type": "application/json", "if-match": detail.revision, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ clientIntentId: crypto.randomUUID(), fields: { priority: "High" } }) });
  });
  await page.fill("#tasksEditForm input[name=summary]", "Moved by hand meanwhile");
  await page.click("#tasksEditForm button[type=submit]");
  await page.waitForFunction(() => (document.querySelector("#tasksDetail .task-edit-note")?.textContent ?? "").includes("changed on Jira"));
  assert.equal(await page.locator("#tasksEditForm input[name=summary]").inputValue(), "Moved by hand meanwhile", "A conflict keeps the draft");
  const mayaPayloads = await page.evaluate(async () => ({
    list: await (await fetch("/api/brain/v1/tasks?view=list", { headers: { "x-demo-user": "maya" } })).json(),
    board: await (await fetch("/api/brain/v1/tasks?view=board", { headers: { "x-demo-user": "maya" } })).json(),
    projects: await (await fetch("/api/brain/v1/tasks/projects", { headers: { "x-demo-user": "maya" } })).json()
  }));
  assert.deepEqual(mayaPayloads.projects.projects.map(item => item.key), ["DB", "PAY", "REL", "SETL"], "Filter options enumerate only the authorized snapshot");
  const mayaSerialized = JSON.stringify([mayaPayloads.list, mayaPayloads.board]);
  assert(!mayaSerialized.includes("SEC-44") && !mayaSerialized.includes("OPS-3"), "Cards and counts never expose hidden issues");
  const mayaOptions = await page.evaluate(() => [...document.querySelectorAll("#tasksProjects option")].map(item => item.value).filter(Boolean));
  assert.deepEqual(mayaOptions, ["DB", "PAY", "REL", "SETL"], "The project filter is derived from the loaded authorized responses");
  await page.goto(`${origin}/workspace/index.html?${new URLSearchParams({ view: "tasks", task: "jira:PAY-101" })}`);
  await page.waitForFunction(() => document.getElementById("workspaceMode")?.textContent === "Demo workspace");
  await page.waitForFunction(() => document.getElementById("tasksDetail")?.hidden === false);
  assert.equal(await page.locator("#tasksDetail h3").textContent(), "Cutover rehearsal", "A Tasks deep link opens the task from the detail route");
  assert.equal(await page.locator('[data-view="tasks"]').getAttribute("aria-current"), "page", "The Tasks deep link opens on the Tasks view");
  await page.goto(`${origin}/workspace/index.html?${new URLSearchParams({ view: "tasks", task: "jira:NOPE-999" })}`);
  await page.waitForFunction(() => document.getElementById("workspaceMode")?.textContent === "Demo workspace");
  await page.waitForFunction(() => document.getElementById("tasksDetail")?.hidden === false);
  assert.equal(await page.locator("#tasksDetail h3").textContent(), "Task unavailable.", "A missing deep-linked task lands in the one unavailable panel");
  await page.selectOption("#user", "alex");
  await page.click('[data-view="tasks"]');
  await page.waitForFunction(() => document.getElementById("tasksList")?.textContent === "No Jira tasks here yet.");
  assert((await page.locator("#tasksCountsText").textContent()).startsWith("0 open"), "A persona without tasks reads zero counts, not another persona's numbers");
  const unavailable = await page.evaluate(async personas => {
    const responses = [];
    for (const [user, paths] of Object.entries(personas)) {
      for (const path of paths) {
        const response = await fetch(`/api/brain${path}`, { headers: { "x-demo-user": user } });
        responses.push({ status: response.status, body: await response.text() });
      }
    }
    return responses;
  }, {
    maya: ["/v1/tasks/jira/SEC-44", "/v1/tasks/jira/OPS-3", "/v1/tasks/jira/NOPE-999", "/v1/tasks/jira/pay-101"],
    alex: ["/v1/tasks/jira/PAY-101", "/v1/tasks/jira/SETL-27", "/v1/tasks/jira/NOPE-999", "/v1/tasks/jira/pay-101"]
  });
  assert(unavailable.every(item => item.status === 404), "Hidden, missing and malformed task addresses all refuse with 404");
  assert(unavailable.every(item => item.body === unavailable[0].body), "Every task refusal carries the same bytes for every identity");
  assert.deepEqual(errors, [], "Workspace produces no uncaught browser errors");
  const artifacts = process.env.BROPPY_BROWSER_ARTIFACTS;
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/workspace.png`, fullPage: true });
  }
  console.log("Workspace browser checks passed. Review, reload, creation, identity changes, Slack navigation and chat scope, the read-only Tasks view, task edits and moves, persona isolation and identical task refusals use the running API.");
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
