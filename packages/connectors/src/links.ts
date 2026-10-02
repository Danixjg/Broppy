import type { SourceDocument } from "@brain/types";

// Links are read from what a source itself says, never guessed from similar words: Jira issue keys, and links to a
// Jira issue, Confluence page, Slack channel or Drive file. They are item IDs, and one counts only where an item with
// that ID exists, so "UTF-8" or a link to another company's Jira simply goes nowhere useful.
const ISSUE_KEY = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-\d+)(?![A-Za-z0-9-])/g;
const LINK = /https?:\/\/[^\s<>|"'`)\]]+/g;
const KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** The item a link points at, recognised by its path, whatever the host. */
export function linkFromUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const path = url.pathname;
  const issue = path.match(/\/browse\/([^/]+)\/?$/)?.[1];
  if (issue && KEY.test(issue)) return `jira:${issue}`;
  const page = url.searchParams.get("pageId") ?? path.match(/\/pages\/(\d+)(?:\/|$)/)?.[1];
  if (page && /^\d+$/.test(page)) return `confluence:${page}`;
  const channel = path.match(/\/archives\/([CGD][A-Z0-9]+)(?:\/|$)/)?.[1] ??
    path.match(/^\/client\/[A-Z0-9]+\/([CGD][A-Z0-9]+)(?:\/|$)/)?.[1];
  if (channel) return `slack:${channel}`;
  const file = path.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ??
    (path === "/open" ? url.searchParams.get("id") ?? undefined : undefined);
  if (file && /^[A-Za-z0-9_-]+$/.test(file)) return `drive:${file}`;
  return undefined;
}

/** The items a text links to: the issue keys it names and the links it contains, sorted. */
export function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const [link] of text.matchAll(LINK)) {
    const target = linkFromUrl(link.replace(/[.,;:!?]+$/, ""));
    if (target) found.add(target);
  }
  for (const [, key] of text.matchAll(ISSUE_KEY)) found.add(`jira:${key}`);
  return [...found].sort();
}

/** The document with its full set of links: those its source declares plus those in its text, never itself. */
export function withLinks<T extends SourceDocument>(doc: T): T {
  const links = new Set([...(doc.links ?? []), ...linksIn(doc.content)]);
  links.delete(doc.docId);
  return { ...doc, links: [...links].sort() };
}
