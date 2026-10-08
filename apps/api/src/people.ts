import type { Source, User } from "@brain/types";
import type { Auth0Management } from "./auth0-management.js";
import { DirectoryConflict, emailIdentities, normalizeEmail, SOURCES, type UserDirectory } from "./user-directory.js";

export class PeopleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** What happened to the Auth0 side of a change. The directory change itself has always been made when this is returned. */
export type Auth0Outcome = "invited" | "restored" | "withdrawn" | "not_configured" | "failed";

export interface Person {
  id: string;
  name: string;
  email: string;
  role: User["role"];
  groups: string[];
  /** invited: added but not signed in yet. active: signed in. removed: access withdrawn. */
  status: "invited" | "active" | "removed";
  /** The person's account at each source: normally their work email. A source with none shows them nothing. */
  identities: Partial<Record<Source, string>>;
}

export interface PersonResult { person: Person; auth0: Auth0Outcome; auth0Error?: string }

const EMAIL = /^[^\s@<>"',;:()[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const ROLES: User["role"][] = ["member", "admin", "compliance"];

const view = (user: User): Person => ({ id: user.id, name: user.name, email: user.email, role: user.role, groups: user.groups,
  status: user.active !== true ? "removed" : user.auth0Sub ? "active" : "invited", identities: { ...user.platformIdentities } });

/**
 * The admin's list of who may use Broppy. Adding an email creates its directory entry and asks Auth0 to invite it to the
 * organization; the entry becomes the person's own at their first verified sign-in (see Auth0TokenValidator).
 * Removing withdraws access at once, in the directory, whatever Auth0 does.
 */
export class People {
  constructor(private readonly directory: UserDirectory, private readonly management?: Auth0Management) {}

  /** Whether adding someone also emails them an Auth0 invitation. */
  get canInvite(): boolean { return this.management !== undefined; }

  async list(): Promise<Person[]> { return (await this.directory.list()).map(view); }

  async add(actor: User, input: Record<string, unknown>): Promise<PersonResult> {
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    if (!EMAIL.test(email) || email.length > 254) throw new PeopleError(400, "Enter a valid work email address.");
    const role = input.role === undefined ? "member" : ROLES.find(item => item === input.role);
    if (!role) throw new PeopleError(400, "Choose member, admin or compliance.");
    const groups = parseGroups(input.groups);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : email.split("@")[0];

    const existing = await this.directory.byEmail(email);
    if (existing?.active === true) throw new PeopleError(409, "This email is already on the list.");
    let user: User | undefined;
    if (existing) {
      user = await this.directory.update(existing.id, { active: true, role });
    } else {
      for (let attempt = 1; !user && attempt <= 5; attempt++) {
        try { user = await this.directory.add({ id: slug(email, attempt), name, email, role, groups }); }
        catch (error) {
          if (!(error instanceof DirectoryConflict)) throw error;
          // The ID can be taken by a namesake; the same email can have been added a moment ago.
          if (await this.directory.byEmail(email)) throw new PeopleError(409, "This email is already on the list.");
        }
      }
    }
    if (!user) throw new PeopleError(409, "Could not add this person. Try again.");
    // Someone who had signed in before is already a user in Auth0, so they rejoin the organization instead of being invited again.
    return { person: view(user), ...await this.provision(actor, user, user.auth0Sub ? "restore" : "invite") };
  }

  async invite(actor: User, id: string): Promise<PersonResult> {
    const user = await this.find(id);
    if (user.active !== true) throw new PeopleError(409, "This person was removed. Add their email again to give them access.");
    if (user.auth0Sub) throw new PeopleError(409, "This person has already signed in.");
    return { person: view(user), ...await this.provision(actor, user, "invite") };
  }

  async remove(actor: User, id: string): Promise<PersonResult> {
    const user = await this.find(id);
    if (user.id === actor.id) throw new PeopleError(409, "You can't remove your own access.");
    if (user.active !== true) throw new PeopleError(409, "This person was already removed.");
    if (user.role === "admin" && (await this.directory.list()).filter(item => item.active === true && item.role === "admin").length < 2) {
      throw new PeopleError(409, "Broppy needs at least one admin. Make someone else an admin first.");
    }
    // Access ends here, before Auth0 is asked to do anything, so a failure there cannot leave the person with access.
    const removed = await this.directory.update(user.id, { active: false });
    if (!removed) throw new PeopleError(404, "Not found");
    if (!this.management) return { person: view(removed), auth0: "not_configured" };
    try {
      await this.management.revokeInvitations(user.email);
      if (user.auth0Sub) await this.management.removeMember(user.auth0Sub);
      return { person: view(removed), auth0: "withdrawn" };
    } catch (error) {
      return { person: view(removed), auth0: "failed", auth0Error: message(error) };
    }
  }

  /**
   * Sets the person's account at one or more sources, for people whose account there uses another email. An empty value
   * puts the work email back. Only the sources named change.
   */
  async setIdentities(id: string, input: unknown): Promise<{ person: Person; user: User }> {
    const user = await this.find(id);
    if (user.active !== true) throw new PeopleError(409, "This person was removed.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PeopleError(400, "Send the sources to change.");
    const next: Partial<Record<Source, string>> = { ...user.platformIdentities };
    let changed = 0;
    for (const [source, value] of Object.entries(input)) {
      if (!SOURCES.includes(source as Source)) throw new PeopleError(400, `Unknown source: ${source.slice(0, 20)}.`);
      if (typeof value !== "string") throw new PeopleError(400, "Each account must be an email address.");
      const identity = value.trim() ? normalizeEmail(value) : user.email;
      if (!EMAIL.test(identity) || identity.length > 254) throw new PeopleError(400, `Enter a valid email for ${source}.`);
      next[source as Source] = identity; changed++;
    }
    if (!changed) throw new PeopleError(400, "Send the sources to change.");
    const updated = await this.directory.setIdentities(user.id, next);
    if (!updated) throw new PeopleError(404, "Not found");
    return { person: view(updated), user: updated };
  }

  /** Gives every active person the work email for any source they have no account for. Returns how many people changed. */
  async fillMissingIdentities(): Promise<number> {
    let filled = 0;
    for (const user of await this.directory.list()) {
      if (user.active !== true) continue;
      const missing = SOURCES.filter(source => !user.platformIdentities?.[source]);
      if (!missing.length) continue;
      const next = { ...user.platformIdentities, ...Object.fromEntries(missing.map(source => [source, emailIdentities(user.email)[source]])) };
      if (await this.directory.setIdentities(user.id, next)) filled++;
    }
    return filled;
  }

  /** The same fill for one person who just signed in, so their first answers already count their accounts. */
  async ensureIdentities(user: User): Promise<void> {
    const missing = SOURCES.filter(source => !user.platformIdentities?.[source]);
    if (!missing.length || user.active !== true) return;
    const next = { ...user.platformIdentities, ...Object.fromEntries(missing.map(source => [source, emailIdentities(user.email)[source]])) } as User["platformIdentities"];
    if (await this.directory.setIdentities(user.id, next!)) user.platformIdentities = next;
  }

  private async find(id: string): Promise<User> {
    const user = (await this.directory.list()).find(item => item.id === id);
    if (!user) throw new PeopleError(404, "Not found");
    return user;
  }

  private async provision(actor: User, user: User, how: "invite" | "restore"): Promise<{ auth0: Auth0Outcome; auth0Error?: string }> {
    if (!this.management) return { auth0: "not_configured" };
    try {
      if (how === "restore") await this.management.addMember(user.auth0Sub);
      else {
        // A resend replaces the earlier link, so only the newest one works.
        await this.management.revokeInvitations(user.email);
        await this.management.invite(user.email, actor.name);
      }
      return { auth0: how === "restore" ? "restored" : "invited" };
    } catch (error) { return { auth0: "failed", auth0Error: message(error) }; }
  }
}

const message = (error: unknown): string => error instanceof Error ? error.message : "Auth0 could not be reached";

function parseGroups(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every(group => typeof group === "string" && group.trim() && group.length <= 64)) {
    throw new PeopleError(400, "Groups must be a short list of names.");
  }
  return [...new Set(value.map((group: string) => group.trim()))];
}

/** A stable lowercase ID from the part of the email before the @, with a number when a namesake already has it. */
function slug(email: string, attempt: number): string {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
  return attempt === 1 ? base : `${base}-${attempt}`;
}
