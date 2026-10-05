import { pathToFileURL } from "node:url";
import { loadMockCorpus } from "../packages/connectors/src/index.js";
import fgaTuples from "./mock/fga-tuples.json" with { type: "json" };

const corpus = loadMockCorpus();

export const users = corpus.users;
export const connectors = corpus.connectors;
export { fgaTuples };

// pathToFileURL makes the comparison work on Windows too, where argv[1] is "C:\…".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counts = Object.fromEntries(
    await Promise.all(
      Object.entries(connectors).map(async ([source, connector]) => [source, (await connector.listItems()).length] as const)
    )
  );
  process.stdout.write(JSON.stringify({ users: users.length, documents: counts, fgaTuples: fgaTuples.length }, null, 2));
}
