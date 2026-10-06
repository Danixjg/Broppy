import { slackManifest } from "../apps/slack/src/app-manifest.js";
const [gateway, ...callbacks] = process.argv.slice(2);
if (!gateway || !callbacks.length) throw new Error("Usage: tsx scripts/slack-manifest.ts <HTTPS gateway origin> <HTTPS OAuth callback URL> [...callbacks]");
const url = new URL(gateway);
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Gateway must be an HTTPS origin");
for (const callback of callbacks) {
  const parsed = new URL(callback);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/v1/admin/slack-installation/callback") throw new Error("Invalid customer callback URL");
}
console.log(JSON.stringify(slackManifest(url.origin, callbacks), null, 2));
