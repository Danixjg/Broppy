import { describe, expect, it } from "vitest";
import { connectFailure, pageFor, returnLocation, splitReturnPage, withReturnPage } from "./connect-return.js";

describe("returning from a source's approval page", () => {
  it("carries the setup page on the state and takes it off before the state is checked", () => {
    const href = "https://auth.example.test/authorize?client_id=x&state=abc_DEF-123";
    const tagged = withReturnPage(href, "setup");
    expect(new URL(tagged).searchParams.get("state")).toBe("abc_DEF-123.setup");
    expect(splitReturnPage("abc_DEF-123.setup")).toEqual({ state: "abc_DEF-123", page: "setup" });
    expect(splitReturnPage("abc_DEF-123")).toEqual({ state: "abc_DEF-123", page: "connectors" });
    expect(withReturnPage(href, "connectors")).toBe(href);
    expect(withReturnPage("https://auth.example.test/authorize?client_id=x", "setup")).toBe("https://auth.example.test/authorize?client_id=x");
  });

  it("only returns to a page it knows", () => {
    expect(pageFor("setup")).toBe("setup");
    for (const value of [undefined, "", "connectors", "https://evil.test", "../x"]) expect(pageFor(value)).toBe("connectors");
  });

  it("builds the address on the workspace host with the outcome", () => {
    expect(returnLocation("https://app.example.test", "setup", { connected: "jira" })).toBe("https://app.example.test/workspace/setup.html?connected=jira");
    expect(returnLocation("https://app.example.test/", "connectors", { connect_failed: "slack", reason: "denied" }))
      .toBe("https://app.example.test/workspace/connectors.html?connect_failed=slack&reason=denied");
  });

  it("names why a connection failed", () => {
    expect(connectFailure(new Error("Source identity could not be matched"), "")).toBe("email_mismatch");
    expect(connectFailure(new Error("Invalid OAuth state"), "")).toBe("expired");
    expect(connectFailure(new Error("Forbidden"), "")).toBe("not_admin");
    expect(connectFailure(new Error("Source OAuth exchange failed"), "")).toBe("failed");
    expect(connectFailure(new Error("anything"), "access_denied")).toBe("denied");
    expect(connectFailure("odd", "")).toBe("failed");
  });
});
