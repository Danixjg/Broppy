import { NextResponse, type NextRequest } from "next/server";

// The public demo: fictional people and data served by a separate, mock-only API. A visitor enters it through /demo,
// which sets this cookie; it only selects the mode, never an identity.
export const DEMO_COOKIE = "brain_demo";

/** The demo API's origin when this deployment offers the demo. */
export function demoApiUrl(): string | undefined {
  const value = process.env.DEMO_API_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function wantsDemo(request: NextRequest): boolean {
  return Boolean(demoApiUrl()) && request.cookies.get(DEMO_COOKIE)?.value === "1";
}

/**
 * The origin the browser used. Next's own request URL can name another host (localhost for 127.0.0.1), and cookies
 * and Origin headers follow the browser's host.
 */
export function browserOrigin(request: NextRequest): string {
  const first = (name: string) => request.headers.get(name)?.split(",")[0].trim() || undefined;
  const host = first("x-forwarded-host") ?? first("host") ?? request.nextUrl.host;
  const protocol = first("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return `${protocol}://${host}`;
}

export function sameHostRedirect(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, browserOrigin(request)));
}
