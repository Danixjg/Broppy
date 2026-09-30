import { Auth0Client } from "@auth0/nextjs-auth0/server";

export const authConfigured = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID &&
  process.env.AUTH0_CLIENT_SECRET && process.env.AUTH0_SECRET && process.env.APP_BASE_URL);

export const auth0 = new Auth0Client({
  enableAccessTokenEndpoint: false,
  authorizationParameters: {
    scope: "openid profile email offline_access",
    ...(process.env.AUTH0_AUDIENCE ? { audience: process.env.AUTH0_AUDIENCE } : {}),
    ...(process.env.AUTH0_ORG_ID ? { organization: process.env.AUTH0_ORG_ID } : {})
  }
});
