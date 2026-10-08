import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Auth0Management } from "./auth0-management.js";
import { ManagementError } from "./auth0-management.js";
import type { Companies } from "./companies.js";
import { normalizeEmail, type UserDirectory } from "./user-directory.js";

export class SignupError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const EMAIL = /^[^\s@<>"',;:()[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const clean = (value: unknown, max: number) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The short address a company is known by at sign-in: lowercase letters, digits and hyphens. */
export function companyAddress(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

/** Counts events per key inside a window; used to keep a public form from being used to send mail or create companies in bulk. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Records one more event and says whether it is still within `max` per `windowMs`. */
  allow(key: string, max: number, windowMs: number): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(time => time > now - windowMs);
    if (recent.length >= max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    if (this.hits.size > 5000) this.hits.clear();
    this.hits.set(key, recent);
    return true;
  }
}

export interface SignupSettings {
  /** The Auth0 sign-in database every new company's organization uses (AUTH0_SIGNUP_CONNECTION_ID). */
  connectionId: string;
  /** When set, the form must carry this code, so a launch can be limited to people Broppy has told. */
  accessCode?: string;
  /** Companies created per hour by this instance, across everyone. */
  perHour?: number;
  /** False once sign-ups are closed: people can still find their company, but no new company is created. */
  open?: boolean;
  /** Called with a new company's organization ID, so the API serves it straight away. */
  onCreated?: (orgId: string) => void;
}

const HOUR = 3_600_000;

/**
 * A company signing itself up. It gets its own Auth0 organization, a row in the list of companies, and its first admin,
 * who is whoever can open the invitation sent to the work email given: the admin is never trusted from the form alone.
 * Nothing is created for an email that is already on a company's list, and the answer is the same either way, so the
 * form cannot be used to find out who has an account.
 */
export class Signup {
  private readonly limiter: Limiter;
  constructor(private readonly management: Auth0Management, private readonly companies: Companies,
    private readonly directoryFor: (orgId: string) => Pick<UserDirectory, "add">, private readonly settings: SignupSettings,
    private readonly random: () => string = () => randomBytes(3).toString("hex"), now: () => number = Date.now) {
    if (!settings.connectionId) throw new Error("Self-signup needs AUTH0_SIGNUP_CONNECTION_ID");
    this.limiter = new Limiter(now);
  }

  /** off: one company only. closed: companies that already signed up keep working, nobody new can. on: anyone can sign a company up. */
  static mode(env: NodeJS.ProcessEnv = process.env): "off" | "closed" | "on" {
    return env.SELF_SIGNUP === "on" ? "on" : env.SELF_SIGNUP === "closed" ? "closed" : "off";
  }

  async create(input: Record<string, unknown>): Promise<{ sent: true }> {
    if (this.settings.open === false) throw new SignupError(403, "Sign-ups are closed for now.");
    if (this.settings.accessCode) {
      const given = Buffer.from(typeof input.code === "string" ? input.code.trim() : "");
      const wanted = Buffer.from(this.settings.accessCode);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new SignupError(403, "That access code isn't right. Check it and try again.");
    }
    const company = clean(input.company, 60);
    const name = clean(input.name, 80);
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    if (company.length < 2 || companyAddress(company).length < 2) throw new SignupError(400, "Enter your company's name.");
    if (!name) throw new SignupError(400, "Enter your name.");
    if (!EMAIL.test(email) || email.length > 254) throw new SignupError(400, "Enter a valid work email address.");
    if (!this.limiter.allow(`email:${email}`, 3, HOUR) || !this.limiter.allow("all", this.settings.perHour ?? 20, HOUR)) {
      throw new SignupError(429, "Too many sign-ups just now. Try again in a little while.");
    }
    // Someone who already belongs to a company is not made the admin of another by a form. Answer as if it worked.
    if (await this.companies.emailInUse(email)) return { sent: true };

    const created = await this.createOrganization(company);
    try {
      await this.companies.register({ orgId: created.id, name: created.displayName, createdBy: email });
      await this.directoryFor(created.id).add({ id: adminId(email), name, email, role: "admin", groups: [] });
      await this.management.forOrg(created.id).invite(email, "Broppy");
    } catch (error) {
      await this.undo(created.id);
      if (error instanceof ManagementError) throw new SignupError(502, "We couldn't send your invitation email. Try again in a minute.");
      throw error;
    }
    this.settings.onCreated?.(created.id);
    console.info(JSON.stringify({ event: "company_created", orgId: created.id, name: created.name }));
    return { sent: true };
  }

  /** The Auth0 organization for a company name. The short address is made unique with a few random letters if it is taken. */
  private async createOrganization(company: string) {
    const base = companyAddress(company);
    for (let attempt = 0; attempt < 4; attempt++) {
      const name = attempt === 0 ? base : `${base.slice(0, 40)}-${this.random()}`;
      try { return await this.management.createOrganization({ name, displayName: company, connectionId: this.settings.connectionId }); }
      catch (error) {
        if (error instanceof ManagementError && error.status === 409) continue;
        if (error instanceof ManagementError) throw new SignupError(502, "We couldn't set up your company just now. Try again in a minute.");
        throw error;
      }
    }
    throw new SignupError(409, "That company name is taken. Add a word to it and try again.");
  }

  private async undo(orgId: string): Promise<void> {
    // Each step is attempted whatever the others do; leftovers are harmless once the company is not in the list.
    await this.companies.forgetPeople(orgId).catch(() => undefined);
    await this.companies.remove(orgId).catch(() => undefined);
    await this.management.deleteOrganization(orgId).catch(() => undefined);
  }

  /** The Auth0 organization and display name for a company address typed at sign-in, if it is one of ours. */
  async find(address: unknown): Promise<{ organization: string; name: string } | undefined> {
    const short = companyAddress(clean(address, 80));
    if (short.length < 2) return undefined;
    if (!this.limiter.allow("find", 120, 60_000)) throw new SignupError(429, "Too many tries. Wait a moment and try again.");
    const found = await this.management.findOrganization(short);
    if (!found || !await this.companies.isKnown(found.id)) return undefined;
    return { organization: found.id, name: found.displayName };
  }
}

const adminId = (email: string) => email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "admin";
