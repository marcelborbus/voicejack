import { paths, type Limits } from '@dub/shared';
import { getAudioContext, unlockAudio } from '@/audio/context';
import { acquireMic, getMicStream } from '@/audio/mic';
import { playAndWaitFirstFrame, Recorder } from '@/audio/recorder';
import { decodeWithPeaks, primeChunkCache } from '@/dub/chunkLoader';
import { toast } from '@/lib/toast';
import { addOrReplaceChunk, editorStore, media, totalBytes } from './editorStore';
import type { UploadQueue } from './uploadQueue';

/**
 * Takes (§2.3 Recording behaviour): always 1×, from the cursor (re-record: from the selected
 * chunk's start). The other takes keep playing so you can layer; the one being re-recorded
 * is muted. Stops on R/Esc, at the clip end, or at the deadline. Takes under `minChunkMs`
 * are discarded. Finished takes go straight into the upload queue.
 */

export interface RecordingContext {
  code: string;
  round: number;
  submissionId: string | null;
  limits: Limits;
  queue: UploadQueue;
}

interface Active {
  rec: Recorder | null;
  startMs: number;
  replacingId: string | null;
  stopping: boolean;
  cancelled: boolean;
  cleanup: () => void;
}

let ctxRef: RecordingContext | null = null;
let active: Active | null = null;
/** Deadline passed: no new takes. */
let locked = false;

export function configureRecording(c: RecordingContext | null): void {
  ctxRef = c;
  locked = false;
}

export function lockRecording(): void {
  locked = true;
}

export function isRecordingLocked(): boolean {
  return locked;
}

/** Why a new take can't start right now (null = it can). */
export function recordBlocker(limits: Limits, replacing = false): string | null {
  const s = editorStore.get();
  if (locked) return "Time's up";
  if (!replacing && s.chunks.length >= limits.maxChunksPerSubmission)
    return `You've hit the limit of ${limits.maxChunksPerSubmission} takes. Delete one first.`;
  if (totalBytes(s) >= limits.maxSubmissionBytes * 0.97) return 'Your dub is full. Delete a take first.';
  return null;
}

function waitEvent(el: EventTarget, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener(type, done);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, timeoutMs);
    el.addEventListener(type, done);
  });
}

/** R: start a take from the cursor, or stop the running one. */
export function toggleRecording(): void {
  if (active) void stopRecording();
  else void startRecording(null);
}

export async function startRecording(replacingId: string | null): Promise<void> {
  const c = ctxRef;
  const v = media.video;
  if (!c || !v || active) return;
  const s = editorStore.get();
  const blocker = recordBlocker(c.limits, replacingId !== null);
  if (blocker) {
    toast(blocker, { variant: 'warning' });
    return;
  }
  const replacing = replacingId ? s.chunks.find((x) => x.meta.id === replacingId) : null;
  if (replacingId && !replacing) return;
  const startMs = Math.round(replacing ? replacing.meta.startMs : v.currentTime * 1000);
  if (startMs > s.durationMs - c.limits.minChunkMs) {
    toast('The clip ends right there', { description: 'Move the cursor back a bit, then record.' });
    return;
  }

  void unlockAudio();
  const a: Active = {
    rec: null,
    startMs,
    replacingId,
    stopping: false,
    cancelled: false,
    cleanup: () => {},
  };
  active = a;
  editorStore.set((x) => ({
    ...x,
    recording: { phase: 'arming', startMs, replacingId },
    selectedId: replacingId,
  }));

  try {
    const stream = getMicStream() ?? (await acquireMic());
    if (!stream) throw new Error('No microphone. Allow mic access and try again.');
    if (a.cancelled) return;
    v.pause();
    v.playbackRate = 1;
    if (Math.abs(v.currentTime * 1000 - startMs) > 1) {
      v.currentTime = startMs / 1000;
      await waitEvent(v, 'seeked', 2000);
    }
    if (a.cancelled) return;
    const rec = new Recorder(stream);
    a.rec = rec;
    await rec.start(() => playAndWaitFirstFrame(v));
    if (a.cancelled) return;
  } catch (e) {
    if (active === a) finish(a);
    if (!a.cancelled)
      toast('Could not start recording', {
        variant: 'error',
        description: e instanceof Error ? e.message : String(e),
      });
    return;
  }

  // Auto-stop at the clip end.
  const onEnd = () => void stopRecording();
  const onTime = () => {
    if (v.currentTime * 1000 >= editorStore.get().durationMs - 40) void stopRecording();
  };
  v.addEventListener('ended', onEnd);
  v.addEventListener('timeupdate', onTime);
  a.cleanup = () => {
    v.removeEventListener('ended', onEnd);
    v.removeEventListener('timeupdate', onTime);
  };
  editorStore.set((x) => (x.recording ? { ...x, recording: { ...x.recording, phase: 'recording' } } : x));
}

function finish(a: Active): void {
  a.cleanup();
  if (active === a) active = null;
  const v = media.video;
  if (v) {
    v.pause();
    v.playbackRate = editorStore.get().speed;
  }
  editorStore.set((x) => ({ ...x, recording: null }));
}

/** Stop the running take and keep it (if long enough). */
export async function stopRecording(): Promise<void> {
  const a = active;
  const c = ctxRef;
  if (!a || a.stopping || !c) return;
  a.stopping = true;
  if (!a.rec || !a.rec.recording) {
    // Still arming: nothing recorded yet.
    a.cancelled = true;
    a.rec?.cancel();
    finish(a);
    return;
  }
  const rec = a.rec;
  const v = media.video;
  const resultP = rec.stop(); // measures the stop time now
  v?.pause();
  editorStore.set((x) => (x.recording ? { ...x, recording: { ...x.recording, phase: 'finishing' } } : x));
  try {
    const res = await resultP;
    const s = editorStore.get();
    const maxMs = s.durationMs - a.startMs;
    let durationMs = Math.min(res.durationMs, maxMs);
    if (durationMs < c.limits.minChunkMs) {
      toast('Take too short, discarded', {
        description: `Takes need at least ${(c.limits.minChunkMs / 1000).toFixed(1)} s.`,
      });
      return;
    }
    const replacedBytes = a.replacingId
      ? (s.chunks.find((x) => x.meta.id === a.replacingId)?.meta.bytes ?? 0)
      : 0;
    if (res.blob.size > c.limits.maxChunkBytes || totalBytes(s) - replacedBytes + res.blob.size > c.limits.maxSubmissionBytes) {
      toast('That take is too big to keep', { variant: 'error', description: 'Try a shorter take.' });
      return;
    }
    const audio = await decodeWithPeaks(getAudioContext(), await res.blob.arrayBuffer());
    durationMs = Math.floor(Math.min(durationMs, audio.buffer.duration * 1000 - res.offsetMs));
    if (durationMs < c.limits.minChunkMs) {
      toast('Take too short, discarded');
      return;
    }
    const meta = {
      id: crypto.randomUUID(),
      startMs: a.startMs,
      offsetMs: Math.round(res.offsetMs),
      durationMs,
      mime: res.mime,
      bytes: res.blob.size,
    };
    editorStore.set((x) =>
      addOrReplaceChunk(x, { meta, buffer: audio.buffer, peaks: audio.peaks, status: 'uploading' }, a.replacingId),
    );
    c.queue.add(meta, res.blob, a.replacingId);
    if (c.submissionId) primeChunkCache(paths.chunk(c.code, c.round, c.submissionId, meta.id), audio);
  } catch (e) {
    toast('Recording failed', {
      variant: 'error',
      description: e instanceof Error ? e.message : String(e),
    });
  } finally {
    finish(a);
  }
}

/** Discard the running take (a re-record keeps the old chunk). */
export function cancelRecording(): void {
  const a = active;
  if (!a || a.stopping) return;
  a.cancelled = true;
  a.stopping = true;
  a.rec?.cancel();
  finish(a);
}

/** Deadline: stop (and keep) whatever is being recorded, and allow no new takes. */
export async function onDeadline(): Promise<void> {
  locked = true;
  await stopRecording();
}

export function isRecordingActive(): boolean {
  return active !== null;
}
