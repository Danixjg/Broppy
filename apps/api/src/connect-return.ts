/**
 * Where the admin lands after approving access at a source. The guided setup page asks to be returned to; the
 * connectors page is the default. The choice rides on the OAuth state as a ".setup" suffix, which the source hands back
 * unchanged, and is removed before the state is checked, so the stored single-use state is never altered.
 */
export type ReturnPage = "setup" | "connectors";

const SUFFIX = ".setup";

export const pageFor = (via: unknown): ReturnPage => via === "setup" ? "setup" : "connectors";

/** The same sign-in link with the return page added to its state. */
export function withReturnPage(href: string, page: ReturnPage): string {
  if (page !== "setup") return href;
  const url = new URL(href);
  const state = url.searchParams.get("state");
  if (!state) return href;
  url.searchParams.set("state", state + SUFFIX);
  return url.href;
}

/** The state to check, and the page to return to, from the state a source sent back. */
export function splitReturnPage(state: string): { state: string; page: ReturnPage } {
  return state.endsWith(SUFFIX) ? { state: state.slice(0, -SUFFIX.length), page: "setup" } : { state, page: "connectors" };
}

/** Why a connection did not complete, in a word the setup page can turn into plain language. */
export type ConnectFailure = "denied" | "email_mismatch" | "expired" | "not_admin" | "failed";

export function connectFailure(error: unknown, sourceError: string): ConnectFailure {
  if (sourceError) return "denied";
  const message = error instanceof Error ? error.message : "";
  if (message === "Source identity could not be matched") return "email_mismatch";
  if (message === "Invalid OAuth state") return "expired";
  if (message === "Forbidden") return "not_admin";
  return "failed";
}

/** The workspace page to send the admin back to, with the outcome in the address for the page to show. */
export function returnLocation(webOrigin: string, page: ReturnPage, outcome: Record<string, string>): string {
  const url = new URL(`/workspace/${page === "setup" ? "setup" : "connectors"}.html`, webOrigin);
  for (const [name, value] of Object.entries(outcome)) url.searchParams.set(name, value);
  return url.href;
}
