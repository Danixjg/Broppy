import test from "node:test";
import assert from "node:assert/strict";
import { parseSupabaseConfig, signInSupabase, supabaseAccessToken, clearSupabaseLogin } from "./supabase-auth.js";

test("Supabase sign-in requires an HTTPS project and a publishable key", () => {
  assert.equal(parseSupabaseConfig({ url: "", publishableKey: "" }), null);
  assert.throws(() => parseSupabaseConfig({ url: "http://example.test/", publishableKey: "key" }));
  assert.deepEqual(parseSupabaseConfig({ url: "https://example.test/", publishableKey: "key" }),
    { url: "https://example.test", publishableKey: "key" });
});

test("Supabase sign-in stores only a timed access token and clears it on logout", async () => {
  const entries = new Map();
  globalThis.sessionStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://example.test/auth/v1/token?grant_type=password");
    assert.equal(options.headers.apikey, "publishable");
    assert.deepEqual(JSON.parse(options.body), { email: "ravi@example.test", password: "secret" });
    return { ok: true, json: async () => ({ access_token: "valid-token", expires_in: 300 }) };
  };
  await signInSupabase({ url: "https://example.test", publishableKey: "publishable" },
    " ravi@example.test ", "secret");
  assert.equal(supabaseAccessToken(), "valid-token");
  assert.equal(entries.size, 1);
  assert.equal(entries.get("brain.supabase.access").includes("secret"), false);
  clearSupabaseLogin();
  assert.equal(supabaseAccessToken(), null);
});
