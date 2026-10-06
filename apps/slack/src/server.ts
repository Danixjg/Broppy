import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { SlackGateway } from "./gateway.js";

let gateway: SlackGateway | undefined;

async function rawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Vercel entry. The body is read raw because Slack's signature covers the exact bytes. Work that outlives Slack's
 * three-second window (answers) is handed to waitUntil, which keeps the function alive after the response.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    gateway ??= SlackGateway.fromEnv(process.env, waitUntil);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const result = await gateway.handle({
      method: request.method ?? "GET", path: new URL(request.url ?? "/", "http://localhost").pathname, headers,
      rawBody: await rawBody(request)
    });
    response.statusCode = result.status;
    if (result.body === undefined) return void response.end();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.body));
  } catch (error) {
    console.error("slack server failed", error);
    gateway = undefined;
    response.statusCode = 500;
    response.end();
  }
}
