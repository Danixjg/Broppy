import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import handler from "./server.js";

// The Vercel entry answers Slack's requests with the Slack gateway, so one deployment serves the API and the bot.
describe("the API's Vercel entry", () => {
  let server: Server;
  let base = "";
  const saved = { ...process.env };
  beforeAll(async () => {
    Object.assign(process.env, { SLACK_APP_ID: "A123", SLACK_SIGNING_SECRET: "s".repeat(32), SUPABASE_URL: "https://store.invalid", SUPABASE_SECRET_KEY: "k" });
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    process.env = saved;
    await new Promise(resolve => server.close(resolve));
  });

  it("sends Slack's requests to the Slack gateway, which refuses an unsigned one", async () => {
    const response = await fetch(`${base}/slack/events`, { method: "POST", body: JSON.stringify({ type: "url_verification", challenge: "x" }) });
    expect(response.status).toBe(401);
  });
});
