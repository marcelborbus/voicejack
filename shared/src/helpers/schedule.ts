export interface SchedulableChunk {
  id: string;
  startMs: number;
  offsetMs: number;
  durationMs: number;
}

export interface ScheduledSource {
  chunkId: string;
  /** Seconds of wall/audio-clock time from now until `source.start()` should fire. */
  whenDelaySec: number;
  /** Offset into the decoded buffer, in buffer seconds (includes `offsetMs`). */
  bufferOffsetSec: number;
  /** Buffer seconds left to play (pass as `start(when, offset, duration)`). */
  durationSec: number;
}

/**
 * What to start for media position `mediaTimeMs` at playback `rate`. Chunks that already
 * ended are skipped; a chunk in progress starts immediately part-way in; future chunks are
 * delayed by their media distance divided by `rate`. Buffer offsets are in buffer time
 * (the source's `playbackRate = rate` handles speed). Sorted by delay, then id.
 */
export function planSchedule(
  chunks: readonly SchedulableChunk[],
  mediaTimeMs: number,
  rate: number,
): ScheduledSource[] {
  if (!(rate > 0)) return [];
  const out: ScheduledSource[] = [];
  for (const c of chunks) {
    const endMs = c.startMs + c.durationMs;
    if (endMs <= mediaTimeMs) continue;
    if (c.startMs >= mediaTimeMs) {
      out.push({
        chunkId: c.id,
        whenDelaySec: (c.startMs - mediaTimeMs) / 1000 / rate,
        bufferOffsetSec: c.offsetMs / 1000,
        durationSec: c.durationMs / 1000,
      });
    } else {
      const into = mediaTimeMs - c.startMs;
      out.push({
        chunkId: c.id,
        whenDelaySec: 0,
        bufferOffsetSec: (c.offsetMs + into) / 1000,
        durationSec: (c.durationMs - into) / 1000,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.whenDelaySec - b.whenDelaySec ||
      (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
  );
}
