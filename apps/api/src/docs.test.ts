import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps the project docs honest: relative links point at files that exist, and each diagram embedded in a doc is the
// same as its source in docs/diagrams, which also has a rendered image in docs/images.
// fileURLToPath, not .pathname: on Windows the URL path starts "/C:/", which join() turns into "C:\C:\…".
const root = fileURLToPath(new URL("../../../", import.meta.url));
const docs = ["README.md", "decisions.md", "apps/web/AUTH0.md", "infra/tencent/README.md",
  ...readdirSync(join(root, "docs")).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];
// Git for Windows checks text out with CRLF line endings by default, so text is compared with LF ones.
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "");
const MARKER = /<!-- diagram: (docs\/diagrams\/[\w-]+\.mmd) -->\s*```mermaid\n([\s\S]*?)```/g;

describe("project docs", () => {
  it("link only to files that exist", () => {
    const broken = docs.flatMap(doc => [...withoutCode(read(doc)).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)]
      .map(match => match[1])
      .filter(target => !/^(https?:|mailto:|#)/.test(target))
      .filter(target => !existsSync(join(root, dirname(doc), decodeURIComponent(target.split("#")[0]))))
      .map(target => `${doc} → ${target}`));
    expect(broken).toEqual([]);
  });

  it("embed each diagram exactly as its source, and every source is embedded and rendered", () => {
    const embedded = new Set<string>();
    for (const doc of docs) {
      for (const [, source, block] of read(doc).matchAll(MARKER)) {
        expect(existsSync(join(root, source)), `${doc} embeds a missing ${source}`).toBe(true);
        expect(block.trim(), `${doc} embeds ${source}`).toBe(read(source).trim());
        embedded.add(source);
      }
    }
    const sources = readdirSync(join(root, "docs/diagrams")).filter(name => name.endsWith(".mmd"));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      expect(embedded, `docs/diagrams/${name} is embedded in a doc`).toContain(`docs/diagrams/${name}`);
      const image = `docs/images/diagram-${name.replace(/\.mmd$/, ".png")}`;
      expect(existsSync(join(root, image)), `${image} exists`).toBe(true);
    }
  });
});
