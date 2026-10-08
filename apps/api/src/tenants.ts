/**
 * One workspace per company, built when the company's first request arrives and kept while the instance stays warm.
 * The company set up by hand is built up front and never dropped; the rest are dropped oldest-first beyond `max`, and
 * are simply built again from the database the next time.
 */
export interface TenantOptions<T> {
  homeOrgId: string;
  home: T;
  /** Whether the organization may use this API at all. Called before anything is built. */
  isKnown(orgId: string): Promise<boolean>;
  build(orgId: string): Promise<T>;
  /** Called for a workspace that is dropped, so its timers can stop. */
  drop?(tenant: T): void;
  max?: number;
  now?: () => number;
}

const KNOWN_FOR_MS = 60_000;
const UNKNOWN_FOR_MS = 15_000;
const IN_USE_MS = 60_000;

export class TenantRegistry<T> {
  private readonly built = new Map<string, T>();
  private readonly lastUsed = new Map<string, number>();
  private readonly building = new Map<string, Promise<T>>();
  private readonly verdicts = new Map<string, { known: boolean; until: number }>();

  constructor(private readonly options: TenantOptions<T>) {}

  /** Every workspace built so far, the home company's first. */
  all(): T[] { return [this.options.home, ...this.built.values()]; }

  /** The company's workspace, or nothing when the organization is not one of ours. */
  async get(orgId: string | undefined): Promise<T | undefined> {
    if (!orgId) return undefined;
    if (orgId === this.options.homeOrgId) return this.options.home;
    const existing = this.built.get(orgId);
    if (existing) {
      this.built.delete(orgId); this.built.set(orgId, existing);
      this.lastUsed.set(orgId, (this.options.now ?? Date.now)());
      return await this.stillKnown(orgId) ? existing : undefined;
    }
    if (!await this.stillKnown(orgId)) return undefined;
    let pending = this.building.get(orgId);
    if (!pending) {
      pending = this.options.build(orgId).then(tenant => { this.keep(orgId, tenant); return tenant; });
      this.building.set(orgId, pending);
      const forget = () => { if (this.building.get(orgId) === pending) this.building.delete(orgId); };
      pending.then(forget, forget);
    }
    return await pending;
  }

  private async stillKnown(orgId: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const verdict = this.verdicts.get(orgId);
    if (verdict && verdict.until > now) return verdict.known;
    const known = await this.options.isKnown(orgId);
    if (this.verdicts.size > 1000) this.verdicts.clear();
    this.verdicts.set(orgId, { known, until: now + (known ? KNOWN_FOR_MS : UNKNOWN_FOR_MS) });
    if (!known) this.release(orgId);
    return known;
  }

  /** Drops a company's workspace, for a company that was suspended or removed. */
  release(orgId: string): void {
    const tenant = this.built.get(orgId);
    if (tenant === undefined) return;
    this.built.delete(orgId); this.lastUsed.delete(orgId);
    this.options.drop?.(tenant);
  }

  /** A company that has just been created is known at once, without waiting for the next check. */
  markKnown(orgId: string): void {
    this.verdicts.set(orgId, { known: true, until: (this.options.now ?? Date.now)() + KNOWN_FOR_MS });
  }

  /**
   * Remembers a built workspace and, beyond `max`, drops the one unused the longest. A workspace used in the last minute is
   * never dropped, so a request still running on it never ends up alongside a second copy writing to the same company.
   */
  private keep(orgId: string, tenant: T): void {
    const now = (this.options.now ?? Date.now)();
    this.built.set(orgId, tenant); this.lastUsed.set(orgId, now);
    const max = this.options.max ?? 25;
    for (const candidate of [...this.built.keys()]) {
      if (this.built.size <= max) break;
      if (candidate === orgId || now - (this.lastUsed.get(candidate) ?? 0) < IN_USE_MS) continue;
      const dropped = this.built.get(candidate)!;
      this.built.delete(candidate); this.lastUsed.delete(candidate);
      this.options.drop?.(dropped);
    }
  }
}
