import { describe, expect, it } from "vitest";
import type { SourceDocument } from "@brain/types";
import { linkFromUrl, linksIn, withLinks } from "./links.js";

describe("links a source makes", () => {
  const origins = { jira: ["https://acme.atlassian.net", "https://jira.example"],
    confluence: ["https://acme.atlassian.net"], slack: ["https://acme.slack.com", "https://app.slack.com"] };
  it("reads issue keys from text", () => {
    expect(linksIn("Blocked on DB-15, then PAY-101 (see SEC-44).")).toEqual(["jira:DB-15", "jira:PAY-101", "jira:SEC-44"]);
    expect(linksIn("db-15 is lowercase, and X-1 or PAY-ABC are not keys")).toEqual([]);
  });

  it("reads links to configured sites and supported Google hosts", () => {
    expect(linkFromUrl("https://acme.atlassian.net/browse/SEC-44", origins)).toBe("jira:SEC-44");
    expect(linkFromUrl("https://jira.example/browse/DB-12?focusedCommentId=1", origins)).toBe("jira:DB-12");
    expect(linkFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/12345/Cutover+plan", origins)).toBe("confluence:12345");
    expect(linkFromUrl("https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=678", origins)).toBe("confluence:678");
    expect(linkFromUrl("https://acme.slack.com/archives/C0123ABC/p1700000000000100", origins)).toBe("slack:C0123ABC");
    expect(linkFromUrl("https://app.slack.com/client/T0001/C0456DEF", origins)).toBe("slack:C0456DEF");
    expect(linkFromUrl("https://docs.google.com/document/d/1AbCdEf_GhIj/edit", origins)).toBe("drive:1AbCdEf_GhIj");
    expect(linkFromUrl("https://drive.google.com/file/d/xyz-123/view", origins)).toBe("drive:xyz-123");
    expect(linkFromUrl("https://drive.google.com/open?id=abc_9", origins)).toBe("drive:abc_9");
    expect(linkFromUrl("https://example.test/about", origins)).toBeUndefined();
    expect(linkFromUrl("not a url", origins)).toBeUndefined();
  });

  it("reads Slack's <url|label> links and plain links in text", () => {
    expect(linksIn("<https://acme.slack.com/archives/C0123ABC/p1|the thread> and https://acme.atlassian.net/browse/DB-12.", origins))
      .toEqual(["jira:DB-12", "slack:C0123ABC"]);
  });

  it("does not turn foreign URLs into local relationships through their issue keys or lookalike paths", () => {
    expect(linkFromUrl("https://foreign.atlassian.net/browse/DB-12", origins)).toBeUndefined();
    expect(linkFromUrl("https://evil.test/document/d/private", origins)).toBeUndefined();
    expect(linksIn("See https://foreign.atlassian.net/browse/DB-12 and PAY-101.", origins)).toEqual(["jira:PAY-101"]);
    expect(linkFromUrl("https://acme.atlassian.net/browse/DB-12")).toBeUndefined();
  });

  it("adds a document's text links to the ones its source declares, never itself", () => {
    const doc: SourceDocument = {
      docId: "jira:DB-12", source: "jira", sourceNativeId: "DB-12", title: "DB-12 Ledger", url: "https://jira.example/browse/DB-12",
      content: "DB-12 waits on DB-15.", version: 1, updatedAt: "2026-09-28T03:00:00.000Z", metadata: {},
      permissions: { users: [], groups: [], public: false }, tier: "internal", links: ["slack:db-migration", "jira:DB-15"]
    };
    expect(withLinks(doc).links).toEqual(["jira:DB-15", "slack:db-migration"]);
    expect(withLinks({ ...doc, links: undefined, content: "No links here." }).links).toEqual([]);
  });
});
