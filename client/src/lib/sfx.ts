/**
 * UI sounds, synthesised with WebAudio (no audio files). docs/design-v1.1.md §6.
 * - Off-switch in the header, stored in localStorage `vj.sfx` (default on, quiet).
 * - Hard-suppressed while dubbing (they would leak into recordings).
 * - Never creates or resumes the AudioContext itself: plays only once a gesture unlocked it.
 */
import { useSyncExternalStore } from 'react';
import { audioState, getAudioContext } from '@/audio/context';

const KEY = 'vj.sfx';
const VOLUME = 0.22;

let enabled = readEnabled();
let suppressed = false;
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function sfxEnabled(): boolean {
  return enabled;
}

export function setSfxEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // private mode: in-memory only
  }
  for (const l of [...listeners]) l();
  if (on) play('pop');
}

/** True while recording could pick sounds up (DUBBING). */
export function setSfxSuppressed(v: boolean) {
  suppressed = v;
}

export function useSfxEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => enabled,
    () => enabled,
  );
}

export type Sfx = 'pop' | 'ding' | 'tick' | 'whoosh' | 'tada' | 'stamp';

function tone(
  ctx: AudioContext,
  out: AudioNode,
  {
    type = 'sine',
    from,
    to = from,
    at = 0,
    dur,
    gain = 1,
  }: { type?: OscillatorType; from: number; to?: number; at?: number; dur: number; gain?: number },
) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(ctx: AudioContext, out: AudioNode, dur: number, fromHz: number, toHz: number) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  const t0 = ctx.currentTime;
  f.frequency.setValueAtTime(fromHz, t0);
  f.frequency.exponentialRampToValueAtTime(toHz, t0 + dur);
  const g = ctx.createGain();
  g.gain.value = 0.7;
  src.connect(f).connect(g).connect(out);
  src.start();
}

/** Plays a UI sound if allowed. `value` (0–10) pitches the vote tick. */
export function play(name: Sfx, value = 5) {
  if (!enabled || suppressed || audioState() !== 'running') return;
  try {
    const ctx = getAudioContext();
    const out = ctx.createGain();
    out.gain.value = VOLUME;
    out.connect(ctx.destination);
    switch (name) {
      case 'pop':
        tone(ctx, out, { from: 520, to: 980, dur: 0.11 });
        break;
      case 'ding':
        tone(ctx, out, { type: 'triangle', from: 880, dur: 0.22, gain: 0.8 });
        tone(ctx, out, { type: 'triangle', from: 1318, at: 0.07, dur: 0.3, gain: 0.7 });
        break;
      case 'tick':
        tone(ctx, out, { type: 'square', from: 320 + value * 70, dur: 0.05, gain: 0.25 });
        break;
      case 'stamp':
        tone(ctx, out, { type: 'triangle', from: 180, to: 70, dur: 0.14, gain: 1 });
        noise(ctx, out, 0.08, 2500, 900);
        break;
      case 'whoosh':
        noise(ctx, out, 0.32, 400, 3200);
        break;
      case 'tada':
        [523, 659, 784, 1047].forEach((f, i) =>
          tone(ctx, out, {
            type: 'triangle',
            from: f,
            at: i * 0.085,
            dur: i === 3 ? 0.55 : 0.16,
            gain: 0.7,
          }),
        );
        break;
    }
    setTimeout(() => out.disconnect(), 1500);
  } catch {
    // never let a UI sound break the app
  }
}
