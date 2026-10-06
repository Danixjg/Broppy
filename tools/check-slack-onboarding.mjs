import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
const requireApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(requireApi.resolve("jose")).href);
import { createApiServer } from "../apps/api/src/server.ts";
import { Brain } from "../apps/api/src/brain.ts";
import { SlackGateway } from "../apps/slack/src/gateway.ts";
import { TestInstallationRegistry, admin, testRuntime } from "../apps/slack/src/installation-fixtures.ts";
import { MemoryTaskStore } from "../apps/slack/src/store.ts";
import { SLACK_BOT_SCOPES } from "../apps/slack/src/app-manifest.ts";

const artifactDir = resolve(process.env.SLACK_CHECK_ARTIFACTS ?? "/tmp/broppy-slack-onboarding/browser");
await mkdir(artifactDir, { recursive: true });
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "/tmp/broppy-browser-check/node_modules/playwright/index.mjs";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/tmp/broppy-browser-check/browsers";
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const registry = new TestInstallationRegistry();
const member = { ...admin, id: "ravi", role: "member", auth0Sub: "auth0|ravi", email: "ravi@example.test" };
const users = [admin, member];
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "controlled-key", alg: "RS256", use: "sig" };
const tokens = {};
for (const user of users) tokens[user.id] = await new SignJWT({ org_id: "org-a" }).setProtectedHeader({ alg: "RS256", kid: "controlled-key" }).setIssuer("https://auth.controlled.test/").setAudience("broppy-api")
  .setSubject(user.auth0Sub).setIssuedAt().setExpirationTime("1h").sign(privateKey);
const requests = [];
const redirects = [];
const browserFailures = [];
const workspaceCalls = [];
const stores = new Map([["org-a",new MemoryTaskStore()],["org-b",new MemoryTaskStore()]]);
let nextGrant = { teamId: "TONE", teamName: "Company A", token: "xoxb-controlled-a" };
let consentSequence = 0;
const consentCodes = new Map();
let fixtureOrigin;
const realFetch = globalThis.fetch;
const servers = [];
let browser;
function json(response, status, data) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); }
async function listen(server) {
  servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); return `http://127.0.0.1:${address.port}`;
}
async function readBody(request) { let body = ""; for await (const chunk of request) body += chunk.toString(); return body; }
async function rpc(name, body) {
  const org = body.organization; const app = body.application;
  if (name === "begin_slack_install") { await registry.begin(org,app,body.state_hash,body.person,body.person_sub); return null; }
  if (name === "consume_slack_install") return await registry.consume(org,app,body.state_hash) ?? null;
  if (name === "slack_install_status") { const status = await registry.status(org,app); return status.state === "not_installed" ? null : status; }
  if (name === "publish_slack_install") return registry.publish({ orgId: org, appId: app, attemptId: body.attempt, person: admin.id, personSub: admin.auth0Sub },
    { appId: app, teamId: body.workspace, teamName: body.workspace_name, botUserId: body.bot_user, scopes: body.granted_scopes, accessToken: body.bundle.accessToken },body.bundle.runtime);
  if (name === "resolve_slack_install") return await registry.resolve(app,body.workspace) ?? null;
  if (name === "current_slack_install") return registry.current(app,body.workspace,body.expected_generation);
  if (name === "refresh_slack_runtime") return registry.refresh(org,app,body.expected_generation,body.runtime);
  if (name === "deactivate_slack_install") return registry.deactivate(org,app,body.workspace,body.expected_generation,body.reason);
  throw new Error(`Unimplemented controlled registry RPC ${name}`);
}
const fixture = createServer(async (request,response) => {
  try {
    const url = new URL(request.url,"http://fixture");
    if (url.pathname === "/jwks") return json(response,200,{ keys: [jwk] });
    if (url.pathname === "/directory") {
      assert.equal(request.headers.apikey,"controlled-store-key");
      const sub = url.searchParams.get("auth0_sub")?.replace(/^eq\./,"");
      return json(response,200,users.filter(user => !sub || user.auth0Sub === sub).map(user => ({ auth0_sub: user.auth0Sub, org_id: user.orgId, active: user.active, user_id: user.id,
        name: user.name, email: user.email, role: user.role, groups: user.groups, contractor: user.contractor, platform_identities: user.platformIdentities })));
    }
    if (url.pathname.startsWith("/registry/")) {
      assert.equal(request.headers.apikey,"controlled-registry-key");
      return json(response,200,await rpc(url.pathname.split("/").at(-1),JSON.parse(await readBody(request))));
    }
    if (url.pathname === "/provider/authorize") {
      assert.equal(url.searchParams.get("client_id"),"controlled-client");
      assert.equal(url.searchParams.get("scope"),SLACK_BOT_SCOPES.join(","));
      assert.equal(url.searchParams.get("redirect_uri"),"https://customer-a.api.test/v1/admin/slack-installation/callback");
      const state = url.searchParams.get("state"); assert.match(state,/^[A-Za-z0-9_-]{43}$/);
      response.writeHead(200,{ "content-type": "text/html" });
      return response.end(`<html><body><h1>Controlled Slack consent</h1><form action="/test-consent"><input type="hidden" name="state" value="${state}"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></body></html>`);
    }
    if (url.pathname === "/provider/consent") {
      const callback = new URL("https://customer-a.api.test/v1/admin/slack-installation/callback"); callback.searchParams.set("state",url.searchParams.get("state"));
      if (url.searchParams.get("decision") === "deny") callback.searchParams.set("error","access_denied");
      else { const code = `controlled-consent-${++consentSequence}`; consentCodes.set(code,{ ...nextGrant }); callback.searchParams.set("code",code); }
      response.writeHead(302,{ location: callback.href }); return response.end();
    }
    if (url.pathname.startsWith("/customer/")) {
      const orgId = url.pathname.split("/")[2]; const runtime = testRuntime(orgId);
      assert.equal(request.headers["x-broppy-service"],runtime.serviceToken); assert.equal(request.headers["x-act-as-slack-email"],"maya@example.test");
      assert.equal(url.pathname,`/customer/${orgId}/v1/query`);
      workspaceCalls.push({ kind: "api", orgId });
      return json(response,200,{ text: `${orgId} authorized answer`, citations: [] });
    }
    if (url.pathname.startsWith("/taskstore/")) {
      const orgId = url.pathname.split("/")[2]; const path = url.pathname.split("/").slice(3).join("/"); const store = stores.get(orgId); assert(store);
      assert.equal(request.headers.apikey,testRuntime(orgId).storeKey);
      workspaceCalls.push({ kind: "store", orgId, path });
      if (path === "rpc/save_slack_proposal") { const body = JSON.parse(await readBody(request)); assert.equal(body.organization,orgId); return json(response,200,await store.saveProposal(body.proposal,body.expected_revision ?? undefined)); }
      if (path === "slack_claims") { const body = JSON.parse(await readBody(request)); assert.equal(body.org_id,orgId); return json(response,200,await store.claim(body.key) ? [{ key: body.key }] : []); }
      assert.equal(url.searchParams.get("org_id"),`eq.${orgId}`);
      if (path === "slack_task_proposals") { const proposal = await store.getProposal(url.searchParams.get("id").replace(/^eq\./,"")); return json(response,200,proposal ? [{ payload: proposal }] : []); }
      assert.equal(path,"slack_task_links"); assert.equal(url.searchParams.get("source->>teamId"),`eq.${orgId === "org-a" ? "TONE" : "TTWO"}`);
      return json(response,200,[]);
    }
    if (url.pathname.startsWith("/provider/respond/")) {
      const teamId = url.pathname.split("/").at(-1); const body = JSON.parse(await readBody(request));
      assert(body.text.includes(teamId === "TONE" ? "org-a" : "org-b")); workspaceCalls.push({ kind: "response", teamId }); return json(response,200,{ ok: true });
    }
    if (url.pathname.startsWith("/provider/api/")) {
      const method = url.pathname.split("/").at(-1); const raw = await readBody(request); const form = new URLSearchParams(raw);
      requests.push({ method, authorization: request.headers.authorization });
      if (method === "oauth.v2.access") {
        assert.equal(request.headers.authorization,`Basic ${Buffer.from("controlled-client:controlled-secret").toString("base64")}`);
        const grant = consentCodes.get(form.get("code")); consentCodes.delete(form.get("code"));
        return json(response,200,grant ? { ok: true, app_id: "AAPP", token_type: "bot", access_token: grant.token, bot_user_id: "UBOT", team: { id: grant.teamId, name: grant.teamName },
          scope: SLACK_BOT_SCOPES.join(","), authed_user: { id: "UMAYA" }, is_enterprise_install: false } : { ok: false, error: "invalid_code" });
      }
      const token = request.headers.authorization?.replace(/^Bearer /,"");
      const team = token === "xoxb-controlled-b" ? "TTWO" : "TONE";
      if (method === "auth.test") return json(response,200,{ ok: true, team_id: team, user_id: "UBOT", bot_id: "BBOT" });
      if (method === "chat.getPermalink") return json(response,200,{ ok: true, permalink: "https://controlled.slack.com/archives/CDB/p123" });
      if (method === "chat.postEphemeral") { const body = JSON.parse(raw); assert.equal(body.channel,"CDB"); assert.equal(body.user,"UMAYA"); workspaceCalls.push({ kind: "ephemeral", teamId: team }); return json(response,200,{ ok: true }); }
      if (method === "users.info") return json(response,200,{ ok: true, user: { id: form.get("user"), profile: { email: "maya@example.test" } } });
      throw new Error(`Unexpected provider method ${method}`);
    }
    json(response,404,{ error: "Controlled fixture route missing" });
  } catch (error) { console.error(error); json(response,500,{ error: "Controlled fixture failed" }); }
});
try {
  fixtureOrigin = await listen(fixture);
  globalThis.fetch = async (input,init) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.controlled.test" && url.pathname === "/.well-known/jwks.json") return realFetch(`${fixtureOrigin}/jwks`,init);
    if (url.hostname === "customer-a.store.test" && url.pathname === "/rest/v1/workspace_users") return realFetch(`${fixtureOrigin}/directory${url.search}`,init);
    if (url.hostname === "registry.controlled.test" && url.pathname.startsWith("/rest/v1/rpc/")) return realFetch(`${fixtureOrigin}/registry/${url.pathname.split("/").at(-1)}`,init);
    if (url.hostname === "slack.com" && url.pathname.startsWith("/api/")) return realFetch(`${fixtureOrigin}/provider/api/${url.pathname.split("/").at(-1)}`,init);
    if (["org-a.api.test","org-b.api.test"].includes(url.hostname)) return realFetch(`${fixtureOrigin}/customer/${url.hostname.split(".")[0]}${url.pathname}${url.search}`,init);
    if (["org-a.store.test","org-b.store.test"].includes(url.hostname)) return realFetch(`${fixtureOrigin}/taskstore/${url.hostname.split(".")[0]}/${url.pathname.slice("/rest/v1/".length)}${url.search}`,init);
    if (url.hostname === "hooks.slack.com" && url.pathname.startsWith("/controlled/")) return realFetch(`${fixtureOrigin}/provider/respond/${url.pathname.split("/").at(-1)}`,init);
    if (url.hostname === "127.0.0.1") return realFetch(input,init);
    throw new Error(`Unrecognized controlled provider boundary ${url.hostname}`);
  };
  Object.assign(process.env,{ ALLOW_DEMO_AUTH: "false", PUBLIC_DEMO: "false", AUTH0_ISSUER: "https://auth.controlled.test/", AUTH0_AUDIENCE: "broppy-api", AUTH0_ORG_ID: "org-a",
    SUPABASE_URL: "https://customer-a.store.test", SUPABASE_SECRET_KEY: "controlled-store-key", SLACK_REGISTRY_URL: "https://registry.controlled.test", SLACK_REGISTRY_SECRET_KEY: "controlled-registry-key",
    SLACK_APP_ID: "AAPP", SLACK_CLIENT_ID: "controlled-client", SLACK_CLIENT_SECRET: "controlled-secret", API_ORIGIN: "https://customer-a.api.test", WEB_ORIGIN: "https://customer-a.web.test",
    SLACK_SERVICE_TOKEN: "controlled-service-" + "s".repeat(32), JIRA_DEFAULT_PROJECT: "DB", JIRA_BASE_URL: "https://x.atlassian.net", SLACK_USERS_JSON: '[{"slackId":"UMAYA","name":"Maya"}]',
    SLACK_CHANNEL_PROJECTS_JSON: '{"CDB":"DB"}', SLACK_JIRA_DESTINATIONS_JSON: '[]', SLACK_COMPLETION_POLICY_JSON: '[]', SOURCE_OAUTH_JSON: "", LIVE_SOURCES_JSON: "", FGA_API_URL: "", FGA_STORE_ID: "", FGA_MODEL_ID: "",
    FGA_CLIENT_ID: "", FGA_CLIENT_SECRET: "", LLM_PROVIDER: "", EMBEDDING_PROVIDER: "", MOCK_DATA: "curated" });
  const api = await createApiServer({ brain: new Brain(undefined,{ corpus: "curated", users }), startOrchestrator: false, corpus: "curated" });
  const apiOrigin = await listen(api.server);
  const web = createServer(async (request,response) => {
    const url = new URL(request.url,"http://web");
    if (url.pathname.startsWith("/api/brain/")) {
      const session = request.headers.cookie?.includes("controlled-session=member") ? "ravi" : "maya";
      const result = await realFetch(`${apiOrigin}${url.pathname.slice("/api/brain".length)}${url.search}`,{ method: request.method, headers: { authorization: `Bearer ${tokens[session]}`, "content-type": "application/json" },
        body: ["GET","HEAD"].includes(request.method) ? undefined : await readBody(request), redirect: "manual" });
      response.writeHead(result.status,{ "content-type": "application/json", "cache-control": "no-store" }); return response.end(await result.text());
    }
    const file = url.pathname === "/workspace/connectors.html" ? "connectors.html" : url.pathname === "/workspace/connectors.js" ? "connectors.js" : url.pathname === "/workspace/styles.css" ? "styles.css" : undefined;
    if (!file) { response.writeHead(404); return response.end(); }
    response.writeHead(200,{ "content-type": file.endsWith("html") ? "text/html" : file.endsWith("js") ? "text/javascript" : "text/css" }); response.end(await readFile(new URL(`../apps/web/${file}`,import.meta.url)));
  });
  const webOrigin = await listen(web);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "controlled-session", value: "admin", url: webOrigin }]);
  const page = await context.newPage();
  const visibleBodies = [];
  const bodyReads = [];
  page.on("requestfailed", request => browserFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on("response", response => { if (response.url().includes("/api/brain/")) bodyReads.push(response.text().then(body => visibleBodies.push(body)).catch(() => {})); });
  await page.route("https://slack.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth/v2/authorize") {
      const response = await route.fetch({ url: fixtureOrigin + "/provider/authorize" + url.search, maxRedirects: 0 });
      return route.fulfill({ response });
    }
    if (url.pathname !== "/test-consent") return route.abort();
    const consent = await route.fetch({ url: fixtureOrigin + "/provider/consent" + url.search, maxRedirects: 0 });
    const callback = new URL(consent.headers().location);
    assert.equal(callback.origin,"https://customer-a.api.test");
    assert.equal(callback.pathname,"/v1/admin/slack-installation/callback");
    const response = await realFetch(apiOrigin + callback.pathname + callback.search,{ redirect: "manual" });
    assert.equal(response.status,302); assert.equal(response.headers.get("referrer-policy"),"no-referrer");
    const returned = new URL(response.headers.get("location"));
    assert.equal(returned.origin,"https://customer-a.web.test"); assert.equal(returned.pathname,"/workspace/connectors.html");
    redirects.push({ callbackPath: callback.pathname, callbackStatus: response.status, returnLocation: returned.href, callbackQuery: callback.search });
    await route.fulfill({ status: 302, headers: { location: webOrigin + returned.pathname + returned.search } });
  });
  const url = webOrigin + "/workspace/connectors.html";
  await page.goto(url); await page.getByRole("button",{ name: "Add to Slack", exact: true }).waitFor();
  assert.equal(await page.locator("#connections section").count(),4);
  await page.getByRole("button",{ name: "Add to Slack", exact: true }).click(); await page.getByRole("button",{ name: "Allow", exact: true }).click();
  await page.waitForURL(/slack_install=installed/); await page.getByText("Connected to Company A.",{ exact: true }).waitFor();
  assert.equal((await registry.resolve("AAPP","TONE")).runtime.orgId,"org-a");
  const replay = await realFetch(apiOrigin + redirects[0].callbackPath + redirects[0].callbackQuery,{ redirect: "manual" });
  assert.equal(replay.status,302); assert.equal(new URL(replay.headers.get("location")).searchParams.get("slack_install"),"failed");
  assert.equal((await registry.status("org-a","AAPP")).generation,1);
  await page.reload(); await page.getByText("Connected to Company A.",{ exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactDir,"installed.png"), fullPage: true });
  await page.getByRole("button",{ name: "Refresh workspace settings" }).click();
  await page.waitForFunction(async () => (await (await fetch("/api/brain/v1/admin/slack-installation")).json()).generation === 2);
  await page.getByRole("button",{ name: "Reinstall in Slack" }).click(); await page.getByRole("button",{ name: "Deny", exact: true }).click();
  await page.waitForURL(/slack_install=denied/); await page.getByText("Connected to Company A.",{ exact: true }).waitFor();
  assert.equal((await registry.status("org-a","AAPP")).generation,2);
  nextGrant = { teamId: "TTWO", teamName: "Other workspace", token: "xoxb-controlled-b" };
  await page.getByRole("button",{ name: "Reinstall in Slack" }).click(); await page.getByRole("button",{ name: "Allow", exact: true }).click();
  await page.waitForURL(/slack_install=conflict/); await page.getByText("Connected to Company A.",{ exact: true }).waitFor();
  assert.equal((await registry.resolve("AAPP","TONE")).accessToken,"xoxb-controlled-a");
  await page.getByRole("button",{ name: "Disconnect from Broppy" }).click(); await page.getByRole("button",{ name: "Add to Slack", exact: true }).waitFor();
  assert.equal(await registry.resolve("AAPP","TONE"),undefined);
  await page.reload(); await page.getByText("Company A is disconnected from Broppy.",{ exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactDir,"disconnected.png"), fullPage: true });
  await context.addCookies([{ name: "controlled-session", value: "member", url: webOrigin }]);
  await page.goto(url); await page.getByText("Forbidden",{ exact: true }).waitFor();
  const nonadmin = await realFetch(`${apiOrigin}/v1/admin/slack-installation/authorize`,{ method: "POST", headers: { authorization: `Bearer ${tokens.ravi}` } }); assert.equal(nonadmin.status,403);
  await Promise.all(bodyReads);
  assert(!visibleBodies.some(body => /xoxb-|controlled-service-|storeKey|accessToken|secret_id|controlled-registry-key/.test(body)),"Browser API responses must not expose installation secrets");
  await registry.seed("TONE","org-a","xoxb-controlled-a"); await registry.seed("TTWO","org-b","xoxb-controlled-b");
  const deferred = [];
  const gateway = new SlackGateway({ appId: "AAPP", signingSecret: "controlled-signing", registry, defer: work => deferred.push(work) });
  const gatewayServer = createServer(async (request,response) => { const result = await gateway.handle({ method: request.method, path: new URL(request.url,"http://gateway").pathname, headers: request.headers, rawBody: await readBody(request) }); json(response,result.status,result.body ?? null); });
  const gatewayOrigin = await listen(gatewayServer);
  async function signedHttp(path,raw) {
    const ts = String(Math.floor(Date.now()/1000)); const signature = `v0=${createHmac("sha256","controlled-signing").update(`v0:${ts}:${raw}`).digest("hex")}`;
    return realFetch(`${gatewayOrigin}/slack/${path}`,{ method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signature }, body: raw });
  }
  for (const teamId of ["TONE","TTWO"]) {
    const raw = JSON.stringify({ type: "event_callback", api_app_id: "AAPP", team_id: teamId, event: { type: "message", user: "UMAYA", channel: "CDB", ts: "1791195720.000100", text: "Agreed: Maya raises the replica storage quota before the final wave. Due Fri 16 Oct." } });
    assert.equal((await signedHttp("events",raw)).status,200);
    const command = new URLSearchParams({ api_app_id: "AAPP", team_id: teamId, user_id: "UMAYA", text: "What is authorized?", response_url: `https://hooks.slack.com/controlled/${teamId}` }).toString();
    assert.equal((await signedHttp("commands",command)).status,200);
  }
  await Promise.all(deferred);
  assert.deepEqual(workspaceCalls.filter(call => call.kind === "ephemeral").map(call => call.teamId),["TONE","TTWO"]);
  assert.deepEqual(workspaceCalls.filter(call => call.kind === "api").map(call => call.orgId),["org-a","org-b"]);
  assert.deepEqual(workspaceCalls.filter(call => call.kind === "response").map(call => call.teamId),["TONE","TTWO"]);
  for (const orgId of ["org-a","org-b"]) { const proposals = await stores.get(orgId).listProposals(); assert.equal(proposals.length,1); assert.equal(proposals[0].teamId,orgId === "org-a" ? "TONE" : "TTWO"); }
  const report = { boundary: "Controlled Auth0 JWKS/session, Slack provider, and plaintext in-memory registry adapter. Actual Connectors HTML/JS and API OAuth routes; provided Brain has mock source connectors. Browser hosting origins are mapped to loopback; actual callback Location and status are asserted before the loopback return redirect. No live Slack install or Vault encryption claim.",
    checks: ["admin Add to Slack consent/callback", "actual callback replay refused", "installed status after reload", "runtime refresh", "denial preserves installation", "pinned workspace refuses change", "local disconnect after reload", "nonadmin forbidden", "token-free browser API bodies", "two-org gateway signed HTTP with actual scoped Slack/API/store clients"],
    providerCalls: requests.map(({ method }) => method), workspaceCalls, redirects: redirects.map(({ callbackQuery, ...evidence }) => evidence), browserFailures, screenshots: ["installed.png","disconnected.png"] };
  await writeFile(resolve(artifactDir,"report.json"),JSON.stringify(report,null,2)+"\n"); console.log(JSON.stringify(report,null,2));
} finally {
  await writeFile(resolve(artifactDir,"navigation.json"),JSON.stringify({ redirects: redirects.map(({ callbackQuery, ...evidence }) => evidence), browserFailures },null,2)+"\n");
  globalThis.fetch = realFetch;
  await browser?.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
