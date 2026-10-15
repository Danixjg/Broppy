import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextResponse } from "next/server";
import { pinnedOrganization } from "./company";

export const authConfigured = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID &&
  process.env.AUTH0_CLIENT_SECRET && process.env.AUTH0_SECRET && process.env.APP_BASE_URL);

// Auth0 only accepts an organization ID (org_...) here; a display name such as "Company A" makes every
// sign-in end in "authorization request parameter organization must be an organization id".
export const orgIdProblem = (id = process.env.AUTH0_ORG_ID): string | undefined =>
  id && !/^org_[A-Za-z0-9]+$/.test(id)
    ? "AUTH0_ORG_ID must be the organization's ID (it starts with org_), not its name. Copy it from Auth0 > Organizations > your organization > ID."
    : undefined;

/** Why a sign-in came back refused, in a word /signin turns into plain language. The raw reason is only logged. */
export function signInFailure(error: unknown): string {
  const parts: string[] = [];
  for (let item: unknown = error, depth = 0; item && depth < 4; item = (item as { cause?: unknown }).cause, depth++) {
    const value = item as { code?: unknown; error?: unknown; message?: unknown; error_description?: unknown };
    parts.push(...[value.code, value.error, value.message, value.error_description].filter((part): part is string => typeof part === "string"));
  }
  const text = parts.join(" ").toLowerCase();
  if (/invitation|invite/.test(text) && /expired|not found|invalid|used/.test(text)) return "invitation";
  if (/not (a )?(member|part) of|organization/.test(text) && /member|access/.test(text)) return "not_member";
  if (/access_denied|denied|cancel/.test(text)) return "denied";
  if (/state|expired|missing_transaction|transaction/.test(text)) return "expired";
  return "failed";
}

export const auth0 = new Auth0Client({
  enableAccessTokenEndpoint: false,
  // A refused sign-in goes back to the sign-in page with a plain reason, not a blank page showing Auth0's error text.
  onCallback: async (error, ctx) => {
    const base = ctx.appBaseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3001";
    if (error) {
      const reason = signInFailure(error);
      console.warn(JSON.stringify({ event: "sign_in_callback_failed", reason, detail: String((error as { cause?: { message?: string } }).cause?.message ?? error.message).slice(0, 200) }));
      return NextResponse.redirect(new URL(`/signin?error=${reason}`, base));
    }
    const target = ctx.returnTo && ctx.returnTo.startsWith("/") && !ctx.returnTo.startsWith("//") ? ctx.returnTo : "/";
    return NextResponse.redirect(new URL(target, base));
  },
  authorizationParameters: {
    scope: "openid profile email offline_access",
    ...(process.env.AUTH0_AUDIENCE ? { audience: process.env.AUTH0_AUDIENCE } : {}),
    // One fixed company until sign-up is open; then each visitor names theirs (see /signin) and the sign-in link carries it.
    ...(pinnedOrganization() ? { organization: pinnedOrganization() } : {})
  }
});
