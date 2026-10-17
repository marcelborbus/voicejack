/**
 * Caps guest-account creation: per client IP and globally, in fixed windows. In memory only;
 * a restart resets it, which is fine for an abuse brake.
 */
export interface GuestLimits {
  perIp: number;
  global: number;
  windowMs: number;
}

export const GUEST_LIMITS: GuestLimits = { perIp: 20, global: 600, windowMs: 3600_000 };

export class GuestLimiter {
  private windowStart = 0;
  private total = 0;
  private perIp = new Map<string, number>();

  constructor(
    private readonly limits: GuestLimits = GUEST_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one creation for `ip`; false if a limit is hit (nothing is counted then). */
  take(ip: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.limits.windowMs) {
      this.windowStart = t;
      this.total = 0;
      this.perIp.clear();
    }
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.limits.perIp || this.total >= this.limits.global) return false;
    this.perIp.set(ip, n + 1);
    this.total++;
    return true;
  }
}
