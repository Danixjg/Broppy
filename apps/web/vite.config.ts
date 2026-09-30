import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        workspace: path.resolve(import.meta.dirname, "index.html"),
        connectors: path.resolve(import.meta.dirname, "connectors.html"),
        login: path.resolve(import.meta.dirname, "login.html"),
      },
    },
  },
});
