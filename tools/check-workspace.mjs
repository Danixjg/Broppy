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
  await card.getByLabel("Owner", { exact: true }).selectOption("maya@aspire.example");
  await card.getByLabel("Due date (blank means unknown)").fill("2026-10-02");
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
  await page.click('[data-view="workspace"]');
  await page.waitForFunction(() => document.querySelectorAll("#personalList .activity-item").length > 0);
  assert((await page.locator("#personalNote").textContent()).includes("open task"), "The widget reports the count of open tasks due by today");
  const widgetTitle = await page.evaluate(() => document.querySelector("#personalList .item-title")?.textContent ?? "");
  await page.click("#personalList .activity-item");
  await page.waitForFunction(title => document.querySelector("#tasksDetail h3")?.textContent === title, widgetTitle);
  assert.equal(await page.locator("#tasksDetail h3").textContent(), widgetTitle, "A widget row opens the task's drawer on the Tasks view");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("tasksDetail")?.hidden === true);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.taskId !== undefined), true, "Closing the drawer returns focus to a task card");
  await page.click('[data-view="workspace"]');
  await page.waitForFunction(() => document.getElementById("personalSection")?.hidden === false);
  await page.click("#personalAll");
  await page.waitForFunction(() => document.getElementById("tasksView")?.hidden === false);
  assert.equal(await page.locator("#tasksMine").isChecked(), true, "All tasks seeds the Mine only filter");
  assert.equal(await page.locator("#tasksDue").inputValue(), "throughToday", "All tasks seeds the through-today filter");
  assert(await page.locator("#tasksList .activity-item").filter({ hasText: "browser review" }).first().isVisible(), "The seeded filters show the task the journey created");
  const transitionPosts = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/transitions")) transitionPosts.push(request.url());
  });
  await page.click("#tasksClear");
  await page.waitForFunction(() => document.querySelectorAll("#tasksList .activity-item").length >= 5, undefined, { timeout: 15000 });
  await page.click("#tasksBoardView");
  await page.waitForFunction(() => document.querySelectorAll("#tasksBoard .surface").length === 4);
  const dispatchDrag = async (key, column, thenDrop = true) => {
    await page.evaluate(key => {
      const handle = [...document.querySelectorAll("#tasksBoard .activity-item")]
        .find(card => card.textContent.includes(key))?.querySelector(".drag-handle");
      handle?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
    }, key);
    await page.waitForTimeout(450);
    return await page.evaluate(({ key, column, thenDrop }) => {
      const cell = [...document.querySelectorAll("#tasksBoard .surface")]
        .find(cell => cell.querySelector("h2")?.textContent.startsWith(column));
      const transfer = new DataTransfer();
      cell.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      const highlight = cell.classList.contains("drop-target");
      if (thenDrop) cell.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      return highlight;
    }, { key, column, thenDrop });
  };
  assert.equal(await dispatchDrag("DB-12", "To do"), true, "DB-12's legal move highlights the To do column");
  assert(await page.waitForFunction(() => document.getElementById("tasksStatus")?.textContent.includes("Back to open applied")).then(() => true), "The drop submits the one legal move and reports it");
  assert(await page.waitForFunction(() => {
    const cell = [...document.querySelectorAll("#tasksBoard .surface")]
      .find(cell => [...cell.querySelectorAll(".item-meta")].some(item => item.textContent.startsWith("DB-12")));
    return cell?.querySelector("h2")?.textContent.startsWith("To do");
  }).then(() => true), "The moved card landed in To do");
  const beforePick = transitionPosts.length;
  assert.equal(await dispatchDrag("DB-12", "Done"), true, "the Done move still highlights as a legal destination");
  await page.waitForFunction(() => document.activeElement === document.querySelector("#taskTransitionsForm select[name=transition]"), undefined, { timeout: 5000 });
  assert.equal(transitionPosts.length, beforePick, "A move that needs a field opens the picker instead of dropping");
  await page.click(".task-detail-close");
  assert.equal(await dispatchDrag("REL-9", "To do", false), false, "A task with no legal moves highlights nothing");
  const refusals = transitionPosts.length;
  await dispatchDrag("REL-9", "To do");
  await page.waitForFunction(() => document.getElementById("tasksStatus")?.textContent.includes("No legal move"));
  assert.equal(transitionPosts.length, refusals, "An illegal drop never submits a transition");
  await page.click("#tasksListView");
  await page.click("#tasksClear");
  await page.waitForFunction(() => document.querySelectorAll("#tasksList .activity-item").length > 0);
  await page.locator("#tasksList .activity-item").filter({ hasText: "PAY-101" }).first().click();
  await page.waitForFunction(() => Boolean(document.querySelector("#tasksEditForm")));
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
  await page.locator("#tasksList .activity-item").filter({ hasText: "SETL-27" }).first().click();
  await page.waitForFunction(() => document.querySelectorAll("#taskTransitionsForm select[name=transition] option").length > 1);
  await page.selectOption("#taskTransitionsForm select[name=transition]", "21");
  const moved = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/transitions"));
  await page.click("#taskTransitionsForm button[type=submit]");
  assert.equal((await moved).status(), 200);
  await page.waitForFunction(() => (document.querySelector("#tasksDetail .eyebrow")?.textContent ?? "").includes("in progress"));
  await page.waitForFunction(() => [...document.querySelectorAll("#tasksList .status-badge")].some(item => item.textContent === "in progress"));
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

  await page.goto(`${origin}/workspace/index.html`);
  await page.waitForFunction(() => document.getElementById("workspaceMode")?.textContent === "Demo workspace");
  const adminIdentityReady = page.waitForResponse(response => response.url().endsWith("/v1/workspace") && response.status() === 200);
  await page.selectOption("#user", "maya");
  await adminIdentityReady;
  await page.waitForFunction(() => document.getElementById("adminTab")?.hidden === false);
  await page.click('[data-view="admin"]');
  await page.waitForFunction(() => document.getElementById("adminView")?.hidden === false);
  assert.equal(await page.locator("#adminHeading").textContent(), "Source controls", "An admin opens the source controls");
  const mayaWorkspace = await page.evaluate(async () => (await fetch("/api/brain/v1/workspace", { headers: { "x-demo-user": "maya" } })).json());
  const mayaDocIds = mayaWorkspace.documents.map(item => item.docId);
  await page.waitForFunction(ids => {
    const options = [...document.querySelectorAll("#adminDoc option")].map(option => option.value);
    return options.length === ids.length && options.every((value, index) => value === ids[index]);
  }, mayaDocIds);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#adminDoc option")].map(option => option.value)), mayaDocIds, "The document select is fed from the documents this identity may read");
  await page.selectOption("#adminDoc", "slack:vendor-integration");
  await page.selectOption("#tier", "restricted");
  const tierApplied = page.waitForResponse(response => response.url().endsWith("/v1/admin/tier") && response.request().method() === "POST");
  await page.click("#applyTier");
  assert.equal((await tierApplied).status(), 200);
  await page.waitForFunction(() => document.getElementById("adminStatus")?.textContent === "Access tier narrowed.");
  assert.equal(await page.locator("#adminStatus").textContent(), "Access tier narrowed.", "The page says the access tier was narrowed");
  await page.waitForFunction(() => ![...document.querySelectorAll("#adminDoc option")].some(option => option.value === "slack:vendor-integration"));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#adminDoc option")].some(option => option.value === "slack:vendor-integration")), false, "The narrowed document leaves the admin's own list");
  await page.selectOption("#adminDoc", "jira:PAY-101");
  await page.waitForFunction(() => document.getElementById("nativeStatus")?.textContent === "Current permissions loaded. Only narrower changes will be accepted.");
  const nativePermissions = JSON.parse(await page.locator("#nativePermissions").inputValue());
  assert.equal(nativePermissions.native.projectKey, "PAY", "The native permissions are the source's own fields");
  const narrowedPermissions = { ...nativePermissions, native: { ...nativePermissions.native,
    issueViewers: nativePermissions.native.issueViewers.filter(viewer => viewer !== "ravi@aspire.example") } };
  await page.fill("#nativePermissions", JSON.stringify(narrowedPermissions, null, 2));
  const permissionsSaved = page.waitForResponse(response => response.url().endsWith("/v1/admin/permissions") && response.request().method() === "POST");
  await page.click("#saveNativePermissions");
  assert.equal((await permissionsSaved).status(), 200);
  await page.waitForFunction(() => document.getElementById("nativeStatus")?.textContent === "Source permissions saved and workspace refreshed.");
  assert.equal(await page.locator("#nativeStatus").textContent(), "Source permissions saved and workspace refreshed.", "The page says the narrower permissions were saved");
  const countRoutineSyncs = async () => await page.evaluate(async () => {
    const audit = await (await fetch("/api/brain/v1/audit", { headers: { "x-demo-user": "nur" } })).json();
    return audit.entries.filter(entry => entry.type === "document_synced" && entry.data.contentChanged === false && entry.data.permissionChanged === false).length;
  });
  const routineBefore = await countRoutineSyncs();
  const permissionsResaved = page.waitForResponse(response => response.url().endsWith("/v1/admin/permissions") && response.request().method() === "POST");
  await page.click("#saveNativePermissions");
  assert.equal((await permissionsResaved).status(), 200);
  await page.waitForFunction(() => document.getElementById("nativeStatus")?.textContent === "Source permissions saved and workspace refreshed.");
  assert.equal(await page.locator("#nativeStatus").textContent(), "Source permissions saved and workspace refreshed.", "The same narrower permissions are accepted again");
  assert((await countRoutineSyncs()) > routineBefore, "A source re-read that found nothing changed is recorded as a routine sync");
  const widenedPermissions = { ...nativePermissions, native: { ...nativePermissions.native,
    issueViewers: [...nativePermissions.native.issueViewers, "wei@contractor.example"] } };
  await page.fill("#nativePermissions", JSON.stringify(widenedPermissions, null, 2));
  await page.click("#saveNativePermissions");
  await page.waitForFunction(() => document.getElementById("nativeStatus")?.textContent === "Keep the Jira project key and only remove project or issue viewers.");
  assert.equal(await page.locator("#nativeStatus").textContent(), "Keep the Jira project key and only remove project or issue viewers.", "A wider native change is refused in the page's own words");
  const widenedCall = await page.evaluate(async permissions => {
    const response = await fetch("/api/brain/v1/admin/permissions", { method: "POST", headers: { "x-demo-user": "maya", "content-type": "application/json" },
      body: JSON.stringify({ docId: "jira:PAY-101", permissions }) });
    return { status: response.status };
  }, widenedPermissions);
  assert(widenedCall.status >= 400 && widenedCall.status < 500, "The API refuses a wider native change as well");
  const unchangedPermissions = await page.evaluate(async () => (await fetch("/api/brain/v1/admin/permissions?docId=jira:PAY-101", { headers: { "x-demo-user": "maya" } })).json());
  assert.deepEqual(unchangedPermissions.permissions.native.issueViewers, narrowedPermissions.native.issueViewers, "The refused change left the source permissions as they were");
  await page.selectOption("#previewUser", "alex");
  const previewLoaded = page.waitForResponse(response => response.url().includes("/v1/admin/preview") && response.status() === 200);
  await page.click("#previewAccess");
  const previewResponse = await previewLoaded;
  const previewPayload = await previewResponse.json();
  await page.waitForFunction(() => document.getElementById("previewResult")?.textContent?.includes("accessible documents"));
  const previewText = await page.locator("#previewResult").textContent();
  assert(previewText.includes(`Alex · ${previewPayload.documents.length} accessible documents`), "The preview says how many documents the new hire may read");
  assert(previewPayload.documents.every(item => previewText.includes(item.title)), "The preview names every document the new hire may read");
  assert(previewText.includes("Group: interns"), "The preview says which grant gives the new hire that access");

  const alexIdentityReady = page.waitForResponse(response => response.url().endsWith("/v1/workspace") && response.status() === 200);
  await page.selectOption("#user", "alex");
  await alexIdentityReady;
  assert.equal(await page.evaluate(() => document.getElementById("adminTab")?.hidden), true, "A member is offered no admin tab");
  assert.equal(await page.evaluate(() => document.getElementById("complianceTab")?.hidden), true, "A member is offered no compliance tab");
  assert.equal(await page.evaluate(() => document.getElementById("retrySync")?.hidden), true, "A member is offered no sync button");
  await page.evaluate(() => document.querySelector('[data-view="admin"]')?.click());
  assert.equal(await page.locator("#adminView").isVisible(), false, "A member cannot open the admin view");
  await page.evaluate(() => document.querySelector('[data-view="compliance"]')?.click());
  assert.equal(await page.locator("#complianceView").isVisible(), false, "A member cannot open the compliance view");
  assert.equal(await page.locator("#workspaceView").isVisible(), true, "The workspace stays open for a member");
  const nurIdentityReady = page.waitForResponse(response => response.url().endsWith("/v1/workspace") && response.status() === 200);
  await page.selectOption("#user", "nur");
  await nurIdentityReady;
  assert.equal(await page.evaluate(() => document.getElementById("adminTab")?.hidden), true, "A compliance user is offered no admin tab");
  assert.equal(await page.evaluate(() => document.getElementById("complianceTab")?.hidden), false, "A compliance user is offered the compliance tab");
  await page.evaluate(() => document.querySelector('[data-view="admin"]')?.click());
  assert.equal(await page.locator("#adminView").isVisible(), false, "A compliance user cannot open the admin view");
  assert.equal(await page.locator("#workspaceView").isVisible(), true, "The workspace stays open for a compliance user");
  const refusedAdmin = await page.evaluate(async calls => {
    const responses = [];
    for (const call of calls) {
      const response = await fetch(`/api/brain${call.path}`, { method: call.method, headers: { "x-demo-user": call.user, "content-type": "application/json" },
        body: call.method === "POST" ? JSON.stringify(call.body ?? {}) : undefined });
      responses.push({ status: response.status });
    }
    return responses;
  }, [
    { user: "alex", path: "/v1/admin/permissions?docId=jira:PAY-101", method: "GET" },
    { user: "alex", path: "/v1/admin/tier", method: "POST", body: { docId: "jira:PAY-101", tier: "restricted" } },
    { user: "alex", path: "/v1/admin/sync", method: "POST" },
    { user: "alex", path: "/v1/audit", method: "GET" },
    { user: "alex", path: "/v1/audit/search?q=denied", method: "GET" },
    { user: "ravi", path: "/v1/audit", method: "GET" }
  ]);
  assert(refusedAdmin.every(call => call.status === 403), "Every admin and audit call from a member is forbidden");

  const mayaHealthReady = page.waitForResponse(response => response.url().endsWith("/v1/workspace") && response.status() === 200);
  await page.selectOption("#user", "maya");
  await mayaHealthReady;
  await page.click('[data-view="operations"]');
  await page.waitForFunction(() => document.getElementById("operationsView")?.hidden === false);
  await page.waitForFunction(() => document.querySelectorAll("#healthCards h2").length > 0);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#healthCards h2")].map(card => card.textContent)), ["Slack", "Jira", "Confluence", "Drive"], "The sync health cards name the tools this workspace reads");
  await page.waitForFunction(() => document.getElementById("healthStatus")?.textContent?.includes("tools connected"));
  assert.equal(await page.locator("#healthStatus").textContent(), "4 of 4 tools connected", "The page says how many of the tools are connected");
  assert.equal(await page.evaluate(() => document.getElementById("retrySync")?.hidden), false, "An admin is offered the sync button");
  const healthRefreshed = page.waitForResponse(response => response.url().endsWith("/v1/sync-health") && response.status() === 200);
  await page.click("#refreshHealth");
  assert.equal((await healthRefreshed).status(), 200);
  await page.waitForFunction(() => document.getElementById("healthStatus")?.textContent === "4 of 4 tools connected");
  assert.equal(await page.locator("#healthCards .surface").count(), 4, "The refresh keeps the same tools on the page");
  const syncStarted = page.waitForResponse(response => response.url().endsWith("/v1/admin/sync") && response.request().method() === "POST");
  await page.click("#retrySync");
  assert.equal((await syncStarted).status(), 200);
  await page.waitForFunction(() => document.getElementById("healthStatus")?.textContent?.includes("Synced"));
  assert((await page.locator("#healthStatus").textContent()).includes("Synced"), "The page says which tools it synced");

  const nurAuditReady = page.waitForResponse(response => response.url().endsWith("/v1/workspace") && response.status() === 200);
  await page.selectOption("#user", "nur");
  await nurAuditReady;
  await page.click('[data-view="compliance"]');
  await page.waitForFunction(() => document.getElementById("complianceView")?.hidden === false);
  await page.waitForFunction(() => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length > 0);
  const auditSummary = await page.locator("#auditSummary").textContent();
  assert(auditSummary.includes("Chain valid"), "The console says the hash chain is intact");
  const listedEvents = await page.evaluate(() => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length);
  const routineHidden = (await page.locator("#routineHidden").textContent()).trim();
  assert(/^\d+ hidden$/.test(routineHidden), "The console says how many routine sync checks it keeps out of the way");
  const routineCount = Number(routineHidden.split(" ")[0]);
  assert(routineCount > 0, "There are routine sync checks to hide");
  assert.equal(listedEvents + routineCount, Number(auditSummary.split(" ")[0]), "Every event the console holds is either listed or counted as hidden");
  await page.uncheck("#hideRoutine");
  await page.waitForFunction(count => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length === count, listedEvents + routineCount);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length), listedEvents + routineCount, "Unticking the routine filter brings the routine sync checks back");
  await page.check("#hideRoutine");
  await page.waitForFunction(count => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length === count, listedEvents);
  await page.fill("#auditSearch", "tier_narrowed");
  const auditSearched = page.waitForResponse(response => response.url().includes("/v1/audit/search") && response.status() === 200);
  await page.click("#auditSearchForm button[type=submit]");
  assert.equal((await auditSearched).status(), 200);
  await page.waitForFunction(() => document.getElementById("auditStatus")?.textContent?.includes("matching event"));
  const searchedEvents = await page.evaluate(() => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).length);
  assert(searchedEvents > 0, "The search finds the events it was asked for");
  assert(searchedEvents < listedEvents, "The search narrows the events");
  assert((await page.evaluate(() => [...document.querySelectorAll("#auditRows tr")].filter(row => row.cells.length === 5).map(row => row.cells[1].textContent))).every(type => type === "tier_narrowed"), "Every row the search kept is the event it matched");
  const auditExport = page.waitForEvent("download");
  await page.click("#exportAudit");
  assert.equal((await auditExport).suggestedFilename(), "internal-brain-audit.csv", "The export is offered as a named CSV file");
  const auditSealed = page.waitForResponse(response => response.url().endsWith("/v1/audit/seal") && response.request().method() === "POST");
  await page.click("#sealAudit");
  assert.equal((await auditSealed).status(), 200);
  await page.waitForFunction(() => document.getElementById("auditStatus")?.textContent === "Audit batch sealed.");
  assert.equal(await page.locator("#auditStatus").textContent(), "Audit batch sealed.", "The console says the events were sealed into a batch");
  const proofLoaded = page.waitForResponse(response => response.url().includes("/v1/audit/proof") && response.status() === 200);
  await page.getByRole("button", { name: "Inspect proof" }).first().click();
  assert.equal((await proofLoaded).status(), 200);
  await page.waitForFunction(() => document.getElementById("proofPanel")?.hidden === false);
  assert((await page.locator("#proofPanel").textContent()).includes("Merkle proof"), "The proof panel opens for the event");
  const proofVerified = page.waitForResponse(response => response.url().endsWith("/v1/audit/verify") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Verify proof" }).click();
  assert.equal((await proofVerified).status(), 200);
  await page.waitForFunction(() => document.querySelector("#proofPanel .badge")?.textContent === "Proof verified");
  assert.equal(await page.locator("#proofPanel .badge").textContent(), "Proof verified", "The proof verifies against the sealed batch");
  await page.click('[data-view="workspace"]');
  await page.waitForFunction(() => document.getElementById("workspaceView")?.hidden === false);
  const answerGiven = page.waitForResponse(response => response.url().endsWith("/v1/query") && response.request().method() === "POST" && response.status() === 200);
  await page.locator("#question").fill("What is the latest payment status?");
  await page.locator("#askButton").click();
  const answerPayload = await (await answerGiven).json();
  await page.waitForFunction(() => [...document.querySelectorAll("#chatHistory button")].some(button => button.textContent.includes("Why this result?")));
  await page.getByRole("button", { name: /Why this result/ }).first().click();
  await page.waitForFunction(() => document.getElementById("tracePanel")?.hidden === false);
  assert.equal(await page.locator("#complianceView").isVisible(), true, "The answer's own link opens the compliance console");
  const traceText = await page.locator("#tracePanel").textContent();
  assert(traceText.includes("Query trace"), "The trace panel opens from the answer's own link");
  assert(traceText.includes(`Trace ${answerPayload.traceId}`), "The trace panel names the trace the answer came from");
  assert(await page.locator("#tracePanel .trace-event").count() > 0, "The trace lists the steps the answer went through");
  await page.click('[data-view="workspace"]');
  await page.waitForFunction(() => document.getElementById("workspaceView")?.hidden === false);

  assert.deepEqual(errors, [], "Workspace produces no uncaught browser errors");
  const artifacts = process.env.BROPPY_BROWSER_ARTIFACTS;
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/workspace.png`, fullPage: true });
  }
  console.log("Workspace browser checks passed. Review, reload, creation, identity changes, Slack navigation and chat scope, the read-only Tasks view, task edits, moves by menu and by drag, the personal widget, persona isolation and identical task refusals use the running API. The admin view's document list, tier narrowing, native permissions, refused widening and access preview, the refusals a member and a compliance user meet, the sync health cards and refresh, and the compliance console's events, routine filter, search, CSV export, sealed proof and query trace run against the same API.");
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
