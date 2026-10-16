import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps the project's readme files honest: relative links point at files that exist.
// fileURLToPath, not .pathname: on Windows the URL path starts "/C:/", which join() turns into "C:\C:\…".
const root = fileURLToPath(new URL("../../../", import.meta.url));
const docs = ["README.md", "apps/web/AUTH0.md", "apps/slack/README.md", "tools/anchor/README.md"];
// Git for Windows checks text out with CRLF line endings by default, so text is compared with LF ones.
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "");

describe("project readmes", () => {
  it("link only to files that exist", () => {
    const broken = docs.flatMap(doc => [...withoutCode(read(doc)).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)|\]: ([^\s]+)|href="([^"]+)"/g)]
      .map(match => match[1] ?? match[2] ?? match[3])
      .filter(target => !/^(https?:|mailto:|#)/.test(target))
      .filter(target => !existsSync(join(root, dirname(doc), decodeURIComponent(target.split("#")[0]))))
      .map(target => `${doc} → ${target}`));
    expect(broken).toEqual([]);
  });
});
