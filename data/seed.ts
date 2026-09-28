import { loadMockCorpus } from "../packages/connectors/src/index.js";
import fgaTuples from "./mock/fga-tuples.json" with { type: "json" };

const corpus = loadMockCorpus();

export const users = corpus.users;
export const connectors = corpus.connectors;
export { fgaTuples };

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = Object.fromEntries(
    await Promise.all(
      Object.entries(connectors).map(async ([source, connector]) => [source, (await connector.listItems()).length] as const)
    )
  );
  process.stdout.write(JSON.stringify({ users: users.length, documents: counts, fgaTuples: fgaTuples.length }, null, 2));
}
