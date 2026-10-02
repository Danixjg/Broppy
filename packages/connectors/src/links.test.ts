import { describe, expect, it } from "vitest";
import type { SourceDocument } from "@brain/types";
import { linkFromUrl, linksIn, withLinks } from "./links.js";

describe("links a source makes", () => {
  it("reads issue keys from text", () => {
    expect(linksIn("Blocked on DB-15, then PAY-101 (see SEC-44).")).toEqual(["jira:DB-15", "jira:PAY-101", "jira:SEC-44"]);
    expect(linksIn("db-15 is lowercase, and X-1 or PAY-ABC are not keys")).toEqual([]);
  });

  it("reads links to each platform, whatever the host", () => {
    expect(linkFromUrl("https://acme.atlassian.net/browse/SEC-44")).toBe("jira:SEC-44");
    expect(linkFromUrl("https://jira.example/browse/DB-12?focusedCommentId=1")).toBe("jira:DB-12");
    expect(linkFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/12345/Cutover+plan")).toBe("confluence:12345");
    expect(linkFromUrl("https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=678")).toBe("confluence:678");
    expect(linkFromUrl("https://acme.slack.com/archives/C0123ABC/p1700000000000100")).toBe("slack:C0123ABC");
    expect(linkFromUrl("https://app.slack.com/client/T0001/C0456DEF")).toBe("slack:C0456DEF");
    expect(linkFromUrl("https://docs.google.com/document/d/1AbCdEf_GhIj/edit")).toBe("drive:1AbCdEf_GhIj");
    expect(linkFromUrl("https://drive.google.com/file/d/xyz-123/view")).toBe("drive:xyz-123");
    expect(linkFromUrl("https://drive.google.com/open?id=abc_9")).toBe("drive:abc_9");
    expect(linkFromUrl("https://example.test/about")).toBeUndefined();
    expect(linkFromUrl("not a url")).toBeUndefined();
  });

  it("reads Slack's <url|label> links and plain links in text", () => {
    expect(linksIn("<https://acme.slack.com/archives/C0123ABC/p1|the thread> and https://acme.atlassian.net/browse/DB-12."))
      .toEqual(["jira:DB-12", "slack:C0123ABC"]);
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
