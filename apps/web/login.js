import { parseAuthConfig, startLogin, completeLogin, accessToken } from "./auth.js";
const status = document.getElementById("loginStatus");
const form = document.getElementById("loginForm");
let config;
try {
  const response = await fetch("./auth-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Sign-in configuration is unavailable.");
  config = parseAuthConfig(await response.json());
  if (!config) throw new Error("Organisation sign-in is not configured.");
  await completeLogin(config);
  if (accessToken()) location.replace("./");
} catch (error) { status.textContent = error.message; form.hidden = true; }
form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.getElementById("loginSubmit");
  button.disabled = true;
  try { await startLogin(config); }
  catch (error) { status.textContent = error.message; button.disabled = false; }
});
