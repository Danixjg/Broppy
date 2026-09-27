import { loadMockCorpus } from "../packages/connectors/src/index.js";

const corpus = loadMockCorpus();

export const users = corpus.users;
export const connectors = corpus.connectors;

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = Object.fromEntries(
    await Promise.all(
      Object.entries(connectors).map(async ([source, connector]) => [source, (await connector.listItems()).length] as const)
    )
  );
  process.stdout.write(JSON.stringify({ users: users.length, documents: counts }, null, 2));
}
