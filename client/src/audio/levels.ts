// Pure helpers for level metering and the micOk detector (unit-tested).

export const MIC_OK_THRESHOLD_DB = -50;
export const MIC_OK_MIN_MS = 300;
export const MIC_OK_WINDOW_MS = 5000;
export const SILENCE_DB = -100;

/** RMS of a float PCM frame. */
export function rms(frame: ArrayLike<number>): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** Linear amplitude → dBFS, floored at SILENCE_DB. */
export function toDb(linear: number): number {
  if (!(linear > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(linear));
}

/** Map dBFS to 0..1 for a meter (-60 dB → 0, 0 dB → 1). */
export function dbToMeter(db: number, floorDb = -60): number {
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

/**
 * micOk detector: "RMS above -50 dBFS for at least 300 ms (cumulative) within the last 5 s".
 * Feed it `(timeMs, dbfs)` samples at any rate. Each sample counts for the time until the next
 * one (capped at 200 ms so a stalled timer can't fake a long signal). Once detected it latches:
 * a quiet player must not lose their ready state; only `reset()` (mic lost) clears it.
 */
export class MicOkDetector {
  private samples: { t: number; loud: boolean }[] = [];
  private _ok = false;
  constructor(
    private readonly thresholdDb = MIC_OK_THRESHOLD_DB,
    private readonly minMs = MIC_OK_MIN_MS,
    private readonly windowMs = MIC_OK_WINDOW_MS,
  ) {}

  get ok(): boolean {
    return this._ok;
  }

  /** Returns the (latched) ok state after adding the sample. */
  push(t: number, db: number): boolean {
    this.samples.push({ t, loud: db > this.thresholdDb });
    const from = t - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.t < from) this.samples.shift();
    if (!this._ok && this.loudMs() >= this.minMs) this._ok = true;
    return this._ok;
  }

  /** Cumulative loud time inside the window, in ms. */
  loudMs(): number {
    let total = 0;
    for (let i = 0; i + 1 < this.samples.length; i++) {
      const a = this.samples[i]!;
      if (a.loud) total += Math.min(200, this.samples[i + 1]!.t - a.t);
    }
    return total;
  }

  /** Progress 0..1 towards detection (for UI). */
  progress(): number {
    return this._ok ? 1 : Math.min(1, this.loudMs() / this.minMs);
  }

  reset(): void {
    this.samples = [];
    this._ok = false;
  }
}
