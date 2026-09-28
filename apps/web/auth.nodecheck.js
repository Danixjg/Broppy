import test from "node:test";
import assert from "node:assert/strict";
import { parseAuthConfig, startLogin, completeLogin, accessToken, clearLogin } from "./auth.js";

const config = { issuer: "https://tenant.example/", clientId: "spa-client", audience: "api://brain" };

function browser() {
  const data = new Map();
  globalThis.sessionStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  globalThis.location = { origin: "http://127.0.0.1:3001", pathname: "/", href: "http://127.0.0.1:3001/", assign(value) { this.redirect = value; } };
  globalThis.history = { replaceState(_state, _title, path) { location.href = location.origin + path; } };
}

function encoded(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

test("config selects demo only when all public fields are blank", () => {
  assert.equal(parseAuthConfig({ issuer: "", clientId: "", audience: "" }), null);
  assert.deepEqual(parseAuthConfig(config), config);
  assert.throws(() => parseAuthConfig({ ...config, issuer: "http://tenant.example/" }));
  assert.throws(() => parseAuthConfig({ ...config, clientId: "" }));
});

test("PKCE login sets S256 challenge, state and nonce", async () => {
  browser();
  await startLogin(config);
  const url = new URL(location.redirect);
  const flow = JSON.parse(sessionStorage.getItem("brain.auth0.flow"));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier));
  assert.equal(url.searchParams.get("code_challenge"), Buffer.from(digest).toString("base64url"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), flow.state);
  assert.equal(url.searchParams.get("nonce"), flow.nonce);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3001/");
  assert.equal(url.searchParams.get("client_secret"), null);
});

test("callback rejects mismatched state and removes code from URL", async () => {
  browser(); await startLogin(config);
  location.href = "http://127.0.0.1:3001/?code=unsafe&state=wrong";
  await assert.rejects(completeLogin(config), /state did not match/);
  assert.equal(location.href, "http://127.0.0.1:3001/");
  assert.equal(sessionStorage.getItem("brain.auth0.flow"), null);
  assert.equal(accessToken(), null);
});

test("callback verifies signed nonce and keeps the access token in session storage", async () => {
  browser(); await startLogin(config);
  const flow = JSON.parse(sessionStorage.getItem("brain.auth0.flow"));
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const header = encoded({ alg: "RS256", kid: "test-key" });
  const payload = encoded({ iss: config.issuer, aud: config.clientId, exp: Math.floor(Date.now() / 1000) + 300, sub: "auth0|user", nonce: flow.nonce });
  const signed = `${header}.${payload}`;
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signed))).toString("base64url");
  globalThis.fetch = async url => String(url).endsWith("/oauth/token")
    ? { ok: true, json: async () => ({ token_type: "Bearer", access_token: "api-token", expires_in: 300, id_token: `${signed}.${signature}` }) }
    : { ok: true, json: async () => ({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] }) };
  location.href = `http://127.0.0.1:3001/?code=abc&state=${flow.state}`;
  assert.equal(await completeLogin(config), true);
  assert.equal(location.href, "http://127.0.0.1:3001/");
  assert.equal(accessToken(), "api-token");
  assert.equal(sessionStorage.getItem("brain.auth0.flow"), null);
  clearLogin();
  assert.equal(accessToken(), null);
});
