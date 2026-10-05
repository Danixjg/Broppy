import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/workspace/",
  // public/ holds the published workspace itself (scripts/publish-workspace.mjs), so copying it into dist/ put each
  // build inside the next one.
  publicDir: false,
  plugins: [ react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        workspace: path.resolve(import.meta.dirname, "index.html"),
        connectors: path.resolve(import.meta.dirname, "connectors.html"),
        accounts: path.resolve(import.meta.dirname, "accounts.html"),
      },
    },
  },
});
