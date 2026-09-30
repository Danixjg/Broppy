import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) {
  throw new Error("Expected a Next.js command: dev, build, or start");
}

// Load private configuration from the repository root before starting Next.js.
// The child inherits it as server environment variables, never public config.
const root = fileURLToPath(new URL("../../../", import.meta.url));
nextEnv.loadEnvConfig(root, command === "dev");

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), command, ...args], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => {
  console.error("Unable to start Next.js");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
