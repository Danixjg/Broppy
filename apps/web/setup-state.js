// What the guided setup page decides from the API's answers, kept apart from the page so it can be tested without a browser.

export const TOOLS = [
  { source: "slack", name: "Slack", reads: "Conversations in your channels. Adds the Broppy bot to your Slack, so your team can ask it with /broppy." },
  { source: "jira", name: "Jira", reads: "Tickets, projects and their updates" },
  { source: "confluence", name: "Confluence", reads: "Pages and team documents" },
  { source: "drive", name: "Google Drive", reads: "Documents and files you share" }
];

export const toolName = source => TOOLS.find(tool => tool.source === source)?.name ?? source;

/** How one tool looks to the admin: not connected, connected but not reading yet, reading (with progress), ready, or needing attention. */
export function toolState(connection, job) {
  if (!connection || connection.status === "Not connected") return { state: "not_connected", label: "Not connected" };
  if (connection.status === "Error" || connection.error) {
    // Only a refused or expired sign-in needs the approval again; anything else is fixed by reading again.
    const reconnect = /credential was rejected|reconnect the source|\(401\)|\(403\)/i.test(connection.error ?? "");
    return { state: "attention", label: "Needs attention", detail: connection.error, reconnect };
  }
  if (job?.status === "running" || connection.status === "Importing") {
    const done = (job?.indexed ?? 0) + (job?.skipped ?? 0);
    return { state: "reading", label: "Reading", percent: job?.found ? Math.min(100, Math.floor(100 * done / job.found)) : 0, found: job?.found ?? 0, done };
  }
  // "Nothing for now" leaves the choice open: a connected tool that reads nothing still has a step to finish.
  const chosen = (Boolean(connection.scope?.mode) && connection.scope.mode !== "none") || (connection.count ?? 0) > 0;
  if (!chosen) return { state: "connected", label: "Connected" };
  return { state: "ready", label: "Ready", items: connection.count ?? 0, failed: job?.failed ?? 0 };
}

/**
 * The five steps, each done, current (the first not done), or waiting. Connecting a tool is required; adding a team and
 * choosing an AI can be skipped. `skipped` holds the steps the admin chose to skip. A personal workspace has no team, so
 * it has four steps and no "Add your team".
 */
export function setupSteps({ connections = [], jobs = [], people = [], model, skipped = [], personal = false } = {}) {
  const states = TOOLS.map(tool => toolState(connections.find(item => item.source === tool.source), jobs.find(job => job.source === tool.source)));
  // A tool whose last reading failed is still connected; only one that has to be approved again is not.
  const connected = states.filter(item => item.state !== "not_connected" && !(item.state === "attention" && item.reconnect));
  const connect = connected.length > 0;
  const reading = connect && connected.every(item => item.state === "ready");
  const team = people.filter(person => person.status !== "removed").length > 1 || skipped.includes("team");
  const ai = Boolean(model) || skipped.includes("model");
  const all = [
    { id: "connect", title: "Connect your tools", done: connect },
    { id: "read", title: "Choose what Broppy reads", done: reading },
    { id: "team", title: "Add your team", done: team },
    { id: "ai", title: "Pick your AI", done: ai },
    { id: "ready", title: "You're ready" }
  ].filter(step => !(personal && step.id === "team"));
  const last = all.length - 1;
  const current = all.findIndex((step, index) => index < last && !step.done);
  return all.map(({ done, ...step }, index) => ({ ...step, number: index + 1,
    status: index < last ? (done ? "done" : index === current ? "current" : "waiting") : current === -1 ? "current" : "waiting" }));
}

/** Step to open first: the first one not done. */
export const currentStep = steps => (steps.find(step => step.status === "current") ?? steps.at(-1)).id;

/** Work emails from a pasted block: lowercased, once each, split by lines, spaces, commas or semicolons. Anything that isn't an email is returned apart. */
export function parseEmails(text) {
  const valid = []; const invalid = [];
  for (const raw of String(text ?? "").split(/[\s,;]+/)) {
    const item = raw.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!item) continue;
    if (/^[^\s@<>"',;:()[\]\\]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/.test(item)) { if (!valid.includes(item)) valid.push(item); }
    else if (!invalid.includes(raw.trim())) invalid.push(raw.trim());
  }
  return { valid, invalid };
}

const REASONS = {
  denied: "You cancelled the approval, so nothing was connected. You can try again whenever you're ready.",
  email_mismatch: "The account you signed in with there doesn't use the same email as your Broppy account. Sign in to that tool with your Broppy work email and try again.",
  expired: "That approval took too long and expired. Press Connect and try again.",
  not_admin: "Only a Broppy admin can connect tools. Ask your admin to do this step.",
  failed: "That tool didn't accept the connection. Try again in a minute; if it keeps happening, tell whoever runs Broppy for your company."
};

/** What to tell the admin when they come back from a tool's approval page, from the address's query. */
export function returnMessage(params) {
  const source = params.get("connected"), failed = params.get("connect_failed"), slack = params.get("slack_install");
  if (source) {
    // One Atlassian approval can connect Jira and Confluence together.
    const names = source.split(",").filter(Boolean).map(toolName);
    return { kind: "good", text: names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are connected.` : `${names[0]} is connected.` };
  }
  if (failed) return { kind: "bad", text: `${toolName(failed)}: ${REASONS[params.get("reason")] ?? REASONS.failed}` };
  if (slack === "installed") return { kind: "good", text: "Broppy was added to Slack and Slack is connected." };
  if (slack === "denied") return { kind: "bad", text: `Slack: ${REASONS.denied}` };
  if (slack === "email_mismatch") return { kind: "bad", text: `Slack: ${REASONS.email_mismatch}` };
  if (slack === "unsupported") return { kind: "bad", text: "Slack: this Slack app has token rotation turned on, which Broppy can't use. Turn it off under OAuth & Permissions in the app's settings, then try again." };
  if (slack === "conflict") return { kind: "bad", text: "That Slack workspace is already connected to another company. Contact whoever runs Broppy for your company." };
  if (slack) return { kind: "bad", text: "Slack didn't accept the connection. Try again in a minute; if it keeps happening, tell whoever runs Broppy for your company." };
  return undefined;
}

/** Plain wording for an error from the API, for the few the setup page can hit. */
export function plainError(message) {
  const text = String(message ?? "");
  if (/Source OAuth is not configured|not available in this workspace/i.test(text)) return "This tool isn't switched on for your company yet. Tell whoever runs Broppy for you.";
  if (/Admin-managed sign-in needs/i.test(text)) return "Adding people isn't available in this workspace yet. Tell whoever runs Broppy for your company.";
  if (/Forbidden/i.test(text)) return "Only a Broppy admin can do this.";
  if (/Sync running/i.test(text)) return "Broppy is still reading this tool. Try again in a moment.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return "Couldn't reach Broppy. Check your connection and try again.";
  return text || "Something went wrong. Try again.";
}

/** One line per source for the account check made after someone is added. */
export function checkLines(checks) {
  const words = { not_found: "has no account for this email", unavailable: "couldn't be checked just now", no_identity: "has no account set up" };
  return TOOLS.filter(tool => words[checks?.[tool.source]]).map(tool => `${tool.name} ${words[checks[tool.source]]}`);
}

/** What happened to one added person, in words an admin can act on. */
export function addedMessage(email, result) {
  if (result?.auth0 === "invited") return `${email}: invitation sent.`;
  if (result?.auth0 === "restored") return `${email}: added back.`;
  if (result?.auth0 === "not_configured") return `${email}: added. Email invitations aren't switched on yet, so they can't receive one. Tell whoever runs Broppy for your company.`;
  return `${email}: added, but the invitation email could not be sent. You can resend it from People and access.`;
}

/** Anthropic's models by what they are good at; any other provider is typed in. */
export const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-5-5", label: "Balanced (recommended)" },
  { id: "claude-opus-5-5", label: "Most capable" },
  { id: "claude-haiku-5-5", label: "Fastest" }
];

export const FIRST_QUESTIONS = [
  "What changed across our tools this week?",
  "Which tasks are open and who owns them?",
  "Summarise the most recent decisions we made."
];
