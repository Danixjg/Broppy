import users from "./mock/users.json" with { type: "json" };
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const issuer = required("AUTH0_ISSUER");
const orgId = required("AUTH0_ORG_ID");
const supabase = required("SUPABASE_URL");
const key = required("SUPABASE_SECRET_KEY");
const passwords = JSON.parse(required("MOCK_USER_PASSWORDS_JSON")) as Record<string, string>;
for (const url of [issuer, supabase]) if (new URL(url).protocol !== "https:") throw new Error("HTTPS required");
async function request(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`User provisioning failed (${response.status})`);
  const text = await response.text(); return text ? JSON.parse(text) : undefined;
}
const token = await request(new URL("oauth/token", issuer).href, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ grant_type: "client_credentials", client_id: required("AUTH0_MANAGEMENT_CLIENT_ID"),
    client_secret: required("AUTH0_MANAGEMENT_CLIENT_SECRET"), audience: new URL("api/v2/", issuer).href }) });
const headers = { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" };
for (const user of users) {
  const matches = await request(new URL(`api/v2/users-by-email?email=${encodeURIComponent(user.email)}`, issuer).href, { headers });
  let auth = matches.find((match: { identities: Array<{ connection: string }> }) => match.identities.some(identity => identity.connection === required("AUTH0_DATABASE_CONNECTION")));
  if (!auth) {
    if (!passwords[user.id] || passwords[user.id].length < 12) throw new Error(`Provide a password of at least 12 characters for ${user.id}`);
    auth = await request(new URL("api/v2/users", issuer).href, { method: "POST", headers, body: JSON.stringify({
      connection: required("AUTH0_DATABASE_CONNECTION"), email: user.email, name: user.name, password: passwords[user.id] }) });
  }
  await request(new URL(`api/v2/organizations/${encodeURIComponent(orgId)}/members`, issuer).href,
    { method: "POST", headers, body: JSON.stringify({ members: [auth.user_id] }) });
  await request(`${supabase.replace(/\/$/, "")}/rest/v1/workspace_users?on_conflict=org_id,user_id`, {
    method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: user.id, auth0_sub: auth.user_id, org_id: orgId, active: true,
      name: user.name, email: user.email, role: user.role, groups: user.groups,
      contractor: "contractor" in user ? user.contractor : false, platform_identities: user.platformIdentities }) });
  process.stdout.write(`Provisioned ${user.id}\n`);
}
