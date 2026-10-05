import { createHash } from "node:crypto";
import type { Source } from "@brain/types";

export type ProviderConfig = { clientId: string; clientSecret: string; scopes: string[]; baseUrl?: string; cloudId?: string };

/** Everything that differs between providers' OAuth flows. SourceOAuth runs the shared flow and asks the provider for these parts. */
export interface OAuthProvider {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** Provider-specific parameters added to the authorization request. */
  authorizeParams(config: ProviderConfig, verifier: string): Record<string, string>;
  /** Token endpoint request body, in the encoding this provider expects. */
  tokenRequest(config: ProviderConfig, values: Record<string, string>): { contentType: string; body: string | URLSearchParams };
  /** The token object inside the provider's response, or undefined when the response reports an error. */
  tokens(raw: any): any;
  /** Extra values the token request needs for this flow (Drive's PKCE verifier). */
  exchangeValues(verifier: string): Record<string, string>;
  /** Where to ask who the token belongs to, and how to read their email from the answer. */
  profileUrl(tokens: any): string;
  email(profile: any): unknown;
  /** Atlassian tokens are tied to a site that has to be discovered after sign-in. */
  readonly sites: boolean;
}

const form = (config: ProviderConfig, values: Record<string, string>) =>
  ({ contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }) });

const slack: OAuthProvider = {
  authorizeUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", sites: false,
  authorizeParams: config => ({ user_scope: config.scopes.join(",") }),
  tokenRequest: form,
  tokens: raw => raw.ok === false ? undefined : raw.authed_user ?? raw,
  exchangeValues: () => ({}),
  profileUrl: tokens => `https://slack.com/api/users.info?user=${encodeURIComponent(tokens.id ?? "")}`,
  email: profile => profile.user?.profile?.email
};

const atlassian: OAuthProvider = {
  authorizeUrl: "https://auth.atlassian.com/authorize", tokenUrl: "https://auth.atlassian.com/oauth/token", sites: true,
  authorizeParams: config => ({ scope: config.scopes.join(" "), audience: "api.atlassian.com", prompt: "consent" }),
  tokenRequest: (config, values) => ({ contentType: "application/json", body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...values }) }),
  tokens: raw => raw,
  exchangeValues: () => ({}),
  profileUrl: () => "https://api.atlassian.com/me",
  email: profile => profile.email
};

const drive: OAuthProvider = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", sites: false,
  authorizeParams: (config, verifier) => ({ scope: config.scopes.join(" "), access_type: "offline", prompt: "consent", code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url") }),
  tokenRequest: form,
  tokens: raw => raw,
  exchangeValues: verifier => ({ code_verifier: verifier }),
  profileUrl: () => "https://www.googleapis.com/oauth2/v3/userinfo",
  email: profile => profile.email
};

/** Adding a source to Broppy's sign-in means adding one entry here. */
export const oauthProviders: Record<Source, OAuthProvider> = { slack, jira: atlassian, confluence: atlassian, drive };
