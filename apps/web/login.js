import { parseSupabaseConfig, signInSupabase, supabaseAccessToken } from "./supabase-auth.js";

const status = document.getElementById("loginStatus");
const form = document.getElementById("loginForm");
let config;
try {
  const response = await fetch("./auth-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Sign-in configuration is unavailable.");
  config = parseSupabaseConfig((await response.json()).supabase);
  if (!config) throw new Error("Organisation sign-in is not configured.");
  if (supabaseAccessToken()) location.replace("./index.html");
} catch (error) {
  status.textContent = error.message;
  form.hidden = true;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.getElementById("loginSubmit");
  button.disabled = true;
  status.textContent = "Signing in…";
  try {
    await signInSupabase(config, document.getElementById("loginEmail").value,
      document.getElementById("loginPassword").value);
    location.replace("./index.html");
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
