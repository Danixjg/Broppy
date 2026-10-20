import { describe, expect, it } from "vitest";
import { BENCH_QUESTIONS, formatBench, runBench } from "./bench.js";

// pnpm bench runs at the brief's scale, which takes a minute or two; this runs the same code at the demo's scale.
describe("pnpm bench", () => {
  it("asks every person every question on the demo's data, and reports times, memory and refusals", async () => {
    expect(BENCH_QUESTIONS).toHaveLength(20);
    const report = await runBench({ scale: "demo" });
    expect(report.items).toBe(528);
    expect(report.projects).toBe(8);
    expect(report.bySource).toEqual({ confluence: 154, drive: 160, jira: 147, slack: 67 });
    expect(report.questions).toBe(20);
    expect(report.people.map(person => person.id)).toEqual(["ravi", "maya", "alex", "david", "nur", "wei"]);
    for (const person of report.people) {
      expect(person.p50, person.id).toBeGreaterThan(0);
      expect(person.p95, person.id).toBeGreaterThanOrEqual(person.p50);
      expect(person.checked, person.id).toBeGreaterThan(0);
      expect(person.refused, person.id).toBeLessThanOrEqual(person.checked);
      expect(person.entries, person.id).toBeGreaterThan(person.checked);
    }
    const person = (id: string) => report.people.find(item => item.id === id)!;
    // The contractor may open 18 items, the backend engineer about 290: most of what search finds is refused for Wei.
    expect(person("wei").refused / person("wei").checked).toBeGreaterThan(person("david").refused / person("david").checked);
    expect(person("wei").answered).toBeLessThan(person("david").answered);
    expect(report.generateMs).toBeGreaterThan(0);
    expect(report.buildMs).toBeGreaterThan(0);
    expect(report.rssMb).toBeGreaterThan(0);
    const text = formatBench(report);
    for (const name of ["Ravi", "Maya", "Alex", "David", "Nur", "Wei Ming"]) expect(text).toContain(name);
    expect(text).toContain("528 items");
    expect(BENCH_QUESTIONS).toContain(report.slowest.question);
    expect(text).toContain(`Slowest: "${report.slowest.question}"`);
  }, 60_000);
});
