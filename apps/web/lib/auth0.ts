import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { pinnedOrganization } from "./company";

export const authConfigured = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID &&
  process.env.AUTH0_CLIENT_SECRET && process.env.AUTH0_SECRET && process.env.APP_BASE_URL);

// Auth0 only accepts an organization ID (org_...) here; a display name such as "Company A" makes every
// sign-in end in "authorization request parameter organization must be an organization id".
export const orgIdProblem = (id = process.env.AUTH0_ORG_ID): string | undefined =>
  id && !/^org_[A-Za-z0-9]+$/.test(id)
    ? "AUTH0_ORG_ID must be the organization's ID (it starts with org_), not its name. Copy it from Auth0 > Organizations > your organization > ID."
    : undefined;

export const auth0 = new Auth0Client({
  enableAccessTokenEndpoint: false,
  authorizationParameters: {
    scope: "openid profile email offline_access",
    ...(process.env.AUTH0_AUDIENCE ? { audience: process.env.AUTH0_AUDIENCE } : {}),
    // One fixed company until sign-up is open; then each visitor names theirs (see /signin) and the sign-in link carries it.
    ...(pinnedOrganization() ? { organization: pinnedOrganization() } : {})
  }
});
