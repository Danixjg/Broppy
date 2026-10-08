import { afterEach, describe, expect, it, vi } from "vitest";
import { Brain } from "./brain.js";
import { createApiServer } from "./server.js";

afterEach(() => vi.restoreAllMocks());

describe("startup source sync", () => {
  it("starts the API even when a source is not connected yet", async () => {
    process.env.ALLOW_DEMO_AUTH = "true";
    vi.spyOn(Brain.prototype, "syncAll").mockRejectedValue(new AggregateError([new Error("Source is not connected")], "Source synchronization failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await createApiServer({ startOrchestrator: false, corpus: "curated" });
    api.server.close();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Source is not connected"));
  });
});
