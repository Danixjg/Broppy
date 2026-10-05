// The committed dataset is exactly what the generator makes, and it passes every check of the validator, which judges
// it with the app's own access check, link reader, search words and workspace functions. After changing the generator
// or its banks, run `pnpm dataset` to write the files again.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { SourceDocument } from "../packages/types/src/index.js";
import { generateCorpus, generatedFiles, validateCorpus, writeGenerated, type GeneratedCorpus } from "./generate.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
// Git for Windows may check text out with CRLF line endings.
const committed = (name: string) => readFileSync(new URL(`./generated/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the generated dataset", () => {
  const corpus = generateCorpus();

  it("passes every check at demo scale", () => {
    expect(validateCorpus(corpus, "demo")).toEqual([]);
  });

  it("is what the generator writes, byte for byte", () => {
    const stale = Object.entries(generatedFiles(corpus)).filter(([name, content]) => committed(name) !== content).map(([name]) => name);
    expect(stale, "out of date in data/generated: run pnpm dataset").toEqual([]);
  });

  it("leaves a file alone when only its line endings differ, so Git doesn't list it as changed", async () => {
    const path = await mkdtemp(join(tmpdir(), "dataset-"));
    try {
      const folder = pathToFileURL(`${path}/`);
      const files = generatedFiles(corpus);
      // As Git for Windows checks them out: CRLF line endings. One file is out of date.
      for (const [name, content] of Object.entries(files)) await writeFile(new URL(name, folder), content.replace(/\n/g, "\r\n"));
      await writeFile(new URL("fga-tuples.json", folder), "[]\n");
      expect(await writeGenerated(folder, corpus)).toEqual(["fga-tuples.json"]);
      expect(await readFile(new URL("documents.json", folder), "utf8")).toBe(files["documents.json"].replace(/\n/g, "\r\n"));
      expect(await readFile(new URL("fga-tuples.json", folder), "utf8")).toBe(files["fga-tuples.json"]);
      expect(await writeGenerated(folder, corpus)).toEqual([]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("depends only on the seed", () => {
    expect(json(generateCorpus())).toBe(json(corpus));
    expect(json(generateCorpus({ seed: 7 }).documents)).not.toBe(json(corpus.documents));
  });

  const byTitle = (copy: GeneratedCorpus, title: string): SourceDocument => {
    const doc = copy.documents.find(item => item.title === title);
    if (!doc) throw new Error(`no item titled ${title}`);
    return doc;
  };
  const breaks: Array<[string, RegExp, (copy: GeneratedCorpus) => void]> = [
    ["a word from the hand-written story", /forbidden word "launch"/,
      copy => { byTitle(copy, "Runner pool design").content += " The launch is next week."; }],
    ["a hidden issue key in an item Wei Ming can open", /wei can open it, and it names "VEND-7"/,
      copy => { byTitle(copy, "Webhook retry design").content += " See VEND-7 for alerts."; }],
    ["a contractor in a native list without a grant", /without a grant by name/, copy => {
      const native = byTitle(copy, "Runner pool design").permissions.native;
      if (native?.source !== "confluence") throw new Error("expected a Confluence page");
      native.spaceViewers = [...native.spaceViewers, "zz.contractor@contractor.example"];
    }],
    ["a status that disagrees with the issue", /says PLAT-2 is blocked, but it is done/,
      copy => { byTitle(copy, "Runner pool design").content += " PLAT-2 is blocked."; }],
    ["a file that copies another", /unintended pair/, copy => {
      byTitle(copy, "Artifact retention proposal").content = `${byTitle(copy, "Flaky test policy").content} One more line.`;
    }]
  ];

  it.each(breaks)("catches %s", (_label, expected, change) => {
    const copy = structuredClone(corpus);
    change(copy);
    expect(validateCorpus(copy, "demo").some(problem => expected.test(problem))).toBe(true);
  }, 30_000);

  it("passes every check at the brief's scale, in memory", () => {
    const brief = generateCorpus({ scale: "brief" });
    expect(brief.documents.length).toBeGreaterThan(18_000);
    expect(validateCorpus(brief, "brief")).toEqual([]);
  }, 120_000);
});
