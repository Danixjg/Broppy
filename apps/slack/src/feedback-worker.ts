import { SlackGateway } from "./gateway.js";
import { runCompletionFeedback } from "./feedback.js";

const teamId = process.argv[2];
if (!teamId) throw new Error("Usage: feedback-worker <Slack team ID> [limit]");
const limit = Number(process.argv[3] ?? 25);
if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Worker limit must be an integer between 1 and 50");
const gateway = SlackGateway.fromEnv(process.env, work => { void work.catch(error => console.error(error)); });
const deps = await gateway.forTeam(teamId);
if (!deps) throw new Error("Slack workspace is not actively installed");
console.log(JSON.stringify(await runCompletionFeedback(deps, limit)));
