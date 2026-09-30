import type { NextConfig } from "next";
const config: NextConfig = {
  async redirects() {
    return [
      { source: "/login.html", destination: "/auth/login", permanent: false },
      { source: "/index.html", destination: "/workspace/index.html", permanent: false },
      { source: "/connectors.html", destination: "/workspace/connectors.html", permanent: false }
    ];
  }
};
export default config;
