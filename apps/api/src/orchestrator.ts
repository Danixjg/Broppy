import type { Brain } from "./brain.js";

export class SyncOrchestrator {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly brain: Brain,
    private readonly intervalMs = 30_000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.brain.syncAll();
      this.brain.audit.seal();
      await this.brain.persist();
    } catch {
      // Sync state keeps the checkpoint; the next interval resumes from it.
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
