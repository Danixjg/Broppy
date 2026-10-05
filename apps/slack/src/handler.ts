import { answerBlocks, suggestionBlocks, trackedLine, type Suggestion } from "./blocks.js";
import type { Deps } from "./config.js";
import { fingerprint, tokens } from "./fingerprint.js";
import { scoreMessage } from "./score.js";
import { verifySignature } from "./slack.js";

export interface SlackRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface SlackResponse {
  status: number;
  body?: unknown;
}

const ok = (body?: unknown): SlackResponse => ({ status: 200, ...(body === undefined ? {} : { body }) });
const ephemeral = (text: string) => ({ response_type: "ephemeral", replace_original: false, text });

function validSuggestion(value: unknown): value is Suggestion {
  const s = value as Suggestion;
  return Boolean(s) && typeof s.t === "string" && typeof s.a === "string" && typeof s.p === "string" &&
    typeof s.c === "string" && typeof s.ts === "string" && typeof s.s === "string" &&
    (s.d === undefined || typeof s.d === "string") && (s.th === undefined || typeof s.th === "string");
}

const openTask = (deps: Deps, title: string) => `${deps.webUrl}/?task=${encodeURIComponent(title)}`;
const openAsk = (deps: Deps, question: string) => `${deps.webUrl}/?ask=${encodeURIComponent(question)}`;

export async function handleSlack(deps: Deps, request: SlackRequest): Promise<SlackResponse> {
  if (request.method !== "POST") return { status: 405 };
  if (!verifySignature(deps.signingSecret, request.rawBody, request.headers["x-slack-request-timestamp"],
    request.headers["x-slack-signature"], deps.now().getTime())) {
    return { status: 401 };
  }
  try {
    if (request.path.endsWith("/events")) return await events(deps, JSON.parse(request.rawBody));
    const form = new URLSearchParams(request.rawBody);
    if (request.path.endsWith("/commands")) return commands(deps, form);
    if (request.path.endsWith("/interactions")) return await interactions(deps, JSON.parse(form.get("payload") ?? "null"));
    return { status: 404 };
  } catch (error) {
    // The detail goes to the host's log; Slack and the user only learn that it failed.
    console.error("slack handler failed", error);
    return ok(ephemeral("Broppy hit a problem and did nothing. Try again in a moment."));
  }
}

/** A message in a channel the app is in: score it, and show a suggestion to the person who would get the task. */
async function events(deps: Deps, payload: any): Promise<SlackResponse> {
  if (payload?.type === "url_verification" && typeof payload.challenge === "string") return ok({ challenge: payload.challenge });
  const event = payload?.event;
  if (payload?.type !== "event_callback" || event?.type !== "message") return ok();
  if (event.bot_id || event.subtype || typeof event.text !== "string" || !event.channel || !event.ts) return ok();

  const postedAt = new Date(Number(event.ts) * 1000);
  const result = scoreMessage(event.text, deps.people, postedAt, deps.threshold);
  if (!result.suggest || !result.assignee) return ok();
  if (!await deps.store.claim(`suggest:${event.channel}:${event.ts}`)) return ok();

  const suggestion: Suggestion = {
    t: result.title, a: result.assignee.slackId, p: deps.channelProjects[event.channel] ?? deps.defaultProject,
    c: event.channel, ts: event.ts, s: result.sentence.slice(0, 500),
    ...(result.due ? { d: result.due } : {}), ...(event.thread_ts ? { th: event.thread_ts } : {})
  };
  try {
    await deps.slack.postEphemeral({
      channel: event.channel, user: suggestion.a, text: `Looks like a task: ${suggestion.t}`,
      blocks: suggestionBlocks(suggestion, result.assignee.name, openTask(deps, suggestion.t)),
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {})
    });
  } catch (error) {
    await deps.store.release(`suggest:${event.channel}:${event.ts}`);
    throw error;
  }
  return ok();
}

/** /broppy <question>: acknowledged at once, answered through response_url, visible only to the asker. */
function commands(deps: Deps, form: URLSearchParams): SlackResponse {
  const question = (form.get("text") ?? "").trim();
  if (!question) return ok(ephemeral("Ask me something, for example `/broppy what's blocking wave three?`"));
  const user = form.get("user_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  deps.defer(answer(deps, user, question, responseUrl));
  return ok({ response_type: "ephemeral", text: "Asking Broppy..." });
}

async function answer(deps: Deps, slackUser: string, question: string, responseUrl: string): Promise<void> {
  const person = deps.people.find(p => p.slackId === slackUser);
  try {
    if (!person?.brainUserId) {
      await deps.slack.respond(responseUrl, ephemeral("Your Slack account isn't linked to a Broppy user yet. Ask an admin to add you."));
      return;
    }
    const result = await deps.broppy.ask(person.brainUserId, question);
    await deps.slack.respond(responseUrl, {
      response_type: "ephemeral", replace_original: true, text: result.text.slice(0, 200),
      blocks: answerBlocks(question, result, openAsk(deps, question))
    });
  } catch (error) {
    console.error("broppy answer failed", error);
    await deps.slack.respond(responseUrl, { ...ephemeral("Broppy couldn't answer that just now."), replace_original: true });
  }
}

async function interactions(deps: Deps, payload: any): Promise<SlackResponse> {
  const user: string = payload?.user?.id ?? "";
  if (payload?.type === "message_action" && payload.callback_id === "ask_broppy") {
    const question = String(payload.message?.text ?? "").trim().slice(0, 1000);
    if (!question) return ok();
    deps.defer(answer(deps, user, question, payload.response_url));
    return ok();
  }
  if (payload?.type !== "block_actions") return ok();
  const action = payload.actions?.[0];
  if (action?.action_id === "open_in_broppy" || action?.action_id === "open_answer") return ok();
  if (action?.action_id !== "track_task" && action?.action_id !== "dismiss_task") return ok();

  let suggestion: unknown;
  try { suggestion = JSON.parse(action.value); } catch { suggestion = undefined; }
  if (!validSuggestion(suggestion)) return ok();

  // Only the person receiving the task decides. The suggestion was only shown to them, but Slack can't promise nobody
  // else ever sees a copy, so the click is checked as well.
  if (user !== suggestion.a) {
    await deps.slack.respond(payload.response_url, ephemeral(`Only <@${suggestion.a}> can decide on this task.`));
    return ok();
  }
  if (action.action_id === "dismiss_task") {
    await deps.slack.respond(payload.response_url, { delete_original: true });
    return ok();
  }
  return await track(deps, suggestion, user, payload.response_url);
}

async function track(deps: Deps, s: Suggestion, user: string, responseUrl: string): Promise<SlackResponse> {
  const claimKey = `track:${s.c}:${s.ts}`;
  if (!await deps.store.claim(claimKey)) {
    await deps.slack.respond(responseUrl, ephemeral("This task is already tracked."));
    return ok();
  }
  try {
    const person = deps.people.find(p => p.slackId === s.a);
    const name = person?.name ?? `<@${s.a}>`;
    const fp = fingerprint(s.p, s.t);
    const words = tokens(s.t);
    const existing = await deps.store.findTask(s.p, fp, words);
    let key: string, url: string;
    if (existing) {
      // The same task again: add to the ticket that already tracks it.
      key = existing.issueKey;
      url = existing.issueUrl;
      await deps.jira.addComment(key, `Raised again in Slack (channel ${s.c}): "${s.s}"\n\nConfirmed by ${name}${s.d ? `, due ${s.d}` : ""}.`);
      await deps.store.recordRepeat(existing, s.c, s.ts);
    } else {
      const created = await deps.jira.createIssue({
        project: s.p, summary: s.t, assigneeAccountId: person?.jiraAccountId, dueDate: s.d,
        description: `Raised in Slack (channel ${s.c}):\n\n"${s.s}"\n\nConfirmed by ${name}.`
      });
      key = created.key;
      url = created.url;
      await deps.store.saveTask({
        fingerprint: fp, project: s.p, title: s.t, tokens: words, issueKey: key, issueUrl: url, assigneeSlackId: s.a,
        trackedBy: user, channel: s.c, messageTs: s.ts, mentionCount: 1
      });
    }
    const line = trackedLine(key, url, user, name, s.d, openTask(deps, s.t), Boolean(existing));
    await deps.slack.postMessage({ channel: s.c, thread_ts: s.th ?? s.ts, text: line });
    await deps.slack.respond(responseUrl, { replace_original: true, text: line });
  } catch (error) {
    await deps.store.release(claimKey);
    throw error;
  }
  return ok();
}
