/** off: one company, set up by hand. closed: companies that already signed up can sign in, no new ones. on: anyone can sign a company up. */
export type SignupMode = "off" | "closed" | "on";

export const signupMode = (): SignupMode =>
  process.env.SELF_SIGNUP === "on" ? "on" : process.env.SELF_SIGNUP === "closed" ? "closed" : "off";

/** Whether sign-in starts by asking for the company, instead of going to a single fixed company. */
export const asksForCompany = (): boolean => signupMode() !== "off";

export const needsAccessCode = (): boolean => process.env.SIGNUP_NEEDS_CODE === "on";

/** The company a plain sign-in is limited to. Several companies share this site once sign-up is open, so then none. */
export const pinnedOrganization = (): string | undefined =>
  signupMode() === "off" ? process.env.AUTH0_ORG_ID || undefined : undefined;

export const apiOrigin = (): string | undefined => {
  const value = process.env.BRAIN_API_URL;
  if (!value) return process.env.VERCEL ? undefined : "http://127.0.0.1:3000";
  try { return new URL(value).origin; } catch { return undefined; }
};

/** The page to sign in to when a visitor is not signed in. */
export const signInPath = (returnTo?: string): string =>
  asksForCompany() ? `/signin${returnTo ? `?${new URLSearchParams({ returnTo })}` : ""}`
    : `/auth/login${returnTo ? `?${new URLSearchParams({ returnTo })}` : ""}`;

/** A path on this site, or the workspace when the value is anything else. */
export const safeReturn = (value: unknown): string =>
  typeof value === "string" && /^\/(?!\/)[A-Za-z0-9/_.\-?=&%]*$/.test(value) && !value.includes("..") && value.length < 300 ? value : "/workspace/index.html";
