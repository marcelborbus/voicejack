import { describe, expect, it } from 'vitest';
import { sanePresentationTime } from '../src/audio/recorder';
import { RecordingBars } from '../src/editor/recordingBars';

// #49: the live waveform of the take being recorded is drawn incrementally, with every loop
// bounded by the canvas width / take length, whatever the clocks report.
describe('RecordingBars', () => {
  it('draws each bar once, only when its time span is complete', () => {
    const bars = new RecordingBars(10_000, 300, 40); // 10 s over 300 px, 2 px bars + 1 px gaps
    const rects: number[] = [];
    const draw = (dur: number) => bars.drawNew(dur, (x) => rects.push(x));
    bars.push(0, 0.5);
    expect(draw(0)).toBe(0);
    bars.push(1000, 0.5);
    const n1 = draw(1000);
    expect(n1).toBeGreaterThan(0);
    expect(draw(1000)).toBe(0); // nothing new
    bars.push(2000, 1);
    draw(2000);
    expect(new Set(rects).size).toBe(rects.length); // never redrawn
    expect(Math.max(...rects)).toBeLessThan(300);
  });

  it('stays bounded for absurd or broken clock values', () => {
    const bars = new RecordingBars(5000, 200, 40);
    let n = 0;
    bars.push(Number.MAX_SAFE_INTEGER, 1);
    bars.push(NaN, 1);
    bars.push(Infinity, 1);
    n += bars.drawNew(Number.MAX_SAFE_INTEGER, () => {});
    n += bars.drawNew(Infinity, () => {});
    n += bars.drawNew(NaN, () => {});
    expect(n).toBeLessThanOrEqual(Math.ceil(200 / 3));
  });

  it('draws nothing for an empty span', () => {
    const bars = new RecordingBars(0, 100, 40);
    bars.push(1000, 1);
    expect(bars.drawNew(1000, () => {})).toBe(0);
  });
});

describe('sanePresentationTime', () => {
  it('keeps a plausible first-frame time and falls back to now otherwise', () => {
    expect(sanePresentationTime(990, 1000)).toBe(990);
    expect(sanePresentationTime(NaN, 1000)).toBe(1000);
    expect(sanePresentationTime(1_000_000, 1000)).toBe(1000); // another timebase
    expect(sanePresentationTime(-5000, 1000)).toBe(1000);
  });
});
