import slackHandler from "@brain/slack/server";
import { SlackInstallationOAuth } from "./slack-installation.js";
import { slackUserIdsFromEnv } from "./slack-identity.js";
import { atlassianAccountIds } from "./atlassian-identity.js";
import { connectFailure, pageFor, returnLocation, splitReturnPage, withReturnPage } from "./connect-return.js";
import { SourceOAuth } from "./source-oauth.js";
import { Persistence, StaleState } from "./persistence.js";
import { waitUntil } from "@vercel/functions";
import { searchAudit } from "./audit-search.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Brain, type Corpus } from "./brain.js";
import { getTaskRoutes, taskCommandRoutes } from "./tasks.js";
import { SyncOrchestrator } from "./orchestrator.js";
import { AccessDenied, createAuth0TokenValidatorFromEnv, WorkspaceUnavailable, type Auth0TokenValidator } from "./auth.js";
import { companyLimitsFromEnv, companyModels, modelsFromEnv } from "./llm-budget.js";
import { CUSTOM_ADDRESS_REFUSED, ModelCheckFailed, OrgModel } from "./org-model.js";
import { UserDirectory } from "./user-directory.js";
import { Auth0Management } from "./auth0-management.js";
import { Companies } from "./companies.js";
import { isPersonalAddress, Signup, SignupError } from "./signup.js";
import { TenantRegistry } from "./tenants.js";
import { People, PeopleError } from "./people.js";
import { ServiceActor } from "./service-actor.js";
import { ActionLimit, AgentActions, parseHistory, understandTurn } from "./agent.js";
import { JiraAsUser, jiraRefusal, parseComment, parseIssue } from "./service-jira.js";
import { SupabaseTaskStore } from "../../slack/src/store.js";
import { LiveConnector, liveConnectorsFromEnv } from "@brain/connectors/live";
import { MockConnector, loadMockCorpus, type ImportScope } from "@brain/connectors";
import { AuditLog, FileAuditStore } from "@brain/audit";
import { RemoteFgaAdapter } from "@brain/fga-adapter";
import { SupabaseIndex } from "@brain/retrieval";
import type { AuditEntry, Source, SourcePermission, Tier, User } from "@brain/types";

/** Everything one company owns inside the API. */
interface Tenant {
  orgId: string;
  /** The company set up by hand with AUTH0_ORG_ID, which also has the Slack app and the service identity. */
  isHome: boolean;
  /** One person's own workspace, from personal sign-up: it has no team, so nobody else can be added. */
  personal: boolean;
  brain: Brain;
  orchestrator: SyncOrchestrator;
  directory?: UserDirectory;
  users?: User[];
  people?: People;
  oauth?: SourceOAuth;
  connectors?: Record<Source, MockConnector>;
  orgModel?: OrgModel;
  slackInstallation?: SlackInstallationOAuth;
  slackCombined: boolean;
  jiraAsUser?: JiraAsUser;
  applySite(source: Source): Promise<void>;
  reloadUsers(): Promise<void>;
  agentActions: AgentActions;
}

export interface ApiServer {
  /** The home company's brain. Other companies' workspaces are built when their first request arrives. */
  brain: Brain;
  orchestrator: SyncOrchestrator;
  server: Server;
  shutdown(): Promise<void>;
}

interface ApiServerOptions {
  brain?: Brain;
  startOrchestrator?: boolean;
  /** The mock data, in place of the one the settings choose (`corpusFromEnv`). */
  corpus?: Corpus;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "access-control-allow-headers": "content-type,x-demo-user,authorization",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": process.env.WEB_ORIGIN ?? "http://127.0.0.1:3001",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid body");
  }
  return parsed as Record<string, unknown>;
}

// Settings that connect real identities or data. A public demo must run without all of them.
const REAL_SETTINGS = ["AUTH0_ISSUER", "AUTH0_AUDIENCE", "AUTH0_ORG_ID", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "LIVE_SOURCES_JSON", "SOURCE_OAUTH_JSON", "FGA_API_URL", "FGA_STORE_ID", "FGA_MODEL_ID", "FGA_CLIENT_ID",
  "FGA_CLIENT_SECRET", "SLACK_APP_ID", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_REGISTRY_URL", "SLACK_REGISTRY_SECRET_KEY"];

/**
 * The mock data the API serves. The demo API serves the hand-written items and the generated company; the SSO API keeps
 * the hand-written items, because its people come from the directory, which doesn't have the generated company's groups.
 * MOCK_DATA=curated or demo chooses on the demo API.
 */
export function corpusFromEnv(env: NodeJS.ProcessEnv = process.env): Corpus {
  const sso = Boolean(env.AUTH0_ISSUER || env.AUTH0_AUDIENCE || env.AUTH0_ORG_ID);
  const value = env.MOCK_DATA || undefined;
  if (value !== undefined && value !== "curated" && value !== "demo") throw new Error("MOCK_DATA must be curated or demo");
  if (sso && value === "demo") {
    throw new Error("MOCK_DATA=demo is for the demo API; the SSO directory's people don't have the generated company's groups");
  }
  return value ?? (sso ? "curated" : "demo");
}

// PUBLIC_DEMO lets anyone pick a demo persona, so it only ever serves the fictional mock corpus.
function publicDemo(): boolean {
  if (process.env.PUBLIC_DEMO !== "true") return false;
  const real = REAL_SETTINGS.filter(name => process.env[name]);
  if (real.length) throw new Error(`PUBLIC_DEMO serves mock data only; remove ${real.join(", ")}`);
  return true;
}

async function identity(request: IncomingMessage, brain: Brain, auth0?: Auth0TokenValidator,
  allowDemo = true): Promise<User | undefined> {
  const authorization = request.headers.authorization;
  if (authorization) return auth0?.validate(authorization);
  if (auth0 || !allowDemo) return undefined;
  const demoHeaders = process.env.PUBLIC_DEMO === "true" ||
    (process.env.ALLOW_DEMO_AUTH === "true" && process.env.NODE_ENV !== "production");
  if (!demoHeaders) return undefined;
  const id = request.headers["x-demo-user"];
  return typeof id === "string" ? brain.user(id) : undefined;
}

/** The asker's own view of a query's trace: only documents they were allowed, and no trace ID. */
export function actorTrace(entries: AuditEntry[]): Array<Pick<AuditEntry, "sequence" | "timestamp" | "type" | "data">> {
  const answer = [...entries].reverse().find(entry => entry.type === "answer_returned");
  if (answer?.data.empty === true) {
    return [{ sequence: 1, timestamp: answer.timestamp, type: "answer_returned", data: { empty: true } }];
  }
  const allowedRefs = new Set(entries.filter(entry =>
    entry.type === "live_access_decision" && entry.data.allowed === true)
    .map(entry => entry.data.docRef));
  const visible = entries.filter(entry => {
    // A linked item shows only once it passed the live check, and only items the asker may open are followed.
    if (entry.type === "candidate_ranked" || entry.type === "candidate_linked" || entry.type === "access_decision") {
      return allowedRefs.has(entry.data.docRef) &&
        (entry.type !== "access_decision" || entry.data.allowed === true);
    }
    if (entry.type === "live_access_decision") return entry.data.allowed === true;
    return entry.type === "query_planned" || entry.type === "context_sent" || entry.type === "answer_returned";
  });
  return visible.map((entry, index) => {
    const data = { ...entry.data };
    delete data.traceId;
    // The asker learns why lines were left out, never what they said (D63), and nothing of a model reply set aside.
    if (entry.type === "answer_returned" && data.check && typeof data.check === "object") {
      const check = data.check as { lines?: unknown; removed?: Array<{ reason?: unknown }>; fallback?: unknown };
      data.check = { lines: check.lines, removed: check.fallback ? [] : (check.removed ?? []).map(item => ({ reason: item.reason })) };
    }
    return { sequence: index + 1, timestamp: entry.timestamp, type: entry.type, data };
  });
}

/** The audit signing key: the PEM itself in AUDIT_SIGNING_KEY (for hosts without a place for a key file, such as Vercel; line breaks may be written as \n), or the file at AUDIT_SIGNING_KEY_FILE. */
function auditSigningKey(requiredBy: string): Buffer {
  const pem = process.env.AUDIT_SIGNING_KEY?.trim();
  if (pem) return Buffer.from(pem.replace(/\\n/g, "\n"));
  const keyPath = process.env.AUDIT_SIGNING_KEY_FILE;
  if (!keyPath) throw new Error(`AUDIT_SIGNING_KEY or AUDIT_SIGNING_KEY_FILE is required ${requiredBy}`);
  return readFileSync(keyPath);
}

async function configuredAudit(persistence?: Persistence): Promise<AuditLog> {
  if (persistence) {
    return new AuditLog({ orgId: persistence.orgId, signingKey: auditSigningKey("for durable audit"), initial: await persistence.loadAudit(),
      persist: (kind, value) => persistence.appendAudit(kind, value), reload: () => persistence.loadAudit() });
  }
  const path = process.env.AUDIT_LOG_PATH;
  if (!path) return new AuditLog();
  return new AuditLog({ store: new FileAuditStore(path), signingKey: auditSigningKey("with AUDIT_LOG_PATH") });
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  const demoOnly = publicDemo();
  const corpus = options.corpus ?? corpusFromEnv();
  const hasAuth0 = Boolean(process.env.AUTH0_ISSUER || process.env.AUTH0_AUDIENCE || process.env.AUTH0_ORG_ID);
  const directory = UserDirectory.fromEnv();
  if (hasAuth0 && !directory) throw new Error("Auth0 requires the Supabase user directory");
  if (!hasAuth0 && !demoOnly && (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_AUTH !== "true")) {
    throw new Error("Auth0 configuration required when demo authentication is disabled");
  }
  const useRemoteFga = Boolean(process.env.FGA_API_URL || process.env.FGA_STORE_ID ||
    process.env.FGA_MODEL_ID || process.env.FGA_CLIENT_ID || process.env.FGA_CLIENT_SECRET);
  const models = modelsFromEnv(process.env);
  // A mistyped company allowance stops startup, rather than leaving companies without one.
  companyLimitsFromEnv();
  const embedding = models.embedding;
  const oauthConfigs = process.env.SOURCE_OAUTH_JSON ? JSON.parse(process.env.SOURCE_OAUTH_JSON) : undefined;
  if (oauthConfigs && process.env.LIVE_SOURCES_JSON) throw new Error("Choose OAuth or manually managed source credentials");
  if (oauthConfigs && (options.brain || !process.env.SUPABASE_URL)) throw new Error("Source OAuth requires Supabase persistence");
  if ((process.env.SLACK_APP_ID || process.env.SLACK_CLIENT_ID || process.env.SLACK_CLIENT_SECRET) && !hasAuth0) throw new Error("Slack onboarding requires Auth0 and the active user directory");
  const management = hasAuth0 ? Auth0Management.fromEnv() : undefined;
  const signupMode = hasAuth0 ? Signup.mode() : "off";
  const companies = signupMode !== "off" ? Companies.fromEnv() : undefined;
  // The Slack service secret is kept in Supabase Vault (migration 017) unless it is set on the API itself.
  if (companies && process.env.SLACK_APP_ID && !process.env.SLACK_SERVICE_TOKEN) {
    const token = await companies.vaultSecret("broppy_slack_service_token").catch(() => undefined);
    if (token) process.env.SLACK_SERVICE_TOKEN = token;
  }
  if (signupMode !== "off") {
    // Another company's workspace reads its sources through the same Broppy app registrations, so those must be set.
    if (!companies || !management || !oauthConfigs || !process.env.AUTH0_SIGNUP_CONNECTION_ID) {
      throw new Error("SELF_SIGNUP needs the Supabase directory, Auth0 invitations (AUTH0_MANAGEMENT_CLIENT_ID and SECRET), SOURCE_OAUTH_JSON and AUTH0_SIGNUP_CONNECTION_ID");
    }
  }
  // A company that signed itself up can use Anthropic or OpenAI but not point the API at an address of its own: the API would
  // call that address from inside its own network. Only the company set up by hand may.
  const orgModelOf = (persistence: Persistence | undefined, isHome: boolean) => persistence ? new OrgModel(persistence, undefined, undefined, { customAddress: isHome }) : undefined;

  /**
   * Whether a signed-up workspace is personal. Sign-up records it; a workspace from before that was recorded is worked out
   * once from its Auth0 address and written back. If neither can be read it counts as a company, which only shows the
   * team step and allows invitations, as before.
   */
  const personalWorkspace = async (orgId: string): Promise<boolean> => {
    if (!companies) return false;
    try {
      const recorded = await companies.kind(orgId);
      if (recorded) return recorded === "personal";
      if (!management) return false;
      const kind = isPersonalAddress((await management.forOrg(orgId).organization()).name) ? "personal" : "company";
      await companies.recordKind(orgId, kind).catch(() => undefined);
      return kind === "personal";
    } catch { return false; }
  };

  /** Everything one company owns: its people, its sources, its brain and its sign-in rules. Nothing here is shared between companies. */
  const buildTenant = async (orgId: string, isHome: boolean): Promise<Tenant> => {
    const tenantDirectory = isHome ? directory : directory?.forOrg(orgId);
    const users = hasAuth0 ? await tenantDirectory!.list() : undefined;
    const persistence = options.brain ? undefined : Persistence.fromEnv(orgId);
    // A signed-up company uses the built-in or operator model within its own allowance as well as the shared budget.
    const own = isHome ? models : companyModels(models, orgId);
    const supabase = embedding ? SupabaseIndex.fromEnv(isHome ? undefined : orgId) : null;
    const oauth = oauthConfigs && persistence ? new SourceOAuth(oauthConfigs, process.env.API_ORIGIN ?? "http://127.0.0.1:3000", persistence) : undefined;
    // Every company can add the shared Slack app to its own Slack. A company that signed itself up is given its own service secret.
    const slackInstallation = !directory ? undefined : isHome ? SlackInstallationOAuth.fromEnv(process.env, sub => directory.bySub(sub))
      : SlackInstallationOAuth.forCompany(process.env, orgId, sub => tenantDirectory!.bySub(sub), async () => (await oauth?.orgSite("jira"))?.baseUrl,
        () => [...brain.slackRoutes.values()]);
    const accountIds = oauth ? atlassianAccountIds(oauth) : undefined;
    const connectors = (isHome ? liveConnectorsFromEnv(users ?? loadMockCorpus().users) : undefined) ?? (oauth ? Object.fromEntries(
      (["slack", "jira", "confluence", "drive"] as Source[]).map(source => [source, oauthConfigs[source] ? new LiveConnector(source, {
        ids: [], serviceAuthorization: "", userAuthorizations: {}, discover: true, baseUrl: oauthConfigs[source].baseUrl, cloudId: oauthConfigs[source].cloudId,
        authorization: oauth.provider(source), atlassianAccountId: accountIds, linkOrigins: oauthConfigs[source].linkOrigins
      }, users ?? []) : new MockConnector(source, [])])) as Record<Source, MockConnector> : undefined);
    if (connectors && !hasAuth0) {
      throw new Error("Live sources require Auth0 sign-in");
    }
    // A company that signed itself up never sees the sample data: without live sources it has nothing to show.
    if (!isHome && !connectors) throw new Error("Live sources are not configured");
    // One consent installs Broppy in Slack and connects Slack as a source, when both use the same Slack app.
    const slackConfig = oauthConfigs?.slack;
    const slackCombined = Boolean(oauth && slackInstallation && slackConfig && slackConfig.clientId === slackInstallation.config.clientId);
    if (isHome && oauth && slackInstallation && slackConfig && !slackCombined) console.warn("SLACK_CLIENT_ID differs from the slack entry in SOURCE_OAUTH_JSON; Slack is installed and connected in two steps");
    const orgModel = orgModelOf(persistence, isHome);
    const brain = isHome && options.brain ? options.brain : new Brain(own.llm,
      { orgLlm: orgModel, orgId: isHome ? process.env.AUTH0_ORG_ID : orgId, persistence, audit: await configuredAudit(persistence),
        remoteFga: useRemoteFga ? RemoteFgaAdapter.fromEnv(process.env, isHome ? undefined : orgId) : undefined, embedding: own.embedding, supabase: supabase ?? undefined,
        taskStore: persistence && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
          ? new SupabaseTaskStore(persistence.orgId, process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY) : undefined,
        slackUserIds: isHome ? slackUserIdsFromEnv() : undefined, users, connectors, corpus });
    // Atlassian sites are found when someone signs in; reconnect each connector to its stored site after a restart.
    const applySite = async (source: Source) => {
      const connector = connectors?.[source];
      const site = oauth && connector instanceof LiveConnector ? await oauth.orgSite(source) : undefined;
      if (site) (connector as LiveConnector).useSite(site);
    };
    for (const source of ["jira", "confluence"] as Source[]) await applySite(source);
    if (oauth) for (const connection of brain.connections.values()) connection.status = "Not connected";
    await brain.restore();
    if (slackCombined) slackInstallation!.link = { scopes: slackConfig.scopes,
      // The bot only ever sees channels someone invited it to, so adding it already says what to read.
      store: async (admin, grant) => { await oauth!.storeGrant("slack", admin, grant); await brain.change(async () => { brain.markConnected(admin, "slack", { mode: "all" }); await brain.persist(); }); },
      discard: async () => { await oauth!.remove("slack"); } };
    // On a serverless host the function may stop once a reply is sent; imports keep it running until they finish.
    if (process.env.VERCEL) brain.onBackground = work => waitUntil(work);
    const jiraAsUser = oauth ? new JiraAsUser(oauth, accountIds) : undefined;
    // With live sources, the workspace creates and closes Jira tasks through the same shared connection.
    if (jiraAsUser && connectors && oauthConfigs?.jira) brain.liveJira = jiraAsUser;
    const people = hasAuth0 ? new People(tenantDirectory!, isHome ? management : management?.forOrg(orgId)) : undefined;
    // The directory is also the in-memory list of people the brain knows; reload it after the admin changes who is on it.
    const reloadUsers = async () => { users!.splice(0, users!.length, ...await tenantDirectory!.list()); };
    const orchestrator = new SyncOrchestrator(brain, connectors ? 300_000 : 30_000);
    // With live sources the saved workspace is loaded above and the scheduled background sync keeps it current, so a
    // person's first request never waits on reading every source (or on finishing a reading a stopped copy left).
    if (options.startOrchestrator === false && !connectors) {
      // A source that isn't connected yet, or is briefly down, is recorded on its own connection. It must not stop the
      // whole API from starting: the admin connects sources from the running API, so refusing to start would lock them out.
      await brain.syncAll().catch(error => {
        const reasons = error instanceof AggregateError ? error.errors.map(e => e instanceof Error ? e.message : String(e)) : [String(error)];
        console.warn(`Source synchronization incomplete at startup: ${reasons.join("; ")}`);
      });
    }
    if (options.startOrchestrator ?? true) orchestrator.start();
    return { orgId, isHome, personal: !isHome && await personalWorkspace(orgId), brain, orchestrator, directory: tenantDirectory, users, people, oauth, connectors, orgModel, slackInstallation, slackCombined,
      jiraAsUser, applySite, reloadUsers, agentActions: new AgentActions() };
  };

  const home = await buildTenant(process.env.AUTH0_ORG_ID ?? "", true);
  const tenants = new TenantRegistry<Tenant>({
    homeOrgId: process.env.AUTH0_ORG_ID ?? "", home,
    isKnown: async orgId => Boolean(companies) && await companies!.isKnown(orgId),
    build: orgId => buildTenant(orgId, false),
    drop: tenant => tenant.orchestrator.stop()
  });
  const { brain, orchestrator } = home;
  const serviceActor = ServiceActor.fromEnv(directory);
  const actionsOn = AgentActions.enabled();
  // At someone's first sign-in their accounts at the sources are completed and their access read at once, so they don't
  // wait for the hourly permission pass. Capped, so a slow source never holds up the sign-in.
  const onFirstSignIn = async (person: User) => {
    const tenant = await tenants.get(person.orgId);
    if (!tenant?.people) return;
    await tenant.people.ensureIdentities(person);
    await Promise.race([tenant.brain.refreshAccessFor(person, 8_000), new Promise(resolve => setTimeout(resolve, 10_000))]);
  };
  const auth0 = hasAuth0 ? createAuth0TokenValidatorFromEnv(async orgId => (await tenants.get(orgId))?.directory, onFirstSignIn) : undefined;
  const signup = signupMode !== "off" ? new Signup(management!, companies!, orgId => directory!.forOrg(orgId),
    { connectionId: process.env.AUTH0_SIGNUP_CONNECTION_ID!, accessCode: process.env.SIGNUP_ACCESS_CODE || undefined, open: signupMode === "on",
      onCreated: orgId => tenants.markKnown(orgId) }) : undefined;

  // The background sync's secret from Supabase Vault, when it isn't set on the API itself; re-read every 5 minutes.
  let cronSecret: { value?: string; at: number } = { at: 0 };
  const vaultCronSecret = async (): Promise<string | undefined> => {
    if (!companies) return undefined;
    if (Date.now() - cronSecret.at > 300_000) cronSecret = { value: await companies.vaultSecret("broppy_sync_cron_secret").catch(() => undefined), at: Date.now() };
    return cronSecret.value;
  };

  const server = createServer(async (request, response) => {
    let actor: User | undefined;
    // The company this request belongs to, once known. Until then, only the home company's log is touched.
    let current: Tenant = home;
    const reply = async (response: ServerResponse, status: number, data: unknown) => {
      // A refused request is part of the trail too. Only the actor, method and route are recorded, never the body.
      if (status === 403 && actor) {
        current.brain.audit.append("request_denied", actor.id, { method: request.method, path: new URL(request.url ?? "/", "http://localhost").pathname });
        await current.brain.audit.flush();
      }
      // Reads change no state, so they don't rewrite the whole snapshot (audit entries are flushed on their own). A question is
      // a read: rewriting every document and vector to the database after each answer took seconds, and anything a question
      // refreshes is checked at the source again on the next one.
      const reads = request.method === "GET" || (request.method === "POST" && new URL(request.url ?? "/", "http://localhost").pathname === "/v1/query");
      if (status >= 200 && status < 300) await (reads ? current.brain.audit.flush() : current.brain.persist());
      send(response, status, data);
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "OPTIONS") return await reply(response, 204, null);
      // The scheduled background sync (Supabase pg_cron calls this every ten minutes). It needs
      // the shared SYNC_CRON_SECRET, syncs the companies with connected sources, least recently synced first, and stops
      // before the function's time runs out; the next run carries on from the companies it didn't reach.
      if (url.pathname === "/v1/cron/sync" && (request.method === "POST" || request.method === "GET")) {
        const secret = process.env.SYNC_CRON_SECRET ?? process.env.CRON_SECRET ?? await vaultCronSecret();
        const given = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
        const ok = Boolean(secret) && given.length === secret!.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret!));
        if (!ok) return send(response, secret ? 401 : 404, { error: secret ? "Unauthorized" : "Not found" });
        const started = Date.now();
        const budget = Number(process.env.SYNC_CRON_BUDGET_MS ?? 40_000);
        const orgs = companies ? await companies.withConnectedSources() : [];
        if (!companies && home.connectors) orgs.push(home.orgId);
        const synced: Array<{ orgId: string; results: Array<{ source: Source; ok: boolean; error?: string }> }> = [];
        const left: string[] = [];
        for (const orgId of orgs) {
          if (Date.now() - started > budget) { left.push(orgId); continue; }
          try {
            const tenant = await tenants.get(orgId);
            if (!tenant) continue;
            await tenant.brain.refreshIfStale();
            synced.push({ orgId, results: await tenant.brain.syncConnected() });
          } catch (error) {
            synced.push({ orgId, results: [{ source: "slack" as Source, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "Sync failed" }] });
          }
        }
        console.info(JSON.stringify({ event: "background_sync", companies: synced.length, left: left.length, failed: synced.filter(item => item.results.some(result => !result.ok)).length, ms: Date.now() - started }));
        return send(response, 200, { synced: synced.map(item => ({ orgId: item.orgId, results: item.results })), left: left.length });
      }

      // Open to anyone, so it says only that the API is up. Each company's own sync state is at /v1/sync-health.
      if (request.method === "GET" && url.pathname === "/health") return await reply(response, 200, { ok: true });

      // A company signing itself up, and a person finding their company at sign-in. Both are open to anyone, so they
      // are limited, answer the same whoever asks, and give nothing away about the people or data inside a company.
      if (signup && url.pathname === "/v1/signup" && request.method === "POST") {
        return send(response, 202, await signup.create(await body(request)));
      }
      if (signup && url.pathname === "/v1/companies/find" && request.method === "GET") {
        const email = url.searchParams.get("email");
        const found = email !== null ? await signup.findPersonal(email) : await signup.find(url.searchParams.get("name"));
        if (found && "ambiguous" in found) return send(response, 409, { error: "Several companies have that name.", code: "ambiguous" });
        return send(response, found ? 200 : 404, found ?? { error: "We couldn't find that company." });
      }

      const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3001";
      if (url.pathname === "/v1/admin/slack-installation/callback" && request.method === "GET") {
        const returned = splitReturnPage(url.searchParams.get("state") ?? "");
        // The company rides on the state. A made-up one finds no stored attempt, since attempts are looked up inside that company.
        const owner = returned.company ? await tenants.get(returned.company).catch(() => undefined) : home;
        const slackInstallation = owner?.slackInstallation ?? home.slackInstallation;
        if (!slackInstallation) return await reply(response, 404, { error: "Slack onboarding is not configured" });
        if (returned.company && !owner?.slackInstallation) console.warn(JSON.stringify({ event: "slack_install_refused", org: returned.company, reason: "company has no Slack setup" }));
        await owner?.brain.refreshIfStale().catch(() => false);
        const outcome = returned.company && !owner?.slackInstallation ? "failed" : await slackInstallation.callback({ state: returned.state, code: url.searchParams.get("code") ?? "", error: url.searchParams.get("error") ?? "" })
          .catch(error => {
            console.error(JSON.stringify({ event: "slack_install_failed", org: returned.company ?? "home", error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
            return "failed" as const;
          });
        const destination = new URL(returned.page === "setup" ? returnLocation(webOrigin, "setup", {}) : slackInstallation.returnUrl);
        destination.searchParams.set("slack_install", outcome);
        response.writeHead(302, { location: destination.href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        response.end(); return;
      }

      const callback = /^\/v1\/admin\/connections\/(slack|jira|confluence|drive)\/callback$/.exec(url.pathname);
      if (callback && request.method === "GET" && home.oauth && home.directory) {
        const source = callback[1] as Source;
        const returned = splitReturnPage(url.searchParams.get("state") ?? "");
        // A person who turns the approval down, or whose account doesn't match, comes back to the page with a reason to show.
        let location: string;
        try {
          // The company comes from the state; the stored single-use state is then looked up inside that company only.
          const owner = returned.company ? await tenants.get(returned.company) : home;
          if (!owner?.oauth || !owner.directory) throw new Error("Invalid OAuth state");
          await owner.brain.refreshIfStale();
          const { user: approved, sources: connected } = await owner.oauth.completeAll(source, returned.state, url.searchParams.get("code") ?? "", sub => owner.directory!.bySub(sub));
          // One Atlassian approval can connect both Jira and Confluence.
          for (const item of connected) await owner.applySite(item);
          await owner.brain.change(async () => { for (const item of connected) owner.brain.markConnected(approved, item); await owner.brain.persist(); });
          location = returnLocation(webOrigin, returned.page, { connected: connected.join(",") });
        } catch (error) {
          // The reason is Broppy's own error message, never a token or code.
          console.warn(JSON.stringify({ event: "source_connect_failed", source, company: returned.company ?? null,
            sourceError: (url.searchParams.get("error") ?? "").slice(0, 60), cause: (error instanceof Error ? error.message : "unknown").slice(0, 200) }));
          location = returnLocation(webOrigin, returned.page, { connect_failed: source, reason: connectFailure(error, url.searchParams.get("error") ?? "") });
        }
        response.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        response.end(); return;
      }

      // The Slack app acts as the Slack user's own Broppy user, for questions and Jira writes only. Any other request carrying the
      // service header is refused rather than falling back to another identity.
      const service = serviceActor?.present(request) === true;
      const serviceRoutes = ["/v1/query", "/v1/service/actor", "/v1/service/jira/access", "/v1/service/jira/issue", "/v1/service/jira/comment"];
      if (service && !(request.method === "POST" && serviceRoutes.includes(url.pathname))) {
        return await reply(response, 403, { error: "Forbidden" });
      }
      // Who is asking, and which company's workspace they are asking in. A person from a company that is not listed is turned away.
      const authenticate = async (): Promise<{ person: User; tenant: Tenant } | undefined> => {
        const person = await (service ? serviceActor!.resolve(request) : identity(request, home.brain, auth0, !home.connectors));
        if (!person) return undefined;
        const tenant = hasAuth0 ? await tenants.get(person.orgId) : home;
        if (!tenant) return undefined;
        // Another instance may have changed this workspace since this one loaded it.
        await tenant.brain.refreshIfStale().catch(error => { throw new WorkspaceUnavailable(error); });
        // Another instance may have added or linked this person after this one loaded the directory.
        if (tenant.users) {
          const known = tenant.users.findIndex(item => item.id === person.id);
          if (known < 0) tenant.users.push(person); else if (tenant.users[known].auth0Sub !== person.auth0Sub) tenant.users[known] = person;
        }
        return { person, tenant };
      };
      const resolve = async () => (await authenticate())?.person;
      const identified = await authenticate();
      if (!identified) return await reply(response, 401, { error: "Unauthorized" });
      const user = identified.person;
      const tenant = identified.tenant;
      current = tenant;
      const { brain, oauth, directory, users, people, connectors, orgModel, slackInstallation, slackCombined, jiraAsUser, applySite, reloadUsers, agentActions } = tenant;
      actor = user;

      if (url.pathname === "/v1/admin/slack-installation" || url.pathname.startsWith("/v1/admin/slack-installation/")) {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const route = url.pathname.slice("/v1/admin/slack-installation".length);
        if (!slackInstallation) return await reply(response, request.method === "GET" && !route ? 200 : 503,
          request.method === "GET" && !route ? { state: "not_installed", configured: false } : { error: "Add to Slack is not available in this workspace yet." });
        if (request.method === "GET" && !route) return await reply(response, 200, await slackInstallation.status(user));
        if (request.method === "POST" && route === "/authorize") {
          const page = pageFor((await body(request).catch((): Record<string, unknown> => ({}))).via);
          return await reply(response, 200, { url: withReturnPage(await slackInstallation.begin(user), page, tenant.isHome ? undefined : tenant.orgId) });
        }
        if ((request.method === "POST" && route === "/refresh") || (request.method === "DELETE" && !route)) {
          const input = await body(request);
          if (typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 1) return await reply(response, 400, { error: "Reload the Slack installation status and try again." });
          const changed = request.method === "DELETE" ? await slackInstallation.disconnect(user, input.generation) : await slackInstallation.refresh(user, input.generation);
          return await reply(response, changed ? 200 : 409, changed ? { ok: true } : { error: "The Slack installation changed. Reload and try again." });
        }
        return await reply(response, 404, { error: "Not found" });
      }

      // Which Slack channels send their agreed tasks to which Jira project. The company named in the deployment declares
      // its Slack setup in environment settings instead, so it can only read this.
      if (url.pathname === "/v1/admin/slack-routing" && (request.method === "GET" || request.method === "PUT")) {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const jiraSite = Boolean(await oauth?.orgSite("jira").catch(() => undefined));
        if (request.method === "GET") return await reply(response, 200, { ...brain.slackRouting(user), jiraConnected: jiraSite, managedByDeployment: tenant.isHome });
        if (tenant.isHome) return await reply(response, 409, { error: "This company's Slack-to-Jira routes are set in its deployment settings." });
        const input = await body(request);
        if (typeof input.channel !== "string" || (input.project !== null && typeof input.project !== "string")) throw new Error("Invalid route");
        const project = input.project === null ? undefined : input.project as string;
        // Checked before asking Slack who is in the channel, so only channels Broppy already reads are ever looked up.
        if (!brain.slackRouting(user).channels.some(channel => channel.id === input.channel)) throw new Error("Broppy doesn't read that Slack channel");
        if (project && !jiraSite) return await reply(response, 409, { error: "Connect Jira before sending Slack tasks to it." });
        const slack = connectors?.slack;
        if (project && !(slack instanceof LiveConnector)) return await reply(response, 409, { error: "Connect Slack before sending its tasks to Jira." });
        const audience = project ? await (slack as LiveConnector).slackChannelMembers(input.channel) : [];
        await brain.routeSlackChannel(user, input.channel, project, audience);
        const published = slackInstallation ? await slackInstallation.publish(user).catch(error => {
          console.warn(JSON.stringify({ event: "slack_routing_publish_failed", org: tenant.orgId, error: error instanceof Error ? error.message : String(error) }));
          return false;
        }) : false;
        return await reply(response, 200, { ok: true, published, audience: audience.length });
      }

      if (service && url.pathname === "/v1/service/actor") return await reply(response, 200, { active: true });
      if (service && url.pathname === "/v1/service/jira/access") {
        if (!jiraAsUser) return await reply(response, 404, { error: "Source OAuth is not configured" });
        const input = await body(request);
        if (typeof input.key !== "string" || !/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(input.key)) throw new Error("Invalid issue");
        const result = await jiraAsUser.access(user, input.key);
        return await reply(response, result ? 200 : 409, result ?? { error: "Jira access unavailable" });
      }

      if (request.method === "GET" && url.pathname === "/v1/me") {
        // Someone can belong to several companies, so say which one this session is in.
        const company = tenant.isHome ? undefined : tenant.personal ? "Personal workspace"
          : await companies?.name(tenant.orgId).catch(() => undefined);
        return await reply(response, 200, { id: user.id, name: user.name, role: user.role, groups: user.groups, ...(company ? { company } : {}) });
      }

      if (service && (url.pathname === "/v1/service/jira/issue" || url.pathname === "/v1/service/jira/comment")) {
        if (!jiraAsUser) return await reply(response, 404, { error: "Source OAuth is not configured" });
        const input = await body(request);
        if (url.pathname === "/v1/service/jira/issue") {
          const parsed = parseIssue(input);
          if (parsed.assigneeEmail) {
            // The bot knows the owner's Slack email; their Jira email may differ, and Broppy's profile records both.
            const email = parsed.assigneeEmail.trim().toLowerCase();
            const owner = brain.users.find(person => person.active !== false && person.orgId === user.orgId &&
              [person.platformIdentities?.slack, person.email].some(value => value?.trim().toLowerCase() === email));
            parsed.assigneeEmail = owner?.platformIdentities?.jira || owner?.email || email;
          }
          const issue = await jiraAsUser.createIssue(user, parsed);
          if (!issue) return await reply(response, 409, { error: "Jira is not connected" });
          brain.audit.append("jira_issue_created_from_slack", user.id, { key: issue.key, via: "shared_connection" });
          return await reply(response, 201, issue);
        }
        const comment = parseComment(input);
        if (!await jiraAsUser.comment(user, comment.key, comment.text)) return await reply(response, 409, { error: "Jira is not connected" });
        brain.audit.append("jira_comment_added_from_slack", user.id, { key: comment.key });
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/query") {
        const input = await body(request);
        if (typeof input.question !== "string") throw new Error("Invalid question");
        if (input.project !== undefined && (typeof input.project !== "string" || !input.project || input.project.length > 64)) throw new Error("Invalid project");
        // The model (or fixed patterns without one) decides before any retrieval whether this is small talk, a ticket to prepare
        // or a question for the sources. The Slack app keeps the plain question path.
        const history = service ? [] : parseHistory(input.history);
        const turn = service ? { kind: "question" as const, question: input.question }
          : await understandTurn(await brain.conversationModel(), history, input.question);
        if (turn.kind === "chat" || (turn.kind === "action" && !actionsOn)) {
          brain.audit.append("chat_turn", user.id, { kind: turn.kind });
          const text = turn.kind === "chat" ? turn.reply : "Creating tickets from the chat is switched off for this workspace.";
          return await reply(response, 200, { text, citations: [], kind: "chat" });
        }
        if (turn.kind === "action") {
          brain.audit.append("agent_action_proposed", user.id, { type: "jira_issue", proposalId: turn.proposal.id });
          return await reply(response, 200, { text: "I can prepare this Jira ticket. Check the details, say which project it belongs to, then confirm. Nothing is created until you do.",
            citations: [], kind: "action", proposal: { type: "jira_issue", ...turn.proposal } });
        }
        let traceId: string | undefined;
        const answer = await brain.query(user, turn.question, id => { traceId = id; },
          resolve, { project: input.project as string | undefined });
        return await reply(response, 200, { ...answer, traceId, importNotice: brain.importNotice() });
      }

      // The person's confirmation of a ticket the chat prepared. The model never calls this; only the person's button does.
      if (request.method === "POST" && url.pathname === "/v1/actions/jira-issue") {
        if (!actionsOn) return await reply(response, 403, { error: "Creating tickets from the chat is switched off for this workspace." });
        if (!jiraAsUser) return await reply(response, 409, { error: "Jira is not connected" });
        const input = await body(request);
        if (typeof input.proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.proposalId)) throw new Error("Invalid issue");
        const issue = parseIssue(input);
        let created: { key: string; url: string } | undefined;
        try {
          created = await agentActions.once(user.id, input.proposalId, () => jiraAsUser.createIssue(user, issue));
        } catch (error) {
          if (error instanceof ActionLimit) return await reply(response, 429, { error: "You have created a lot of tickets this hour. Try again later." });
          brain.audit.append("agent_action_failed", user.id, { type: "jira_issue", proposalId: input.proposalId });
          throw error;
        }
        if (!created) return await reply(response, 409, { error: "Jira is not connected" });
        brain.audit.append("agent_action_executed", user.id, { type: "jira_issue", proposalId: input.proposalId, key: created.key, project: issue.project });
        return await reply(response, 201, created);
      }

      if (request.method === "GET" && url.pathname === "/v1/trace") {
        const traceId = url.searchParams.get("traceId") ?? brain.lastTraceIds.get(user.id);
        if (!traceId) return await reply(response, 404, { error: "Not found" });
        const entries = brain.audit.entries.filter(entry => entry.data.traceId === traceId &&
          (entry.actor === user.id || user.role === "compliance"));
        return entries.length ? send(response, 200, {
          traceId,
          entries: user.role === "compliance" ? entries : actorTrace(entries)
        }) : send(response, 404, { error: "Not found" });
      }

      if (url.pathname === "/v1/admin/access/refresh" && request.method === "POST") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        if (!people) return await reply(response, 404, { error: "Admin-managed sign-in needs Auth0 and the Supabase user directory." });
        const input = await body(request);
        const from = typeof input.from === "number" && Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        // The first call completes missing source accounts; later calls only carry on reading from where the last stopped.
        const filled = from === 0 ? await people.fillMissingIdentities() : 0;
        if (from === 0) await reloadUsers();
        const result = await brain.refreshAllAccess(user, 25_000, from);
        return await reply(response, 200, { ...result, identitiesFilled: filled });
      }

      const personRoute = /^\/v1\/admin\/people(?:\/([a-z0-9-]{1,64})(?:\/(invite|check|identities))?)?$/.exec(url.pathname);
      if (personRoute) {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        if (!people) return await reply(response, 404, { error: "Admin-managed sign-in needs Auth0 and the Supabase user directory." });
        const [, id, verb] = personRoute;
        if (!id && request.method === "GET") return await reply(response, 200, { people: await people.list(), invitations: people.canInvite });
        if (!id && request.method === "POST") {
          if (tenant.personal) return await reply(response, 409, { error: "A personal workspace is just for you. Sign up a company to work with a team." });
          const result = await people.add(user, await body(request));
          brain.audit.append("person_added", user.id, { userId: result.person.id, role: result.person.role, auth0: result.auth0 });
          await reloadUsers();
          return await reply(response, 201, result);
        }
        if (id && verb === "invite" && request.method === "POST") {
          const result = await people.invite(user, id);
          brain.audit.append("person_invited", user.id, { userId: id, auth0: result.auth0 });
          return await reply(response, 200, result);
        }
        if (id && verb === "identities" && request.method === "POST") {
          const input = await body(request);
          const { person, user: updated } = await people.setIdentities(id, input.identities);
          brain.audit.append("person_identities_changed", user.id, { userId: id, sources: Object.keys(input.identities as object) });
          await reloadUsers();
          const access = await brain.refreshAccessFor(updated, 15_000);
          return await reply(response, 200, { person, access });
        }
        if (id && verb === "check" && request.method === "POST") {
          const person = (await directory!.list()).find(item => item.id === id);
          if (!person) return await reply(response, 404, { error: "Not found" });
          const checks: Record<string, string> = {};
          for (const source of ["slack", "jira", "confluence", "drive"] as Source[]) {
            const identity = person.platformIdentities?.[source];
            const connector = connectors?.[source];
            checks[source] = !identity ? "no_identity"
              : brain.connections.get(source)?.status === "Not connected" || !(connector instanceof LiveConnector) ? "not_connected"
                : await connector.lookupIdentity(identity);
          }
          return await reply(response, 200, { checks });
        }
        if (id && !verb && request.method === "DELETE") {
          const result = await people.remove(user, id);
          brain.audit.append("person_removed", user.id, { userId: id, auth0: result.auth0 });
          await reloadUsers();
          return await reply(response, 200, result);
        }
        return await reply(response, 404, { error: "Not found" });
      }

      // The address people type at sign-in to reach this company, shown to its admins so they can pass it on.
      if (request.method === "GET" && url.pathname === "/v1/admin/company") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const own = current.isHome ? management : management?.forOrg(current.orgId);
        // With one fixed company, sign-in never asks for an address.
        if (!own || signupMode === "off") return await reply(response, 404, { error: "Not found" });
        const found = await own.organization();
        // A personal workspace is found from its owner's email, so its address is never typed.
        const personal = tenant.personal || isPersonalAddress(found.name);
        return await reply(response, 200, { address: personal ? null : found.name, name: found.displayName, personal });
      }

      if (url.pathname === "/v1/admin/model") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        if (!orgModel) return await reply(response, 503, { error: "Choosing a model needs Supabase persistence." });
        if (request.method === "GET") {
          const model = await orgModel.summary();
          return await reply(response, 200, { model: model ?? null, source: model ? "organization" : models.llm ? "operator" : "built-in" });
        }
        if (request.method === "PUT") {
          try {
            const model = await orgModel.save(user.id, await body(request));
            brain.audit.append("model_changed", user.id, { action: "set", provider: model.provider, model: model.model, baseUrl: model.baseUrl });
            return await reply(response, 200, { model, source: "organization" });
          } catch (error) {
            if (error instanceof ModelCheckFailed) return await reply(response, error.refused ? 400 : 502,
              { error: error.refused ? "The model provider refused the request. Check the key, the model name and the address." : "The model provider could not be reached. Try again." });
            throw error;
          }
        }
        if (request.method === "DELETE") {
          await orgModel.remove();
          brain.audit.append("model_changed", user.id, { action: "removed" });
          return await reply(response, 200, { ok: true });
        }
        return await reply(response, 404, { error: "Not found" });
      }

      if (url.pathname.startsWith("/v1/admin/connections") || url.pathname === "/v1/admin/import-jobs" || url.pathname === "/v1/admin/onboard") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const sources: Source[] = ["slack", "jira", "confluence", "drive"];
        if (request.method === "GET") brain.settleStaleJobs();
        if (url.pathname === "/v1/admin/connections" && request.method === "GET") {
          return await reply(response, 200, { connections: [...brain.connections.values()].map(connection => ({ ...connection,
            lastSync: brain.states.get(connection.source)?.lastSuccessfulSyncAt,
            count: [...brain.index.documents.values()].filter(doc => doc.source === connection.source && !doc.deletedAt).length })),
            unmatched: brain.users.flatMap(person => sources.filter(source => !person.platformIdentities?.[source]).map(source => ({ user: person.id, source }))),
            liveMode: brain.liveMode });
        }
        if (url.pathname === "/v1/admin/import-jobs" && request.method === "GET") return await reply(response, 200, { jobs: [...brain.jobs.values()] });
        if (url.pathname === "/v1/admin/onboard" && request.method === "POST") {
          if (brain.liveMode) throw new Error("Mock onboarding only");
          for (const source of sources) { await brain.connect(user, source); await brain.startImport(user, source); }
          return await reply(response, 202, { jobs: [...brain.jobs.values()] });
        }
        const match = /^\/v1\/admin\/connections\/(slack|jira|confluence|drive)(?:\/(authorize|callback|scope|import|containers))?$/.exec(url.pathname);
        if (!match) return await reply(response, 404, { error: "Not found" });
        const source = match[1] as Source;
        if (match[2] === "authorize" && request.method === "POST") {
          // The guided setup page asks to be returned to afterwards; anything else returns to the connectors page.
          const page = pageFor((await body(request)).via);
          if (source === "slack" && slackCombined) return await reply(response, 200, { url: withReturnPage(await slackInstallation!.begin(user), page, tenant.isHome ? undefined : tenant.orgId) });
          if (oauth) return await reply(response, 200, { url: withReturnPage(await oauth.begin(source, user), page, tenant.isHome ? undefined : tenant.orgId) });
          await brain.connect(user, source); return await reply(response, 200, { connected: true });
        }
        if (match[2] === "containers" && request.method === "GET") return await reply(response, 200, { containers: await brain.listContainers(user, source) });
        if (match[2] === "scope" && request.method === "PUT") {
          const input = await body(request);
          if (input.mode !== undefined && !["all", "selected", "none"].includes(String(input.mode))) throw new Error("Invalid scope");
          if (input.futureOnly !== undefined && typeof input.futureOnly !== "boolean") throw new Error("Invalid scope");
          if (input.containers !== undefined && (!Array.isArray(input.containers) || !input.containers.every(id => typeof id === "string" && id.length > 0))) throw new Error("Invalid scope");
          if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.every(id => typeof id === "string" && id.length > 0))) throw new Error("Invalid scope");
          if (input.since !== undefined && (typeof input.since !== "string" || !Number.isFinite(Date.parse(input.since)))) throw new Error("Invalid scope");
          const mode = input.mode as ImportScope["mode"];
          await brain.change(() => brain.setScope(user, source, { mode, containers: input.containers as string[] | undefined, ids: input.ids as string[] | undefined,
            since: input.since as string | undefined, futureOnly: input.futureOnly as boolean | undefined }));
          // Saving what to include starts importing it; choosing none only removes.
          if (mode !== "none") await brain.startImport(user, source);
          return await reply(response, 200, { ok: true });
        }
        if (match[2] === "import" && request.method === "POST") { await brain.startImport(user, source); return await reply(response, 202, { ok: true }); }
        if (!match[2] && request.method === "DELETE") { await brain.disconnect(user, source); await oauth?.remove(source); return await reply(response, 200, { ok: true }); }
        return await reply(response, 404, { error: "Not found" });
      }

      if ((request.method === "PUT" || request.method === "POST" || request.method === "GET") &&
        (url.pathname.startsWith("/v1/tasks/jira/") || url.pathname.startsWith("/v1/task-operations/"))) {
        const header = (name: string): string | undefined => {
          const value = request.headers[name];
          return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
        };
        const routed = await taskCommandRoutes({
          method: request.method as "PUT" | "POST" | "GET", url, user,
          body: request.method === "GET" ? undefined : await body(request).catch(() => undefined),
          headers: { "if-match": header("if-match"), "idempotency-key": header("idempotency-key") },
          list: brain.taskCatalog(), commands: brain });
        if (routed) return await reply(response, routed.status, routed.body);
      }

      if (request.method === "GET" && (url.pathname === "/v1/tasks" || url.pathname.startsWith("/v1/tasks/"))) {
        const routed = await getTaskRoutes({ url, user,
          list: brain.taskCatalog(), detail: { get: (person, docId) => brain.taskDetail(person, docId) } });
        if (routed) return await reply(response, routed.status, routed.body);
      }

      if (request.method === "GET" && url.pathname === "/v1/workspace") {
        return await reply(response, 200, await brain.workspace(user));
      }

      if (request.method === "POST" && url.pathname === "/v1/catch-up") {
        const input = await body(request);
        if (input.project !== undefined && (typeof input.project !== "string" || input.project.length > 64)) {
          throw new Error("Invalid project");
        }
        let traceId: string | undefined;
        const result = await brain.catchUp(user, input.project as string | undefined, id => { traceId = id; },
          () => identity(request, brain, auth0, !connectors));
        return await reply(response, 200, result.kind === "audit" ? result : { ...result, traceId });
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const input = await body(request);
        if (typeof input.threadDocId !== "string" || typeof input.sentence !== "string" || input.sentence.length > 1000) {
          throw new Error("Invalid task");
        }
        if (input.proposalId !== undefined && (typeof input.proposalId !== "string" || !Number.isInteger(input.revision))) throw new Error("Invalid commitment");
        return await reply(response, 201, await brain.createTask(user, input.threadDocId, input.sentence,
          typeof input.proposalId === "string" ? { proposalId: input.proposalId, revision: input.revision as number } : undefined));
      }

      if (request.method === "POST" && url.pathname === "/v1/commitments/review") {
        const input = await body(request);
        if (typeof input.id !== "string" || !Number.isInteger(input.revision) || (input.revision as number) < 1) throw new Error("Invalid commitment");
        const base = { id: input.id, revision: input.revision as number };
        if (input.action === "dismiss") return await reply(response, 200, await brain.reviewCommitment(user, { ...base, action: "dismiss" }));
        if (input.action === "link" && typeof input.issueDocId === "string") return await reply(response, 200,
          await brain.reviewCommitment(user, { ...base, action: "link", issueDocId: input.issueDocId }));
        if (input.action === "edit" && typeof input.summary === "string" && (input.ownerSlackId === undefined || typeof input.ownerSlackId === "string") &&
          (input.dueDate === undefined || typeof input.dueDate === "string")) return await reply(response, 200, await brain.reviewCommitment(user,
          { ...base, action: "edit", summary: input.summary, ownerSlackId: input.ownerSlackId as string | undefined, dueDate: input.dueDate as string | undefined }));
        throw new Error("Invalid commitment");
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks/done") {
        const input = await body(request);
        if (typeof input.docId !== "string") throw new Error("Invalid task");
        await brain.markDone(user, input.docId);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/tier") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !["open", "internal", "restricted"].includes(String(input.tier))) {
          throw new Error("Invalid tier change");
        }
        await brain.narrowTier(user, input.docId, input.tier as Tier);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/permissions") {
        const input = await body(request);
        if (typeof input.docId !== "string" || !input.permissions || typeof input.permissions !== "object") {
          throw new Error("Invalid permissions");
        }
        await brain.setNativePermissions(user, input.docId, input.permissions as SourcePermission);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/permissions") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const docId = url.searchParams.get("docId") ?? "";
        const visible = (await brain.visibleDocuments(user)).some(doc => doc.docId === docId);
        if (!visible) return await reply(response, 404, { error: "Not found" });
        const source = docId.split(":")[0] as keyof typeof brain.connectors;
        const permissions = await brain.connectors[source]?.fetchPermissions(docId);
        return permissions ? send(response, 200, { docId, source, permissions }) :
          send(response, 404, { error: "Not found" });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/group") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.group !== "string") {
          throw new Error("Invalid group change");
        }
        brain.removeUserFromGroup(user, input.userId, input.group);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && (url.pathname === "/v1/admin/block" || url.pathname === "/v1/admin/unblock")) {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.docId !== "string") throw new Error("Invalid block");
        if (url.pathname === "/v1/admin/block") await brain.blockUser(user, input.docId, input.userId);
        else await brain.unblockUser(user, input.docId, input.userId);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/restricted-grant") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.docId !== "string" || typeof input.reason !== "string" ||
          typeof input.expiresAt !== "string") throw new Error("Invalid grant");
        await brain.grantRestricted(user, input.docId, input.userId, input.reason, input.expiresAt);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/channel-member") {
        const input = await body(request);
        if (typeof input.userId !== "string" || typeof input.docId !== "string") {
          throw new Error("Invalid channel change");
        }
        await brain.removeSlackMember(user, input.docId, input.userId);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/content") {
        const input = await body(request);
        if (typeof input.docId !== "string" || typeof input.content !== "string") {
          throw new Error("Invalid content");
        }
        await brain.editContent(user, input.docId, input.content);
        return await reply(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/sync") {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const results = await brain.syncConnected();
        return await reply(response, 200, { results, sources: brain.syncHealth() });
      }

      // The signed-in person's own company: its sources, imports and last syncs, and its audit trail's size.
      if (request.method === "GET" && url.pathname === "/v1/sync-health") {
        return await reply(response, 200, { sources: brain.syncHealth(), live: brain.liveMode,
          auditEntries: brain.audit.entries.length, merkleBatches: brain.audit.batches.length });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/preview") {
        const target = url.searchParams.get("user") ?? "alex";
        return await reply(response, 200, await brain.previewAccess(user, target));
      }

      if (url.pathname === "/v1/audit" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        return await reply(response, 200, {
          entries: brain.audit.entries,
          batches: brain.audit.batches,
          chainValid: brain.audit.verifyChain()
        });
      }

      if (url.pathname === "/v1/audit/search" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        if (query.length > 200) throw new Error("Invalid query");
        const documents = [...brain.index.documents.values()].map(doc => ({ docId: doc.docId, title: doc.title }));
        const result = searchAudit(brain.audit.entries, url.searchParams, brain.users, new Date(), documents);
        brain.audit.append("audit_searched", user.id, { query, filters: result.filters, results: result.entries.length });
        await brain.audit.flush();
        return await reply(response, 200, result);
      }

      if (url.pathname === "/v1/audit/seal" && request.method === "POST") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        return await reply(response, 200, { batch: brain.audit.seal() ?? null });
      }

      if (url.pathname === "/v1/audit/proof" && request.method === "GET") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const sequence = Number(url.searchParams.get("sequence"));
        if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid sequence");
        const proof = brain.audit.proof(sequence);
        return proof
          ? send(response, 200, { proof })
          : send(response, 404, { error: "Proof unavailable; seal the log first" });
      }

      if (url.pathname === "/v1/audit/verify" && request.method === "POST") {
        if (user.role !== "compliance") return await reply(response, 403, { error: "Forbidden" });
        const input = await body(request);
        const sequence = input.sequence;
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
          throw new Error("Invalid sequence");
        }
        const proof = brain.audit.proof(sequence);
        const batch = brain.audit.batches.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
        return await reply(response, 200, {
          verified: Boolean(proof && batch && brain.audit.verifyChain() && brain.audit.verifyBatches() &&
            AuditLog.verifyProof(proof, batch)),
          proof: proof ?? null,
          batch: batch ?? null
        });
      }

      return await reply(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      // A real organization sign-in that isn't on the admin's list: say so, so the person knows what to ask for.
      if (error instanceof AccessDenied) return await reply(response, 403, { error: error.message, code: error.code });
      if (error instanceof PeopleError || error instanceof SignupError) return await reply(response, error.status, { error: error.message });
      if (error instanceof WorkspaceUnavailable) return await reply(response, 503, { error: "Broppy couldn't load your workspace just now. Wait a moment and try again.", code: "workspace_unavailable" });
      if (error instanceof StaleState) return await reply(response, 409, { error: "This workspace was just changed somewhere else. Reload the page and try again." });
      const message = error instanceof Error ? error.message : "Request failed";
      if (message === "Unauthorized") return await reply(response, 401, { error: "Unauthorized" });
      if (message === "Forbidden") return await reply(response, 403, { error: "Forbidden" });
      if (message === "Live sources are read-only") {
        return await reply(response, 409, { error: "This app only reads live sources. Make the change in Jira." });
      }
      if (message === CUSTOM_ADDRESS_REFUSED) return await reply(response, 400, { error: "This workspace can use Anthropic or OpenAI. A custom model address isn't available." });
      if (message === "Already tracked") return await reply(response, 409, { error: "A Jira task already quotes this agreement." });
      if (message === "Stale commitment revision") return await reply(response, 409, { error: "This commitment changed or is being processed. Reload before reviewing it." });
      if (message === "Unknown document" || message === "Unknown source item" || message === "Unknown user" ||
        message === "Unknown group membership" || message === "Unknown channel membership") {
        return await reply(response, 404, { error: "Not found" });
      }
      // Messages already written for the person reading them are passed on as they are.
      if (PLAIN_MESSAGES.has(message) || /^Live .* must be (changed|edited) /.test(message)) return await reply(response, 409, { error: message });
      if (message === "Connect source first") return await reply(response, 409, { error: "Connect this tool first, from Setup or Connectors." });
      const jira = jiraRefusal(error);
      if (jira) return await reply(response, jira.status, { error: jira.error });
      // Every other failure is logged, so it can be found. A fault on our side (a bug, a timeout, a database or provider
      // that failed) is said to be ours; anything else is input this API could not use.
      console.error(JSON.stringify({ event: "request_failed", method: request.method, path: new URL(request.url ?? "/", "http://localhost").pathname, error: message.slice(0, 300) }));
      const ours = error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError
        || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
        || /fetch failed|timed? ?out|aborted|failed \(\d{3}\)|unavailable|Persistence|Supabase|Conflicting audit|ECONN|ENOTFOUND/i.test(message);
      if (ours) return await reply(response, 500, { error: "Something went wrong on Broppy's side. Try again in a moment.", code: "internal" });
      return await reply(response, 400, { error: "Invalid request" });
    }
  });

  /** Stops every company's sync and writes out what each has not yet saved, for a clean exit. */
  const shutdown = async (): Promise<void> => {
    server.close();
    for (const item of tenants.all()) {
      item.orchestrator.stop();
      try { item.brain.audit.seal(); await item.brain.audit.flush(); await item.brain.persist(); } catch { /* exiting anyway */ }
    }
  };
  return { brain, orchestrator, server, shutdown };
}

/** Errors whose wording is already meant for the person who asked, passed on unchanged. */
const PLAIN_MESSAGES = new Set([
  "We couldn't confirm whether Jira created the task. Check Jira before trying again.",
  "Your Jira account can't create issues in that project", "Jira didn't let you mark this task done", "Only Jira tasks can be marked done",
  "Native permission edits may only narrow access",
  "Jira refused this task. Check the project's required fields in Jira, then try again.",
  "Broppy doesn't read that Slack channel", "Broppy doesn't know that Jira project",
  "Channels with more than 100 people can't send tasks to Jira yet", "Broppy couldn't read who is in that channel",
  "Your Broppy profile needs a Slack email before you can add Broppy to Slack. Ask your administrator to update it."
]);

// Serverless hosts such as Vercel import this module and call its default export once per request. The server is
// built on first use and reused while the instance stays warm; there is no background sync loop between requests.
let serverless: Promise<ApiServer> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Slack's events, slash commands and button clicks are answered by the Slack gateway in the same deployment, so one
  // Vercel project serves both. The gateway reads its installations from Supabase like the API does.
  if (process.env.SLACK_APP_ID && new URL(request.url ?? "/", "http://localhost").pathname.startsWith("/slack/")) return slackHandler(request, response);
  serverless ??= createApiServer({ startOrchestrator: false }).catch(error => {
    serverless = undefined;
    throw error;
  });
  const { server } = await serverless;
  server.emit("request", request, response);
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

/** Printed once the API accepts requests, so a quiet window doesn't look like one still starting. */
export function startupMessage(host: string, port: number, env: NodeJS.ProcessEnv = process.env): string {
  const signIn = env.AUTH0_ISSUER || env.AUTH0_AUDIENCE || env.AUTH0_ORG_ID ? "with Auth0 sign-in"
    : env.PUBLIC_DEMO === "true" ? "as the public demo, on mock data only" : "in demo mode (x-demo-user)";
  const data = corpusFromEnv(env) === "demo" ? ", with the generated company" : "";
  return `API ready at http://${host}:${port} ${signIn}${data}. Leave this window open; Ctrl+C stops it.`;
}

if (isMainModule()) {
  const { orchestrator, server, shutdown } = await createApiServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => process.stdout.write(`${startupMessage(host, port)}\n`));

  // Seal what is left and write it out before the process exits, so the last entries are not left unsealed.
  const stop = (): void => { orchestrator.stop(); void shutdown(); };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
