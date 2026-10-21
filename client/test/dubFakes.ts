// Fakes for the dub engines (DubPlayer, SyncedDubPlayer): a scripted AudioContext, video and timers.
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceLike,
  GainNodeLike,
  Timers,
  VideoLike,
} from '../src/dub/types';

// ---------- fakes ----------

export class FakeParam implements AudioParamLike {
  value = 1;
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}

export class FakeNode implements AudioNodeLike {
  connected: AudioNodeLike[] = [];
  connect(d: AudioNodeLike) {
    this.connected.push(d);
  }
  disconnect() {
    this.connected = [];
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  gain = new FakeParam();
}

interface StartCall {
  when: number;
  offset: number;
  duration: number;
}

export class FakeSource extends FakeNode implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  playbackRate = { value: 1 };
  onended: ((ev: Event) => void) | null = null;
  started: StartCall | null = null;
  stoppedAt: number | null = null;
  start(when = 0, offset = 0, duration = 0) {
    this.started = { when, offset, duration };
  }
  stop(when = 0) {
    this.stoppedAt = when;
  }
}

export class FakeCtx implements AudioContextLike {
  currentTime = 100;
  state = 'running';
  destination = new FakeNode();
  outputLatency = 0;
  baseLatency = 0;
  sources: FakeSource[] = [];
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain() {
    return new FakeGain();
  }
  /** Sources started since the last call. */
  take(): FakeSource[] {
    const s = this.sources;
    this.sources = [];
    return s;
  }
}

export class FakeVideo implements VideoLike {
  currentTime = 0;
  playbackRate = 1;
  muted = false;
  volume = 1;
  paused = true;
  seeking = false;
  ended = false;
  duration = 30;
  readyState = 4;
  private l = new Map<string, Set<() => void>>();
  playCalls = 0;
  addEventListener(t: string, fn: () => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.l.get(t)?.delete(fn);
  }
  emit(t: string) {
    for (const fn of this.l.get(t) ?? []) fn();
  }
  listenerCount() {
    let n = 0;
    for (const s of this.l.values()) n += s.size;
    return n;
  }
  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  // helpers mirroring browser event order
  startPlaying() {
    this.paused = false;
    this.emit('play');
    this.emit('playing');
  }
  seek(sec: number) {
    this.seeking = true;
    this.currentTime = sec;
    this.emit('seeking');
    this.seeking = false;
    this.emit('seeked');
  }
  setRate(r: number) {
    this.playbackRate = r;
    this.emit('ratechange');
  }
  doPause() {
    this.paused = true;
    this.emit('pause');
  }
}

export class FakeTimers implements Timers {
  now = 0;
  private id = 0;
  private items = new Map<number, { at: number; fn: () => void; every?: number }>();
  setInterval(fn: () => void, ms: number) {
    this.items.set(++this.id, { at: this.now + ms, fn, every: ms });
    return this.id;
  }
  setTimeout(fn: () => void, ms: number) {
    this.items.set(++this.id, { at: this.now + ms, fn });
    return this.id;
  }
  clearInterval(id: unknown) {
    this.items.delete(id as number);
  }
  clearTimeout(id: unknown) {
    this.items.delete(id as number);
  }
  advance(ms: number, onStep?: (dt: number) => void) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of this.items) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, item] = next;
      onStep?.(item.at - this.now);
      this.now = item.at;
      if (item.every) item.at += item.every;
      else this.items.delete(id);
      item.fn();
    }
    onStep?.(end - this.now);
    this.now = end;
  }
}

export function buffer(seconds: number, sampleRate = 1000): AudioBufferLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  return {
    duration: seconds,
    length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}
