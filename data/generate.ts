// A seeded generator for the demo's company dataset: about 500 items across Confluence, Jira, Slack and Google Drive,
// with each platform's own permissions, checked by the app's own rules. Run it with `pnpm dataset`, or
// `pnpm dataset --scale brief` to build and check the brief's scale in memory.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SourceDocument } from "../packages/types/src/index.js";
import { BANKS } from "./dataset/banks/index.js";
import { buildCorpus, type Tuple } from "./dataset/build.js";
import { genericBanks } from "./dataset/generic.js";
import { Rng } from "./dataset/random.js";
import { DEFAULT_SEED, type PersonaId, type Scale } from "./dataset/rules.js";
import { areaOf, personaViews, validateCorpus as validate } from "./dataset/validate.js";

export interface GeneratedCorpus {
  documents: SourceDocument[];
  fgaTuples: Tuple[];
  personaGroups: Record<PersonaId, string[]>;
}

export function generateCorpus(options: { seed?: number; scale?: Scale } = {}): GeneratedCorpus {
  const seed = options.seed ?? DEFAULT_SEED;
  const scale = options.scale ?? "demo";
  const banks = scale === "brief" ? [...BANKS, ...genericBanks(new Rng(seed, "generic"))] : BANKS;
  return buildCorpus(seed, scale, banks);
}

/** The rules the data breaks, by the app's own checks: an empty list means it is valid. */
export function validateCorpus(corpus: GeneratedCorpus, scale: Scale): string[] {
  return validate(corpus, scale);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The files `pnpm dataset` writes, by name, with their exact content. */
export function generatedFiles(corpus: GeneratedCorpus): Record<string, string> {
  return {
    "documents.json": json(corpus.documents),
    "fga-tuples.json": json(corpus.fgaTuples),
    "persona-groups.json": json(corpus.personaGroups)
  };
}

/**
 * Writes the files into the folder and returns the names it wrote. A file whose content is already the same is left
 * alone, even when only its line endings differ: Git for Windows checks text out with CRLF, and rewriting such a file
 * with LF would make Git list it as changed.
 */
export async function writeGenerated(folder: URL, corpus: GeneratedCorpus): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(generatedFiles(corpus))) {
    const file = new URL(name, folder);
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (current?.replace(/\r\n/g, "\n") === content) continue;
    await writeFile(file, content);
    written.push(name);
  }
  return written;
}

function summary(corpus: GeneratedCorpus, scale: Scale): string {
  const count = (pick: (doc: SourceDocument) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const doc of corpus.documents) {
      const key = pick(doc) ?? "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, value]) => `${key} ${value}`).join(", ");
  };
  const views = personaViews(corpus);
  return [
    `${corpus.documents.length} items at ${scale} scale`,
    `By platform: ${count(doc => doc.source)}`,
    ...(scale === "demo" ? [`By area: ${count(doc => areaOf(doc))}`] : []),
    `Each persona can open: ${Object.entries(views).map(([id, value]) => `${id} ${value}`).join(", ")}`,
    `FGA tuples: ${corpus.fgaTuples.length}`
  ].join("\n");
}

async function main(args: string[]): Promise<void> {
  const flag = args.findIndex(arg => arg === "--scale" || arg.startsWith("--scale="));
  const value = flag < 0 ? "demo" : args[flag].includes("=") ? args[flag].split("=")[1] : args[flag + 1];
  if (value !== "demo" && value !== "brief") throw new Error("--scale must be demo or brief");
  const scale: Scale = value;
  const started = performance.now();
  const corpus = generateCorpus({ scale });
  const problems = validateCorpus(corpus, scale);
  process.stdout.write(`${summary(corpus, scale)}\n`);
  if (problems.length) {
    process.stdout.write(`\n${problems.length} problems:\n${problems.map(problem => `- ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  if (scale === "demo") {
    const written = await writeGenerated(new URL("./generated/", import.meta.url), corpus);
    process.stdout.write(written.length
      ? `Wrote ${written.map(name => `data/generated/${name}`).join(", ")}.\n`
      : "data/generated is already up to date.\n");
  }
  process.stdout.write(`No problems found, in ${((performance.now() - started) / 1000).toFixed(1)} seconds.\n`);
}

// pathToFileURL makes the comparison work on Windows too, where argv[1] is "C:\...".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
