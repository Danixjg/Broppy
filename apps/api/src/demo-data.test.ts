import { describe, expect, it } from "vitest";
import { LocalGroundedLlm, type LlmClient } from "@brain/retrieval";
import type { SourceDocument, User } from "@brain/types";
import { generateCorpus } from "../../../data/generate.js";
import { personaViews } from "../../../data/dataset/validate.js";
import { Brain } from "./brain.js";
import { actorTrace } from "./server.js";

// The demo API's data: the 26 hand-written items and the generated company beside them.

async function demoBrain(llm?: LlmClient) {
  const brain = new Brain(llm, { corpus: "demo" });
  await brain.syncAll();
  return brain;
}

/** What each document is called anywhere a reader could see it: its title, issue key and channel name. */
function namesOf(doc: SourceDocument): string[] {
  return [doc.title, doc.source === "jira" ? doc.sourceNativeId : "", doc.source === "slack" ? doc.metadata.channel : ""]
    .filter(name => name && name.length > 3);
}

async function hiddenFrom(brain: Brain, user: User) {
  const documents = (await brain.workspace(user)).documents;
  const visible = new Set(documents.map(doc => doc.docId));
  const hidden = [...brain.index.documents.values()].filter(doc => !visible.has(doc.docId));
  // A project is hidden when its master page is.
  const projects = hidden.filter(doc => doc.metadata.label === "master")
    .flatMap(doc => [doc.title.replace(/\s+master page$/i, ""), doc.metadata.space]);
  const names = [...new Set([...hidden.flatMap(namesOf), ...projects])];
  // A visible item may name a hidden one, as PAY-101's text names SEC-44, and a page restricted to risk sits in the DATA
  // space, which its address shows. The reader sees those at the source too, so only names that appear nowhere in what
  // they can open count as hidden.
  const readable = documents.map(doc => [doc.title, doc.content, doc.url, ...Object.values(doc.metadata)].join("\n")).join("\n");
  return { visible, ids: hidden.map(doc => doc.docId), names, unseen: names.filter(name => !readable.includes(name)) };
}

describe("the demo data", () => {
  it("lets each person open what the generated company's validator says, on top of the hand-written items", async () => {
    const curated = new Brain();
    await curated.syncAll();
    const demo = await demoBrain();
    const generated = personaViews(generateCorpus());
    for (const user of demo.users) {
      const handWritten = (await curated.workspace(curated.user(user.id)!)).documents.length;
      expect((await demo.workspace(user)).documents.length, user.id)
        .toBe(handWritten + generated[user.id as keyof typeof generated]);
    }
  });

  it("never sends anyone a passage they can't open, or names one in their own trace, whichever project they ask about", async () => {
    const contexts: string[][] = [];
    const local = new LocalGroundedLlm();
    const brain = await demoBrain({
      generate: async (context, question) => {
        contexts.push(context.map(item => item.citation.slice(0, item.citation.lastIndexOf(":"))));
        return local.generate(context, question);
      }
    });
    const masters = [...brain.index.documents.values()].filter(doc => doc.metadata.label === "master");
    expect(masters).toHaveLength(8);
    for (const user of brain.users) {
      const hidden = await hiddenFrom(brain, user);
      for (const master of masters) {
        const name = master.title.replace(/\s+master page$/i, "");
        for (const question of [`What's the status of ${name}?`, `What is blocked in ${master.metadata.space}?`]) {
          contexts.length = 0;
          let traceId = "";
          await brain.query(user, question, id => { traceId = id; });
          for (const docId of contexts.flat()) expect(hidden.visible.has(docId), `${user.id}: ${question} sent ${docId}`).toBe(true);
          const own = JSON.stringify(actorTrace(brain.audit.entries.filter(entry => entry.data.traceId === traceId)));
          for (const docId of hidden.ids) expect(own.includes(`"${docId}"`), `${user.id}: ${question} names ${docId}`).toBe(false);
          // The question itself may name a hidden project; repeating the asker's own words reveals nothing.
          for (const hiddenName of hidden.unseen.filter(name => !question.includes(name))) {
            expect(own.includes(hiddenName), `${user.id}: ${question} names ${hiddenName}`).toBe(false);
          }
        }
      }
    }
  }, 60_000);

  // Stricter for the two people scenario 3 is about: no hidden name at all, even one a visible item could contain.
  it("names nothing hidden in the contractor's or the intern's workspace", async () => {
    const brain = await demoBrain();
    for (const id of ["wei", "alex"]) {
      const user = brain.user(id)!;
      const hidden = await hiddenFrom(brain, user);
      const workspace = JSON.stringify(await brain.workspace(user));
      for (const docId of hidden.ids) expect(workspace.includes(`"${docId}"`), `${id} sees ${docId}`).toBe(false);
      for (const name of hidden.names) expect(workspace.includes(name), `${id} sees ${name}`).toBe(false);
    }
  });
});
