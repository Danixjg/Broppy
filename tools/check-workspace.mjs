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
  assert.deepEqual(errors, [], "Workspace produces no uncaught browser errors");
  const artifacts = process.env.BROPPY_BROWSER_ARTIFACTS;
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/workspace.png`, fullPage: true });
  }
  console.log("Workspace browser checks passed. Review, reload, creation, identity changes, Slack issue navigation and chat scope use the running API.");
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
