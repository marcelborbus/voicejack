import type { Scheduler } from './types.js';

/** Default scheduler; looks up the globals at call time so vitest fake timers apply. */
export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Named one-shot timers: setting a name again replaces the previous timer. */
export class Timers {
  private readonly handles = new Map<string, unknown>();

  constructor(private readonly scheduler: Scheduler) {}

  set(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    const h = this.scheduler.setTimeout(
      () => {
        this.handles.delete(name);
        fn();
      },
      Math.max(0, ms),
    );
    this.handles.set(name, h);
  }

  has(name: string): boolean {
    return this.handles.has(name);
  }

  clear(name: string): void {
    const h = this.handles.get(name);
    if (h !== undefined) {
      this.scheduler.clearTimeout(h);
      this.handles.delete(name);
    }
  }

  clearAll(): void {
    for (const h of this.handles.values()) this.scheduler.clearTimeout(h);
    this.handles.clear();
  }
}
