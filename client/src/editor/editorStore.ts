import { FX_IDS, type ChunkMeta, type FxId } from '@dub/shared';
import { create } from 'zustand';
import type { DubPlayer } from '@/dub/DubPlayer';

/**
 * Editor state (§2.3 Editor). Pure reducers (exported, unit-tested) plus a zustand store and
 * a small imperative "transport" around the one `<video>` element, which is the master
 * clock: the cursor *is* `video.currentTime`.
 */

export type ChunkStatus =
  /** Recorded here, upload queued or in flight. */
  | 'uploading'
  /** On the server. */
  | 'uploaded'
  /** Upload gave up after retries (retry button). */
  | 'failed'
  /** Known from `you.manifest`, being downloaded again after a reload. */
  | 'restoring';

export interface EditorChunk {
  meta: ChunkMeta;
  /** Decoded audio; null while restoring. */
  buffer: AudioBuffer | null;
  /** |peak| per 10 ms of *buffer* time (see `PEAKS_PER_SEC`), for the waveform. */
  peaks: Float32Array | null;
  status: ChunkStatus;
  /** Take number shown in the UI (1-based, stable for the round). */
  take: number;
}

export interface RecordingInfo {
  /** `arming`: waiting for the recorder + first video frame; `finishing`: stopping/decoding. */
  phase: 'arming' | 'recording' | 'finishing';
  startMs: number;
  /** Re-record: the chunk this take replaces when it finishes. */
  replacingId: string | null;
}

export const SPEEDS = [0.5, 1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_REF_VOLUME = 0.15;
export const ZOOMS = [1, 2, 4, 8] as const;

export interface EditorData {
  /** `code:round:submissionId` the chunks belong to; a new key resets the editor. */
  key: string | null;
  durationMs: number;
  chunks: EditorChunk[];
  selectedId: string | null;
  nextTake: number;
  /** Cursor (ms) as of the last seek/pause/timeupdate. The playhead itself is animated. */
  cursorMs: number;
  playing: boolean;
  speed: Speed;
  refAudio: boolean;
  refVolume: number;
  zoom: number;
  recording: RecordingInfo | null;
  /** Restore from the server manifest is running. */
  restoring: boolean;
  /** #48: the effect new takes get (sticky: the last one picked). */
  fx: FxId;
  /** #48: effect picker open. */
  fxOpen: boolean;
}

export const initialEditorData: EditorData = {
  key: null,
  durationMs: 0,
  chunks: [],
  selectedId: null,
  nextTake: 1,
  cursorMs: 0,
  playing: false,
  speed: 1,
  refAudio: true,
  refVolume: DEFAULT_REF_VOLUME,
  zoom: 1,
  recording: null,
  restoring: false,
  fx: 'none',
  fxOpen: false,
};

// ---------- pure reducers ----------

export function selectChunk(s: EditorData, id: string | null): EditorData {
  if (id !== null && !s.chunks.some((c) => c.meta.id === id)) return s;
  return s.selectedId === id ? s : { ...s, selectedId: id };
}

export function deleteChunk(s: EditorData, id: string): EditorData {
  if (!s.chunks.some((c) => c.meta.id === id)) return s;
  return {
    ...s,
    chunks: s.chunks.filter((c) => c.meta.id !== id),
    selectedId: s.selectedId === id ? null : s.selectedId,
  };
}

/**
 * Adds `chunk`, or (re-record) puts it in place of `replaceId`, keeping that chunk's take
 * number. The new chunk becomes the selection. A `replaceId` that no longer exists (deleted
 * meanwhile) just adds.
 */
export function addOrReplaceChunk(
  s: EditorData,
  chunk: Omit<EditorChunk, 'take'>,
  replaceId: string | null = null,
): EditorData {
  const idx = replaceId === null ? -1 : s.chunks.findIndex((c) => c.meta.id === replaceId);
  if (idx === -1) {
    const added: EditorChunk = { ...chunk, take: s.nextTake };
    return {
      ...s,
      chunks: [...s.chunks, added],
      nextTake: s.nextTake + 1,
      selectedId: chunk.meta.id,
    };
  }
  const chunks = s.chunks.slice();
  chunks[idx] = { ...chunk, take: s.chunks[idx]!.take };
  return { ...s, chunks, selectedId: chunk.meta.id };
}

export function patchChunk(
  s: EditorData,
  id: string,
  patch: Partial<Omit<EditorChunk, 'meta' | 'take'>>,
): EditorData {
  let hit = false;
  const chunks = s.chunks.map((c) => {
    if (c.meta.id !== id) return c;
    hit = true;
    return { ...c, ...patch };
  });
  return hit ? { ...s, chunks } : s;
}

/** Fresh editor for a round (keeps the user's listening preferences). */
export function resetFor(s: EditorData, key: string, durationMs: number): EditorData {
  return {
    ...initialEditorData,
    key,
    durationMs,
    speed: s.speed,
    refAudio: s.refAudio,
    refVolume: s.refVolume,
    zoom: s.zoom,
    fx: s.fx,
  };
}

/** Every effect choice in picker order ('none' first). */
export const FX_CHOICES: readonly FxId[] = ['none', ...FX_IDS];

/** The effect after (or before) `fx` in picker order, wrapping. */
export function nextFx(fx: FxId, dir: 1 | -1 = 1): FxId {
  const i = FX_CHOICES.indexOf(fx);
  return FX_CHOICES[(i + dir + FX_CHOICES.length) % FX_CHOICES.length]!;
}

/** A random effect other than `not` (and never 'none'). */
export function randomFx(not: FxId, rng: () => number = Math.random): FxId {
  const pool = FX_IDS.filter((f) => f !== not);
  return pool[Math.floor(rng() * pool.length)]!;
}

/** Sets a take's effect (`meta.fx`; 'none' removes the field, so dry takes look like before). */
export function setChunkFx(s: EditorData, id: string, fx: FxId): EditorData {
  let hit = false;
  const chunks = s.chunks.map((c) => {
    if (c.meta.id !== id || (c.meta.fx ?? 'none') === fx) return c;
    hit = true;
    const { fx: _old, ...rest } = c.meta;
    return { ...c, meta: fx === 'none' ? rest : { ...rest, fx } };
  });
  return hit ? { ...s, chunks } : s;
}

/** Selection to move to with ←/→-style cycling through takes sorted by start. */
export function neighbourChunk(s: EditorData, dir: 1 | -1): string | null {
  const sorted = s.chunks
    .slice()
    .sort((a, b) => a.meta.startMs - b.meta.startMs || a.take - b.take);
  if (sorted.length === 0) return null;
  const i = sorted.findIndex((c) => c.meta.id === s.selectedId);
  if (i === -1) return sorted[dir === 1 ? 0 : sorted.length - 1]!.meta.id;
  return sorted[(i + dir + sorted.length) % sorted.length]!.meta.id;
}

export function totalBytes(s: EditorData): number {
  return s.chunks.reduce((n, c) => n + c.meta.bytes, 0);
}

// ---------- store ----------

export const useEditor = create<EditorData>(() => ({ ...initialEditorData }));

export const editorStore = {
  get: () => useEditor.getState(),
  set: (fn: (s: EditorData) => EditorData) => useEditor.setState(fn(useEditor.getState()), true),
};

// ---------- media (non-reactive) ----------

interface Media {
  video: HTMLVideoElement | null;
  player: DubPlayer | null;
  /** Target of a seek requested while another one was still running (coalesced scrubbing). */
  pendingSeekMs: number | null;
  /** Playhead override while the user drags (so it follows the pointer, not the decoder). */
  scrubMs: number | null;
}

export const media: Media = { video: null, player: null, pendingSeekMs: null, scrubMs: null };

const clampMs = (ms: number) => Math.max(0, Math.min(editorStore.get().durationMs || Infinity, ms));

/**
 * Current media position for drawing: the audio clock while the dub is running (smooth,
 * sample-accurate), else the video's own time.
 */
export function mediaNowMs(): number {
  if (media.scrubMs !== null) return media.scrubMs;
  if (media.pendingSeekMs !== null) return media.pendingSeekMs;
  const v = media.video;
  if (!v) return editorStore.get().cursorMs;
  const a = media.player?.audioMediaTimeMs();
  const vt = v.currentTime * 1000;
  // Trust the audio clock only while it agrees with the video (watchdog keeps it within 60 ms).
  if (a != null && !v.paused && Math.abs(a - vt) < 120) return clampMs(a);
  return clampMs(vt);
}

export const transport = {
  isRecording: () => editorStore.get().recording !== null,

  play(): void {
    const v = media.video;
    if (!v || !v.paused) return;
    if (v.ended || v.currentTime * 1000 >= editorStore.get().durationMs - 30) v.currentTime = 0;
    void v.play().catch(() => {
      /* autoplay blocked: the sound-unlock overlay handles it */
    });
  },

  pause(): void {
    if (transport.isRecording()) return;
    media.video?.pause();
  },

  toggle(): void {
    const v = media.video;
    if (!v) return;
    if (v.paused) transport.play();
    else transport.pause();
  },

  /** Seek to `ms` (clamped). Coalesces while a seek is running so scrubbing stays fluid. */
  seek(ms: number): void {
    const v = media.video;
    if (!v || transport.isRecording()) return;
    const target = clampMs(ms);
    editorStore.set((s) => (s.cursorMs === target ? s : { ...s, cursorMs: target }));
    if (v.seeking) {
      media.pendingSeekMs = target;
      return;
    }
    media.pendingSeekMs = null;
    v.currentTime = target / 1000;
  },

  nudge(deltaMs: number): void {
    transport.seek(mediaNowMs() + deltaMs);
  },

  setSpeed(speed: Speed): void {
    if (transport.isRecording()) return;
    editorStore.set((s) => ({ ...s, speed }));
    if (media.video) media.video.playbackRate = speed;
  },

  setRefAudio(on: boolean): void {
    editorStore.set((s) => ({ ...s, refAudio: on }));
    if (media.video) media.video.muted = !on;
  },

  setRefVolume(v: number): void {
    const vol = Math.max(0, Math.min(1, v));
    editorStore.set((s) => ({ ...s, refVolume: vol, refAudio: vol > 0 ? true : s.refAudio }));
    if (media.video) {
      media.video.volume = vol;
      if (vol > 0) media.video.muted = false;
    }
  },

  select(id: string | null): void {
    editorStore.set((s) => selectChunk(s, id));
  },

  selectNeighbour(dir: 1 | -1): void {
    editorStore.set((s) => selectChunk(s, neighbourChunk(s, dir)));
  },

  setFxOpen(open: boolean): void {
    editorStore.set((s) => (s.fxOpen === open ? s : { ...s, fxOpen: open }));
  },

  /** Play the selected (or given) chunk from its start. */
  playFrom(ms: number): void {
    transport.seek(ms);
    transport.play();
  },
};

/** Called from `seeked`: applies the latest coalesced scrub target. */
export function flushPendingSeek(): void {
  const v = media.video;
  if (!v || media.pendingSeekMs === null) return;
  const ms = media.pendingSeekMs;
  media.pendingSeekMs = null;
  if (Math.abs(v.currentTime * 1000 - ms) > 1) v.currentTime = ms / 1000;
}

/** `m:ss.cc` for the transport clock and chunk tooltips. */
export function formatPrecise(ms: number): string {
  const t = Math.max(0, Math.round(ms / 10));
  const cs = t % 100;
  const s = Math.floor(t / 100) % 60;
  const m = Math.floor(t / 6000);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** `2.4 s` */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
