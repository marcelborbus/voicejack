import { planSchedule } from '@dub/shared';
import type { DubChunk } from './DubPlayer';
import type { AudioBufferLike } from './types';

/**
 * #53: one pre-mixed buffer per dub. All chunks of a submission (effects already rendered) are
 * mixed into a single AudioBuffer on the clip timeline (buffer time 0 = clip 0) with an
 * OfflineAudioContext while the item is LOADING. Playback is then one source node instead of N,
 * and a resync restarts just that node.
 */

/** Where each chunk lands in the mix: the schedule from clip time 0 (same as DubPlayer). */
export interface MixPart {
  chunk: DubChunk;
  /** Seconds into the mix. */
  at: number;
  /** Seconds into the chunk's buffer. */
  offset: number;
  duration: number;
}

export function planMix(chunks: readonly DubChunk[]): { parts: MixPart[]; lengthSec: number } {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const parts: MixPart[] = [];
  let lengthSec = 0;
  for (const p of planSchedule(chunks, 0, 1)) {
    const chunk = byId.get(p.chunkId);
    if (!chunk) continue;
    const duration = Math.max(
      0,
      Math.min(p.durationSec, chunk.buffer.duration - p.bufferOffsetSec),
    );
    if (duration <= 0) continue;
    parts.push({ chunk, at: p.whenDelaySec, offset: p.bufferOffsetSec, duration });
    lengthSec = Math.max(lengthSec, p.whenDelaySec + duration);
  }
  return { parts, lengthSec };
}

/** The slice of OfflineAudioContext the mixer uses (tests pass a fake). */
export interface OfflineCtxLike {
  readonly destination: unknown;
  createBufferSource(): {
    buffer: unknown;
    connect(d: unknown): unknown;
    start(when?: number, offset?: number, duration?: number): void;
  };
  startRendering(): Promise<AudioBufferLike>;
}
export type OfflineCtxFactory = (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineCtxLike;

const defaultFactory: OfflineCtxFactory = (channels, length, sampleRate) =>
  new OfflineAudioContext(channels, length, sampleRate) as unknown as OfflineCtxLike;

/** The id of a pre-mixed chunk (one per dub). */
export const MIX_ID = 'mix';

/**
 * Mixes `chunks` into one DubChunk starting at clip time 0. `[]` for an empty dub; a single
 * chunk that already starts at 0 with no offset is returned as is.
 */
export async function premixDub(
  chunks: readonly DubChunk[],
  opts: { sampleRate: number; factory?: OfflineCtxFactory },
): Promise<DubChunk[]> {
  const { parts, lengthSec } = planMix(chunks);
  if (parts.length === 0) return [];
  const sr = opts.sampleRate;
  const length = Math.max(1, Math.ceil(lengthSec * sr));
  const channels = Math.min(2, Math.max(1, ...parts.map((p) => p.chunk.buffer.numberOfChannels)));
  const ctx = (opts.factory ?? defaultFactory)(channels, length, sr);
  for (const p of parts) {
    const src = ctx.createBufferSource();
    src.buffer = p.chunk.buffer;
    src.connect(ctx.destination);
    src.start(p.at, p.offset, p.duration);
  }
  const buffer = await ctx.startRendering();
  return [{ id: MIX_ID, startMs: 0, offsetMs: 0, durationMs: lengthSec * 1000, buffer }];
}
