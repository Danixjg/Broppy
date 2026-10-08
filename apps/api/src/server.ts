import { SlackInstallationOAuth } from "./slack-installation.js";
import { slackUserIdsFromEnv } from "./slack-identity.js";
import { atlassianAccountIds } from "./atlassian-identity.js";
import { SourceOAuth } from "./source-oauth.js";
import { Persistence } from "./persistence.js";
import { searchAudit } from "./audit-search.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Brain, type Corpus } from "./brain.js";
import { SyncOrchestrator } from "./orchestrator.js";
import { AccessDenied, createAuth0TokenValidatorFromEnv, type Auth0TokenValidator } from "./auth.js";
import { modelsFromEnv } from "./llm-budget.js";
import { ModelCheckFailed, OrgModel } from "./org-model.js";
import { UserDirectory } from "./user-directory.js";
import { Auth0Management } from "./auth0-management.js";
import { People, PeopleError } from "./people.js";
import { ServiceActor } from "./service-actor.js";
import { ActionLimit, AgentActions, chatReply, parseHistory, proposeIssue, routeTurn, standaloneQuestion } from "./agent.js";
import { JiraAsUser, parseComment, parseIssue } from "./service-jira.js";
import { SupabaseTaskStore } from "../../slack/src/store.js";
import { LiveConnector, liveConnectorsFromEnv } from "@brain/connectors/live";
import { MockConnector, loadMockCorpus, type ImportScope } from "@brain/connectors";
import { AuditLog, FileAuditStore } from "@brain/audit";
import { RemoteFgaAdapter } from "@brain/fga-adapter";
import { SupabaseIndex } from "@brain/retrieval";
import type { AuditEntry, Source, SourcePermission, Tier, User } from "@brain/types";

export interface ApiServer {
  brain: Brain;
  orchestrator: SyncOrchestrator;
  server: Server;
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
      persist: (kind, value) => persistence.appendAudit(kind, value) });
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
  const embedding = models.embedding;
  const supabase = embedding ? SupabaseIndex.fromEnv() : null;
  if (supabase && !embedding) throw new Error("Supabase hybrid search requires an embedding provider (EMBEDDING_PROVIDER)");
  const users = hasAuth0 ? await directory!.list() : undefined;
  const persistence = options.brain ? undefined : Persistence.fromEnv();
  const oauthConfigs = process.env.SOURCE_OAUTH_JSON ? JSON.parse(process.env.SOURCE_OAUTH_JSON) : undefined;
  if (oauthConfigs && process.env.LIVE_SOURCES_JSON) throw new Error("Choose OAuth or manually managed source credentials");
  if (oauthConfigs && !persistence) throw new Error("Source OAuth requires Supabase persistence");
  if ((process.env.SLACK_APP_ID || process.env.SLACK_CLIENT_ID || process.env.SLACK_CLIENT_SECRET) && !hasAuth0) throw new Error("Slack onboarding requires Auth0 and the active user directory");
  const slackInstallation = directory ? SlackInstallationOAuth.fromEnv(process.env, sub => directory.bySub(sub)) : undefined;
  const oauth = oauthConfigs && persistence ? new SourceOAuth(oauthConfigs, process.env.API_ORIGIN ?? "http://127.0.0.1:3000", persistence) : undefined;
  const accountIds = oauth ? atlassianAccountIds(oauth) : undefined;
  const connectors = liveConnectorsFromEnv(users ?? loadMockCorpus().users) ?? (oauth ? Object.fromEntries(
    (["slack", "jira", "confluence", "drive"] as Source[]).map(source => [source, oauthConfigs[source] ? new LiveConnector(source, {
      ids: [], serviceAuthorization: "", userAuthorizations: {}, discover: true, baseUrl: oauthConfigs[source].baseUrl, cloudId: oauthConfigs[source].cloudId,
      authorization: oauth.provider(source), atlassianAccountId: accountIds, linkOrigins: oauthConfigs[source].linkOrigins
    }, users ?? []) : new MockConnector(source, [])])) as Record<Source, MockConnector> : undefined);
  if (connectors && !hasAuth0) {
    throw new Error("Live sources require Auth0 sign-in");
  }
  // One consent installs Broppy in Slack and connects Slack as a source, when both use the same Slack app.
  const slackConfig = oauthConfigs?.slack;
  const slackCombined = Boolean(oauth && slackInstallation && slackConfig && slackConfig.clientId === slackInstallation.config.clientId);
  if (oauth && slackInstallation && slackConfig && !slackCombined) console.warn("SLACK_CLIENT_ID differs from the slack entry in SOURCE_OAUTH_JSON; Slack is installed and connected in two steps");
  const orgModel = persistence ? new OrgModel(persistence) : undefined;
  const brain = options.brain ?? new Brain(models.llm,
    { orgLlm: orgModel, orgId: process.env.AUTH0_ORG_ID, persistence, audit: await configuredAudit(persistence), remoteFga: useRemoteFga ? RemoteFgaAdapter.fromEnv() : undefined, embedding, supabase: supabase ?? undefined,
      taskStore: persistence && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
        ? new SupabaseTaskStore(persistence.orgId, process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY) : undefined,
      slackUserIds: slackUserIdsFromEnv(), users, connectors, corpus });
  // Atlassian sites are found when someone signs in; reconnect each connector to its stored site after a restart.
  const applySite = async (source: Source) => {
    const connector = connectors?.[source];
    const site = oauth && connector instanceof LiveConnector ? await oauth.orgSite(source) : undefined;
    if (site) (connector as LiveConnector).useSite(site);
  };
  for (const source of ["jira", "confluence"] as Source[]) await applySite(source);
  if (oauth) for (const connection of brain.connections.values()) connection.status = "Not connected";
  await brain.restore();
  const serviceActor = ServiceActor.fromEnv(directory);
  if (slackCombined) slackInstallation!.link = { scopes: slackConfig.scopes,
    store: async (admin, grant) => { await oauth!.storeGrant("slack", admin, grant); brain.markConnected(admin, "slack"); await brain.persist(); },
    discard: async () => { await oauth!.remove("slack"); } };
  const jiraAsUser = oauth ? new JiraAsUser(oauth, accountIds) : undefined;
  const agentActions = new AgentActions();
  const actionsOn = AgentActions.enabled();
  const auth0 = hasAuth0 ? createAuth0TokenValidatorFromEnv(directory!) : undefined;
  const people = hasAuth0 ? new People(directory!, Auth0Management.fromEnv()) : undefined;
  // The directory is also the in-memory list of people the brain knows; reload it after the admin changes who is on it.
  const reloadUsers = async () => { users!.splice(0, users!.length, ...await directory!.list()); };
  const orchestrator = new SyncOrchestrator(brain, connectors ? 300_000 : 30_000);
  if (options.startOrchestrator === false) {
    // A source that isn't connected yet, or is briefly down, is recorded on its own connection. It must not stop the
    // whole API from starting: the admin connects sources from the running API, so refusing to start would lock them out.
    await brain.syncAll().catch(error => {
      const reasons = error instanceof AggregateError ? error.errors.map(e => e instanceof Error ? e.message : String(e)) : [String(error)];
      console.warn(`Source synchronization incomplete at startup: ${reasons.join("; ")}`);
    });
  }
  if (options.startOrchestrator ?? true) orchestrator.start();

  const server = createServer(async (request, response) => {
    let actor: User | undefined;
    const reply = async (response: ServerResponse, status: number, data: unknown) => {
      // A refused request is part of the trail too. Only the actor, method and route are recorded, never the body.
      if (status === 403 && actor) {
        brain.audit.append("request_denied", actor.id, { method: request.method, path: new URL(request.url ?? "/", "http://localhost").pathname });
        await brain.audit.flush();
      }
      // Reads change no state, so they don't rewrite the whole snapshot (audit entries are flushed on their own).
      if (status >= 200 && status < 300) await (request.method === "GET" ? brain.audit.flush() : brain.persist());
      send(response, status, data);
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "OPTIONS") return await reply(response, 204, null);
      if (request.method === "GET" && url.pathname === "/health") {
        return await reply(response, 200, {
          ok: true,
          sync: [...brain.states.values()],
          pending: [...brain.runs.values()].filter(run => run.status !== "complete"),
          auditEntries: brain.audit.entries.length,
          merkleBatches: brain.audit.batches.length
        });
      }

      if (url.pathname === "/v1/admin/slack-installation/callback" && request.method === "GET") {
        if (!slackInstallation) return await reply(response, 404, { error: "Slack onboarding is not configured" });
        const outcome = await slackInstallation.callback({ state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "", error: url.searchParams.get("error") ?? "" })
          .catch(() => "failed");
        const destination = new URL(slackInstallation.returnUrl);
        destination.searchParams.set("slack_install", outcome);
        response.writeHead(302, { location: destination.href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        response.end(); return;
      }

      const callback = /^\/v1\/admin\/connections\/(slack|jira|confluence|drive)\/callback$/.exec(url.pathname);
      if (callback && request.method === "GET" && oauth && directory) {
        const source = callback[1] as Source;
        const actor = await oauth.complete(source, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "", sub => directory.bySub(sub));
        await applySite(source);
        brain.markConnected(actor, source);
        await brain.persist();
        response.writeHead(302, { location: new URL("/connectors.html", process.env.WEB_ORIGIN ?? "http://127.0.0.1:3001").href, "cache-control": "no-store" });
        response.end(); return;
      }

      // The Slack app acts as the Slack user's own Broppy user, for questions and Jira writes only. Any other request carrying the
      // service header is refused rather than falling back to another identity.
      const service = serviceActor?.present(request) === true;
      const serviceRoutes = ["/v1/query", "/v1/service/actor", "/v1/service/jira/access", "/v1/service/jira/issue", "/v1/service/jira/comment"];
      if (service && !(request.method === "POST" && serviceRoutes.includes(url.pathname))) {
        return await reply(response, 403, { error: "Forbidden" });
      }
          const resolve = async () => {
        const person = await (service ? serviceActor!.resolve(request) : identity(request, brain, auth0, !connectors));
        // Another instance may have added or linked this person after this one loaded the directory.
        if (person && users) {
          const known = users.findIndex(item => item.id === person.id);
          if (known < 0) users.push(person); else if (users[known].auth0Sub !== person.auth0Sub) users[known] = person;
        }
        return person;
      };
      const user = await resolve();
      if (!user) return await reply(response, 401, { error: "Unauthorized" });
      actor = user;

      if (url.pathname === "/v1/admin/slack-installation" || url.pathname.startsWith("/v1/admin/slack-installation/")) {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        const route = url.pathname.slice("/v1/admin/slack-installation".length);
        if (!slackInstallation) return await reply(response, request.method === "GET" && !route ? 200 : 503,
          request.method === "GET" && !route ? { state: "not_installed", configured: false } : { error: "Add to Slack is not available in this workspace yet." });
        if (request.method === "GET" && !route) return await reply(response, 200, await slackInstallation.status(user));
        if (request.method === "POST" && route === "/authorize") return await reply(response, 200, { url: await slackInstallation.begin(user) });
        if ((request.method === "POST" && route === "/refresh") || (request.method === "DELETE" && !route)) {
          const input = await body(request);
          if (typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 1) return await reply(response, 400, { error: "Reload the Slack installation status and try again." });
          const changed = request.method === "DELETE" ? await slackInstallation.disconnect(user, input.generation) : await slackInstallation.refresh(user, input.generation);
          return await reply(response, changed ? 200 : 409, changed ? { ok: true } : { error: "The Slack installation changed. Reload and try again." });
        }
        return await reply(response, 404, { error: "Not found" });
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
        return await reply(response, 200, { id: user.id, name: user.name, role: user.role, groups: user.groups });
      }

      if (service && (url.pathname === "/v1/service/jira/issue" || url.pathname === "/v1/service/jira/comment")) {
        if (!jiraAsUser) return await reply(response, 404, { error: "Source OAuth is not configured" });
        const input = await body(request);
        if (url.pathname === "/v1/service/jira/issue") {
          const issue = await jiraAsUser.createIssue(user, parseIssue(input));
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
        // Small talk and requests to act are handled before any retrieval. The Slack app keeps the plain question path.
        const history = service ? [] : parseHistory(input.history);
        const kind = service ? "question" : routeTurn(input.question);
        if (kind === "chat" || (kind === "action" && !actionsOn)) {
          brain.audit.append("chat_turn", user.id, { kind });
          const text = kind === "chat" ? await chatReply(await brain.conversationModel(), history, input.question)
            : "Creating tickets from the chat is switched off for this workspace.";
          return await reply(response, 200, { text, citations: [], kind: "chat" });
        }
        if (kind === "action") {
          const proposal = await proposeIssue(await brain.conversationModel(), history, input.question);
          brain.audit.append("agent_action_proposed", user.id, { type: "jira_issue", proposalId: proposal.id });
          return await reply(response, 200, { text: "I can prepare this Jira ticket. Check the details, say which project it belongs to, then confirm. Nothing is created until you do.",
            citations: [], kind: "action", proposal: { type: "jira_issue", ...proposal } });
        }
        let traceId: string | undefined;
        const question = await standaloneQuestion(await brain.conversationModel(), history, input.question);
        const answer = await brain.query(user, question, id => { traceId = id; },
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

      const personRoute = /^\/v1\/admin\/people(?:\/([a-z0-9-]{1,64})(?:\/(invite))?)?$/.exec(url.pathname);
      if (personRoute) {
        if (user.role !== "admin") return await reply(response, 403, { error: "Forbidden" });
        if (!people) return await reply(response, 404, { error: "Admin-managed sign-in needs Auth0 and the Supabase user directory." });
        const [, id, verb] = personRoute;
        if (!id && request.method === "GET") return await reply(response, 200, { people: await people.list(), invitations: people.canInvite });
        if (!id && request.method === "POST") {
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
        if (id && !verb && request.method === "DELETE") {
          const result = await people.remove(user, id);
          brain.audit.append("person_removed", user.id, { userId: id, auth0: result.auth0 });
          await reloadUsers();
          return await reply(response, 200, result);
        }
        return await reply(response, 404, { error: "Not found" });
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
          if (source === "slack" && slackCombined) return await reply(response, 200, { url: await slackInstallation!.begin(user) });
          if (oauth) return await reply(response, 200, { url: await oauth.begin(source, user) });
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
          await brain.setScope(user, source, { mode, containers: input.containers as string[] | undefined, ids: input.ids as string[] | undefined,
            since: input.since as string | undefined, futureOnly: input.futureOnly as boolean | undefined });
          // Saving what to include starts importing it; choosing none only removes.
          if (mode !== "none") await brain.startImport(user, source);
          return await reply(response, 200, { ok: true });
        }
        if (match[2] === "import" && request.method === "POST") { await brain.startImport(user, source); return await reply(response, 202, { ok: true }); }
        if (!match[2] && request.method === "DELETE") { await brain.disconnect(user, source); await oauth?.remove(source); return await reply(response, 200, { ok: true }); }
        return await reply(response, 404, { error: "Not found" });
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
        await brain.syncAll();
        return await reply(response, 200, { states: [...brain.states.values()] });
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
      if (error instanceof PeopleError) return await reply(response, error.status, { error: error.message });
      const message = error instanceof Error ? error.message : "Request failed";
      if (message === "Unauthorized") return await reply(response, 401, { error: "Unauthorized" });
      if (message === "Forbidden") return await reply(response, 403, { error: "Forbidden" });
      if (message === "Live sources are read-only") {
        return await reply(response, 409, { error: "This app only reads live sources. Make the change in Jira." });
      }
      if (message === "Already tracked") return await reply(response, 409, { error: "A Jira task already quotes this agreement." });
      if (message === "Stale commitment revision") return await reply(response, 409, { error: "This commitment changed or is being processed. Reload before reviewing it." });
      if (message === "Unknown document" || message === "Unknown source item" || message === "Unknown user" ||
        message === "Unknown group membership" || message === "Unknown channel membership") {
        return await reply(response, 404, { error: "Not found" });
      }
      return await reply(response, 400, { error: "Invalid request" });
    }
  });

  return { brain, orchestrator, server };
}

// Serverless hosts such as Vercel import this module and call its default export once per request. The server is
// built on first use and reused while the instance stays warm; there is no background sync loop between requests.
let serverless: Promise<ApiServer> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
  const { brain, orchestrator, server } = await createApiServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => process.stdout.write(`${startupMessage(host, port)}\n`));

  const stop = (): void => {
    orchestrator.stop();
    server.close();
    // Seal what is left and write it out before the process exits, so the last entries are not left unsealed.
    void (async () => {
      try { brain.audit.seal(); await brain.audit.flush(); await brain.persist(); } catch { /* exiting anyway */ }
    })();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
