import { expect, it } from "vitest";
import { Brain } from "./brain.js";
import { searchAudit } from "./audit-search.js";
it("reconstructs the question and answer for user, source, space and date filters", async () => {
  const brain = new Brain(); await brain.syncAll();
  const doc = [...brain.index.documents.values()].find(doc => doc.source === "confluence")!;
  const space = doc.permissions.native?.source === "confluence" ? doc.permissions.native.spaceKey : "";
  await brain.query(brain.user("ravi")!, doc.title);
  const date = new Date().toISOString().slice(0,10);
  const result = searchAudit(brain.audit.entries, new URLSearchParams({ q: `what did ravi ask about confluence ${space} on ${date}` }), brain.users);
  expect(result.filters).toMatchObject({ user: "ravi", source: "confluence", space });
  expect(result.entries.some(e => e.type === "query_received" && e.data.question === doc.title)).toBe(true);
  expect(result.entries.some(e => e.type === "answer_returned" && typeof e.data.answer === "string")).toBe(true);
  expect(searchAudit(brain.audit.entries, new URLSearchParams({ from: "2000-01-01", to: "2000-01-02" }), brain.users).entries).toEqual([]);
  expect(() => searchAudit([], new URLSearchParams({ from: "bad" }), [])).toThrow("Invalid date");
});
