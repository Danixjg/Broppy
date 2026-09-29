const TOKEN_KEY = "brain.supabase.access";

export function parseSupabaseConfig(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Supabase sign-in configuration.");
  const { url, publishableKey } = value;
  if (url === "" && publishableKey === "") return null;
  if (typeof url !== "string" || typeof publishableKey !== "string" || !publishableKey.trim()) {
    throw new Error("Supabase sign-in needs a project URL and publishable key.");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Supabase project URL must be an HTTPS origin.");
  }
  return { url: parsed.origin, publishableKey };
}

export async function signInSupabase(config, email, password) {
  if (!email.trim() || !password) throw new Error("Enter your email and password.");
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: config.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
    cache: "no-store"
  });
  if (!response.ok) throw new Error("Sign-in failed. Check your credentials.");
  const result = await response.json();
  if (typeof result.access_token !== "string" || !result.access_token ||
    !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
    throw new Error("Sign-in returned an invalid session.");
  }
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ value: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000 }));
}

export function supabaseAccessToken() {
  try {
    const token = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    if (typeof token?.value === "string" && token.expiresAt > Date.now() + 5000) return token.value;
  } catch { /* A damaged session is treated as signed out. */ }
  sessionStorage.removeItem(TOKEN_KEY);
  return null;
}

export function clearSupabaseLogin() { sessionStorage.removeItem(TOKEN_KEY); }
