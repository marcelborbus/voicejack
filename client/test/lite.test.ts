import { afterEach, describe, expect, it } from 'vitest';
import {
  clipSource,
  DropWatch,
  enableLite,
  isLite,
  isLowEndDevice,
  resetLite,
} from '../src/lib/lite';

describe('lite mode (#53)', () => {
  afterEach(() => resetLite());

  it('DropWatch trips on >10 % dropped frames over 3 s, not on a short burst', () => {
    const w = new DropWatch();
    // 30 fps, 5 % dropped for 3 s: fine
    for (let t = 0; t <= 3000; t += 500)
      expect(w.push({ t, total: t * 0.03, dropped: t * 0.0015 })).toBe(false);
    const w2 = new DropWatch();
    // 20 % dropped, but only for 1 s so far
    expect(w2.push({ t: 0, total: 0, dropped: 0 })).toBe(false);
    expect(w2.push({ t: 1000, total: 30, dropped: 6 })).toBe(false);
    expect(w2.push({ t: 2000, total: 60, dropped: 12 })).toBe(false);
    expect(w2.push({ t: 3000, total: 90, dropped: 18 })).toBe(true);
  });

  it('picks the 480p clip in lite mode or on a weak device', () => {
    const clip = { url: '/clips/a.mp4', lowUrl: '/clips/classics/a-480.mp4' };
    expect(isLowEndDevice({ hardwareConcurrency: 4 })).toBe(true);
    expect(isLowEndDevice({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(true);
    expect(isLowEndDevice({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
    const weak = isLowEndDevice();
    if (!weak) expect(clipSource(clip)).toBe('/clips/a.mp4');
    enableLite('test');
    expect(isLite()).toBe(true);
    expect(clipSource(clip)).toBe('/clips/classics/a-480.mp4');
    expect(clipSource({ url: '/clips/b.mp4' })).toBe('/clips/b.mp4'); // no rendition yet
  });
});
