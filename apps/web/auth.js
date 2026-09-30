const TOKEN_KEY = "brain.auth0.access";
const FLOW_KEY = "brain.auth0.flow";

export function parseAuthConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid auth configuration.");
  const { issuer, clientId, audience } = value;
  if ([issuer, clientId, audience].every(item => item === "")) return null;
  if ([issuer, clientId, audience].some(item => typeof item !== "string" || !item.trim())) throw new Error("Auth0 configuration needs issuer, clientId, and audience.");
  let url;
  try { url = new URL(issuer); } catch { throw new Error("Auth0 issuer must be an HTTPS origin ending in /."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.href !== issuer) {
    throw new Error("Auth0 issuer must be an HTTPS origin ending in /.");
  }
  if (clientId !== clientId.trim() || audience !== audience.trim()) throw new Error("Auth0 configuration contains extra whitespace.");
  return { issuer, clientId, audience, ...(value.organization ? { organization: value.organization } : {}) };
}

function randomUrlSafe() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function callbackUrl() { return `${location.origin}${location.pathname}`; }

export async function startLogin(config) {
  const verifier = randomUrlSafe();
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  sessionStorage.setItem(FLOW_KEY, JSON.stringify({ verifier, state, nonce }));
  const url = new URL("authorize", config.issuer);
  url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: callbackUrl(), scope: "openid profile", ...(config.organization ? { organization: config.organization } : {}), audience: config.audience, state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  location.assign(url.href);
}

function decodeJwtPart(part) {
  const value = part.replaceAll("-", "+").replaceAll("_", "/");
  return atob(value.padEnd(Math.ceil(value.length / 4) * 4, "="));
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) throw new Error("Invalid ID token.");
  try {
    return JSON.parse(decodeJwtPart(jwt.split(".")[1]));
  } catch { throw new Error("Invalid ID token."); }
}

async function verifyIdToken(jwt, config, nonce) {
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) throw new Error("Invalid ID token.");
  const parts = jwt.split(".");
  let header;
  try { header = JSON.parse(decodeJwtPart(parts[0])); } catch { throw new Error("Invalid ID token header."); }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("Unsupported ID token signature.");
  const claims = decodeJwtPayload(jwt);
  if (claims.nonce !== nonce || claims.iss !== config.issuer || claims.aud !== config.clientId || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("Auth0 ID token claims did not match this login.");
  }
  const response = await fetch(new URL(".well-known/jwks.json", config.issuer), { cache: "no-store" });
  if (!response.ok) throw new Error("Could not validate Auth0 ID token.");
  const jwks = await response.json();
  const keys = Array.isArray(jwks.keys) ? jwks.keys.filter(key => key.kid === header.kid && key.kty === "RSA" && key.use === "sig" && (!key.alg || key.alg === "RS256")) : [];
  if (keys.length !== 1) throw new Error("Auth0 ID token signing key was not found.");
  const key = await crypto.subtle.importKey("jwk", keys[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(decodeJwtPart(parts[2]), char => char.charCodeAt(0));
  const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!verified) throw new Error("Auth0 ID token signature was invalid.");
}

export async function completeLogin(config) {
  const url = new URL(location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return false;
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const authError = url.searchParams.get("error");
  for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  const raw = sessionStorage.getItem(FLOW_KEY);
  sessionStorage.removeItem(FLOW_KEY);
  let flow;
  try { flow = JSON.parse(raw); } catch { throw new Error("Login session was lost. Please try again."); }
  if (!flow || typeof flow.verifier !== "string" || !flow.state || returnedState !== flow.state) throw new Error("Login state did not match. Please try again.");
  if (authError) throw new Error(`Login failed: ${authError}`);
  if (!code) throw new Error("Login callback has no code.");
  const response = await fetch(new URL("oauth/token", config.issuer), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, code_verifier: flow.verifier, redirect_uri: callbackUrl() }),
    cache: "no-store"
  });
  if (!response.ok) throw new Error("Auth0 code exchange failed.");
  const tokens = await response.json();
  if (tokens.token_type !== "Bearer" || typeof tokens.access_token !== "string" || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("Auth0 returned an invalid access token.");
  await verifyIdToken(tokens.id_token, config, flow.nonce);
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ value: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 }));
  return true;
}

export function accessToken() {
  try {
    const token = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    if (typeof token?.value === "string" && token.expiresAt > Date.now() + 5000) return token.value;
  } catch { /* Treat malformed session data as logged out. */ }
  sessionStorage.removeItem(TOKEN_KEY);
  return null;
}

export function clearLogin() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(FLOW_KEY);
}

export function logoutUrl(config) {
  const url = new URL("v2/logout", config.issuer);
  url.search = new URLSearchParams({ client_id: config.clientId, returnTo: callbackUrl() }).toString();
  return url.href;
}
