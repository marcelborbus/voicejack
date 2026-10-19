import { PEAKS_PER_SEC } from '@/dub/chunkLoader';

/**
 * Live waveform of the take being recorded, drawn incrementally: level samples go into 10 ms
 * buckets (`push`), and `drawNew` emits only the bars whose time span is complete. Every loop
 * here is bounded by the canvas width / the take length, whatever the clocks report.
 */
export class RecordingBars {
  private readonly levels: Float32Array;
  private lastBucket = -1;
  private drawnX = 0;
  private readonly bar: number;
  private readonly step: number;
  private readonly msPerPx: number;

  constructor(
    private readonly spanMs: number,
    private readonly w: number,
    private readonly h: number,
    private readonly dpr = 1,
  ) {
    this.levels = new Float32Array(Math.max(1, Math.ceil((spanMs * PEAKS_PER_SEC) / 1000) + 1));
    this.bar = Math.max(1, Math.round(2 * dpr));
    this.step = this.bar + Math.max(1, Math.round(1 * dpr));
    this.msPerPx = spanMs > 0 ? spanMs / w : 0;
  }

  /** Record `amp` (0–1) for every bucket up to `durMs`. */
  push(durMs: number, amp: number): void {
    if (!Number.isFinite(durMs) || !Number.isFinite(amp)) return;
    const bucket = Math.min(this.levels.length - 1, Math.floor((durMs * PEAKS_PER_SEC) / 1000));
    for (let i = this.lastBucket + 1; i <= bucket; i++) this.levels[i] = amp;
    if (bucket > this.lastBucket) this.lastBucket = bucket;
  }

  /** Draw the bars that became complete since the last call; returns how many were drawn. */
  drawNew(durMs: number, rect: (x: number, y: number, w: number, h: number) => void): number {
    if (this.msPerPx <= 0 || !Number.isFinite(durMs)) return 0;
    let n = 0;
    const mid = this.h / 2;
    while (this.drawnX + this.bar <= this.w && (this.drawnX + this.bar) * this.msPerPx <= durMs) {
      const a = Math.floor((this.drawnX * this.msPerPx * PEAKS_PER_SEC) / 1000);
      const b = Math.max(
        a + 1,
        Math.ceil(((this.drawnX + this.bar) * this.msPerPx * PEAKS_PER_SEC) / 1000),
      );
      let p = 0;
      for (let i = a; i < b && i < this.levels.length; i++) p = Math.max(p, this.levels[i]!);
      const bh = Math.max(this.dpr, Math.sqrt(p) * (this.h - 2 * this.dpr));
      rect(this.drawnX, mid - bh / 2, this.bar, bh);
      this.drawnX += this.step;
      n++;
    }
    return n;
  }
}
