import { depsFromEnv } from "./config.js";
import { runCompletionFeedback } from "./feedback.js";

const deps = depsFromEnv(process.env, work => { void work.catch(error => console.error(error)); });
const limit = Number(process.argv[2] ?? 25);
if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Worker limit must be an integer between 1 and 50");
console.log(JSON.stringify(await runCompletionFeedback(deps, limit)));
