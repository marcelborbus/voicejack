// #48 voice effects: what the rest of the app uses. A take with `meta.fx` is rendered once
// (OfflineAudioContext, cached by chunk + effect) and handed to DubPlayer as an ordinary
// chunk whose buffer is the processed audio, shifted by the effect's lead and extended by its
// tail. Editor, showcase, final replay and the Save-video render all go through here.
import { fxOf, type ChunkMeta, type FxEffectId } from '@dub/shared';
import { loadChunks, type FetchOptions } from '../chunkLoader';
import type { DubChunk } from '../DubPlayer';
import { FxCache } from './cache';
import { audioHash, encodeWav, peak, rms, synthVoice } from './dsp';
import { FX_LIST, MAX_LEAD_SEC, MAX_TAIL_SEC } from './registry';
import { renderFx, type ProcessedAudio } from './render';

export { FX_LIST, FX_REGISTRY, MAX_TAIL_SEC, type FxDef } from './registry';
export type { ProcessedAudio } from './render';

export const fxCache = new FxCache({ render: renderFx });

type Placed = Pick<ChunkMeta, 'id' | 'startMs' | 'offsetMs' | 'durationMs'>;

/**
 * DubPlayer input for a take: the dry buffer, or the processed one. The processed buffer
 * starts `leadMs` before the dry start, so the chunk starts that much earlier on the timeline
 * (clamped at 0) and keeps ringing `tailMs` after `durationMs`.
 */
export function dubChunkFor(meta: Placed, dry: AudioBuffer, p: ProcessedAudio | null): DubChunk {
  if (!p)
    return {
      id: meta.id,
      startMs: meta.startMs,
      offsetMs: meta.offsetMs,
      durationMs: meta.durationMs,
      buffer: dry,
    };
  const lead = Math.min(p.leadMs, meta.startMs);
  return {
    id: meta.id,
    startMs: meta.startMs - lead,
    offsetMs: p.leadMs - lead,
    durationMs: meta.durationMs + lead,
    tailMs: p.tailMs,
    buffer: p.buffer,
  };
}

/** Processed audio for `meta` (null: dry, or the render failed, then the take plays dry). */
export async function processedFor(
  meta: ChunkMeta,
  dry: AudioBuffer,
): Promise<ProcessedAudio | null> {
  const p = fxCache.get(meta, dry);
  if (!p) return null;
  try {
    return await p;
  } catch (e) {
    console.warn('[fx] render failed, playing dry', meta.fx, e);
    return null;
  }
}

/** Download + decode + effect-render a submission (showcase, final replay, Save video). */
export async function loadDub(
  ctx: BaseAudioContext,
  refs: readonly (ChunkMeta & { url: string })[],
  opts: FetchOptions & { quiet?: boolean } = {},
): Promise<DubChunk[]> {
  const loaded = await loadChunks(ctx, refs, opts);
  return Promise.all(
    loaded.map(async (c) => dubChunkFor(c.meta, c.buffer, await processedFor(c.meta, c.buffer))),
  );
}

// ---------- debug / test hook (`window.__vjFx`, also in production builds: e2e runs one) ----------

export interface FxStat {
  chunkId: string;
  fx: FxEffectId;
  rms: number;
  dryRms: number;
  hash: string;
  dryHash: string;
  peak: number;
  renderMs: number;
  worklet: boolean;
}

function chans(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
}

export function fxStats(): FxStat[] {
  return fxCache.list().map(({ chunkId, result, dry }) => ({
    chunkId,
    fx: result.fx,
    rms: rms(result.buffer.getChannelData(0)),
    dryRms: rms(dry.getChannelData(0)),
    hash: audioHash(chans(result.buffer)),
    dryHash: audioHash(chans(dry)),
    peak: peak(chans(result.buffer)),
    renderMs: Math.round(result.renderMs),
    worklet: result.worklet,
  }));
}

function synthBuffer(seconds: number, sampleRate = 48_000): AudioBuffer {
  const b = new AudioBuffer({
    length: Math.round(seconds * sampleRate),
    numberOfChannels: 1,
    sampleRate,
  });
  b.copyToChannel(synthVoice(sampleRate, seconds) as Float32Array<ArrayBuffer>, 0);
  return b;
}

/** Renders every effect on a synthetic `seconds`-long voice; numbers for the e2e/perf check. */
export async function fxSelfTest(seconds = 5) {
  const dry = synthBuffer(seconds);
  const out = [];
  for (const def of FX_LIST) {
    const r = await renderFx(
      { buffer: dry, offsetMs: 0, durationMs: seconds * 1000, seed: 'selftest' },
      def.id,
    );
    const cs = chans(r.buffer);
    let finite = true;
    for (const c of cs)
      for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i]!)) finite = false;
    out.push({
      fx: def.id,
      renderMs: Math.round(r.renderMs),
      worklet: r.worklet,
      finite,
      peak: peak(cs),
      rms: rms(cs[0]!),
      seconds: r.buffer.duration,
      maxSeconds: seconds + MAX_LEAD_SEC + MAX_TAIL_SEC,
      leadMs: r.leadMs,
      tailMs: r.tailMs,
      hash: audioHash(cs),
    });
  }
  return {
    dryHash: audioHash([dry.getChannelData(0)]),
    dryRms: rms(dry.getChannelData(0)),
    results: out,
  };
}

/** One effect on the synthetic voice as a base64 WAV (spectrogram dumps). `'none'` = dry. */
export async function fxWav(fx: FxEffectId | 'none', seconds = 5): Promise<string> {
  const dry = synthBuffer(seconds);
  const b =
    fx === 'none'
      ? dry
      : (
          await renderFx(
            { buffer: dry, offsetMs: 0, durationMs: seconds * 1000, seed: 'selftest' },
            fx,
          )
        ).buffer;
  const bytes = encodeWav(chans(b), b.sampleRate);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export { fxOf };

if (typeof window !== 'undefined')
  (window as unknown as { __vjFx?: unknown }).__vjFx = {
    stats: fxStats,
    selfTest: fxSelfTest,
    wav: fxWav,
  };
