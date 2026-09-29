import users from "./mock/users.json" with { type: "json" };

const origin = process.env.SUPABASE_AUTH_URL;
const secret = process.env.SUPABASE_AUTH_SECRET_KEY;
const rawPasswords = process.env.MOCK_USER_PASSWORDS_JSON;
if (!origin || !secret || !rawPasswords) {
  throw new Error("Set SUPABASE_AUTH_URL, SUPABASE_AUTH_SECRET_KEY, and MOCK_USER_PASSWORDS_JSON");
}
const parsed = new URL(origin);
if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
  throw new Error("SUPABASE_AUTH_URL must be an HTTPS project origin");
}
const passwords: unknown = JSON.parse(rawPasswords);
if (!passwords || typeof passwords !== "object" || Array.isArray(passwords)) {
  throw new Error("MOCK_USER_PASSWORDS_JSON must map fixture IDs to passwords");
}
const passwordMap = passwords as Record<string, unknown>;
const base = parsed.origin;
const headers = { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" };

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) throw new Error(`Supabase user seed failed at ${path} (${response.status})`);
  return response.json();
}

const existing = await request("/auth/v1/admin/users?page=1&per_page=1000") as { users?: Array<{ id: string; email: string }> };
if (!Array.isArray(existing.users)) throw new Error("Supabase returned an invalid user list");
for (const fixture of users) {
  const password = passwordMap[fixture.id];
  if (typeof password !== "string" || password.length < 12) {
    throw new Error(`Provide a password of at least 12 characters for ${fixture.id}`);
  }
  let auth = existing.users.find(item => item.email?.toLowerCase() === fixture.email.toLowerCase());
  if (!auth) {
    auth = await request("/auth/v1/admin/users", { method: "POST",
      body: JSON.stringify({ email: fixture.email, password, email_confirm: true }) }) as typeof auth;
  }
  if (!auth?.id) throw new Error(`Could not provision ${fixture.id}`);
  await request("/rest/v1/workspace_users?on_conflict=auth_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      auth_user_id: auth.id, user_id: fixture.id, name: fixture.name, email: fixture.email,
      role: fixture.role, groups: fixture.groups, contractor: "contractor" in fixture ? fixture.contractor : false,
      platform_identities: fixture.platformIdentities
    })
  });
  process.stdout.write(`Provisioned ${fixture.id}\n`);
}
