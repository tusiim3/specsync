/**
 * Shared pacing for all parallel calls to one provider.
 * - Optional steady rate (requests per minute) for known quotas.
 * - When any call is rate limited, every worker pauses until the provider's
 *   requested wait has passed, instead of each one hammering the API.
 */
export class RateGate {
  private nextSlot = 0;
  private pausedUntil = 0;

  constructor(
    private readonly requestsPerMinute?: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(): Promise<void> {
    const t = this.now();
    let slot = 0;
    if (this.requestsPerMinute) {
      // Reserve the slot before sleeping so parallel callers get distinct slots.
      slot = Math.max(t, this.nextSlot);
      this.nextSlot = slot + 60_000 / this.requestsPerMinute;
    }
    const target = Math.max(this.pausedUntil, slot);
    if (target > t) await this.sleep(target - t);
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}
