interface ManagementOptions {
  issuer: string;
  orgId: string;
  /** The web application's client ID: invited people land on its login page. */
  appClientId: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Auth0 refused or could not complete a Management API call. The message is safe to show an admin. */
export class ManagementError extends Error {}

const INVITATION_TTL_SECONDS = 7 * 24 * 3600;

/**
 * The few Auth0 Management API calls that onboarding needs, for the one organization this API serves: invite an
 * email to the organization, withdraw the invitation, and add or remove a member. It uses its own machine-to-machine
 * application, never the web application's secret.
 */
export class Auth0Management {
  private cached?: { token: string; expires: number };
  private readonly transport: typeof fetch;

  constructor(private readonly options: ManagementOptions) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" || issuer.pathname !== "/" || options.issuer !== issuer.href ||
      !options.orgId || !options.appClientId || !options.clientId || !options.clientSecret) {
      throw new Error("Invalid Auth0 management configuration");
    }
    this.transport = options.fetch ?? fetch;
  }

  /** Configured only when all four settings are present; invitations are then sent from the admin's People page. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Auth0Management | undefined {
    const settings = [env.AUTH0_MANAGEMENT_CLIENT_ID, env.AUTH0_MANAGEMENT_CLIENT_SECRET, env.AUTH0_CLIENT_ID];
    if (!settings.some(Boolean)) return undefined;
    if (!settings.every(Boolean)) throw new Error("Auth0 invitations need AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET and AUTH0_CLIENT_ID");
    return new Auth0Management({ issuer: env.AUTH0_ISSUER ?? "", orgId: env.AUTH0_ORG_ID ?? "", appClientId: env.AUTH0_CLIENT_ID!,
      clientId: env.AUTH0_MANAGEMENT_CLIENT_ID!, clientSecret: env.AUTH0_MANAGEMENT_CLIENT_SECRET! });
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const issuer = this.options.issuer;
    const response = await this.transport(new URL(`api/v2/${path}`, issuer), {
      method: init.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const text = await response.text();
    if (!response.ok) throw new ManagementError(`Auth0 refused the request (${response.status})${reason(text)}`);
    return text ? JSON.parse(text) : undefined;
  }

  private async token(): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && this.cached.expires > now) return this.cached.token;
    const response = await this.transport(new URL("oauth/token", this.options.issuer), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: this.options.clientId,
        client_secret: this.options.clientSecret, audience: new URL("api/v2/", this.options.issuer).href })
    });
    const text = await response.text();
    if (!response.ok) throw new ManagementError(`Auth0 did not accept the management application (${response.status})${reason(text)}`);
    const token = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof token.access_token !== "string") throw new ManagementError("Auth0 returned no management token");
    const seconds = typeof token.expires_in === "number" ? token.expires_in : 300;
    this.cached = { token: token.access_token, expires: now + Math.max(seconds - 60, 0) * 1000 };
    return token.access_token;
  }

  private get org(): string { return encodeURIComponent(this.options.orgId); }

  /** Emails the person a link to join the organization. */
  async invite(email: string, inviterName: string): Promise<void> {
    await this.call(`organizations/${this.org}/invitations`, { method: "POST", body: {
      inviter: { name: inviterName.slice(0, 300) }, invitee: { email }, client_id: this.options.appClientId,
      ttl_sec: INVITATION_TTL_SECONDS, send_invitation_email: true } });
  }

  /** Withdraws every open invitation for this email, so a resend never leaves two links alive. */
  async revokeInvitations(email: string): Promise<void> {
    const wanted = email.toLowerCase();
    for (let page = 0; page < 10; page++) {
      const found = await this.call(`organizations/${this.org}/invitations?per_page=100&page=${page}&fields=id,invitee`);
      if (!Array.isArray(found)) return;
      for (const invitation of found as Array<{ id?: unknown; invitee?: { email?: unknown } }>) {
        if (typeof invitation.id === "string" && String(invitation.invitee?.email).toLowerCase() === wanted) {
          await this.call(`organizations/${this.org}/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE" });
        }
      }
      if (found.length < 100) return;
    }
  }

  async addMember(sub: string): Promise<void> {
    await this.call(`organizations/${this.org}/members`, { method: "POST", body: { members: [sub] } });
  }

  async removeMember(sub: string): Promise<void> {
    await this.call(`organizations/${this.org}/members`, { method: "DELETE", body: { members: [sub] } });
  }
}

function reason(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; error_description?: unknown };
    const detail = [body.error, body.error_description ?? body.message].filter(value => typeof value === "string").join(": ");
    return detail ? `: ${detail.slice(0, 300)}` : "";
  } catch { return ""; }
}
