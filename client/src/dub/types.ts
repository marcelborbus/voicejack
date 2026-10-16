// Minimal structural surfaces of the Web APIs the dub engine touches. The real browser objects
// satisfy them; unit tests pass small fakes.

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(dest: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  playbackRate: { value: number };
  onended: ((ev: Event) => void) | null;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: AudioContextState | string;
  readonly destination: AudioNodeLike;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  createBufferSource(): BufferSourceLike;
  createGain(): GainNodeLike;
  addEventListener?(type: 'statechange', fn: () => void): void;
  removeEventListener?(type: 'statechange', fn: () => void): void;
}

export interface VideoLike {
  currentTime: number;
  playbackRate: number;
  muted: boolean;
  volume: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  readonly duration: number;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const browserTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};
