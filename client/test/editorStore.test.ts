import type { ChunkMeta } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import {
  addOrReplaceChunk,
  deleteChunk,
  formatPrecise,
  initialEditorData,
  FX_CHOICES,
  neighbourChunk,
  nextFx,
  patchChunk,
  randomFx,
  resetFor,
  setChunkFx,
  selectChunk,
  totalBytes,
  type EditorChunk,
  type EditorData,
} from '../src/editor/editorStore';

const meta = (id: string, startMs: number, durationMs = 1000, bytes = 100): ChunkMeta => ({
  id,
  startMs,
  durationMs,
  offsetMs: 50,
  mime: 'audio/webm;codecs=opus',
  bytes,
});
const chunk = (id: string, startMs: number, status: EditorChunk['status'] = 'uploaded') => ({
  meta: meta(id, startMs),
  buffer: null,
  peaks: null,
  status,
});

function withChunks(...ids: [string, number][]): EditorData {
  let s: EditorData = { ...initialEditorData, key: 'K', durationMs: 10_000 };
  for (const [id, start] of ids) s = addOrReplaceChunk(s, chunk(id, start));
  return s;
}

describe('editorStore reducers', () => {
  it('adds chunks with increasing take numbers and selects the new one', () => {
    const s = withChunks(['a', 0], ['b', 500]);
    expect(s.chunks.map((c) => [c.meta.id, c.take])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(s.selectedId).toBe('b');
    expect(s.nextTake).toBe(3);
  });

  it('selects existing chunks only, and deselects with null', () => {
    const s = withChunks(['a', 0], ['b', 500]);
    expect(selectChunk(s, 'a').selectedId).toBe('a');
    expect(selectChunk(s, 'nope')).toBe(s);
    expect(selectChunk(s, null).selectedId).toBeNull();
    const same = selectChunk(s, 'b');
    expect(same).toBe(s); // no-op keeps identity
  });

  it('deletes a chunk and clears the selection if it was selected', () => {
    const s = withChunks(['a', 0], ['b', 500]);
    const d = deleteChunk(s, 'b');
    expect(d.chunks.map((c) => c.meta.id)).toEqual(['a']);
    expect(d.selectedId).toBeNull();
    const d2 = deleteChunk(selectChunk(s, 'a'), 'b');
    expect(d2.selectedId).toBe('a');
    expect(deleteChunk(s, 'zzz')).toBe(s);
  });

  it('replaces a chunk in place, keeping its take number', () => {
    const s = withChunks(['a', 0], ['b', 500], ['c', 900]);
    const r = addOrReplaceChunk(s, chunk('b2', 500, 'uploading'), 'b');
    expect(r.chunks.map((c) => [c.meta.id, c.take, c.status])).toEqual([
      ['a', 1, 'uploaded'],
      ['b2', 2, 'uploading'],
      ['c', 3, 'uploaded'],
    ]);
    expect(r.selectedId).toBe('b2');
    expect(r.nextTake).toBe(4);
  });

  it('re-recording a chunk that was deleted meanwhile just adds', () => {
    const s = deleteChunk(withChunks(['a', 0], ['b', 500]), 'b');
    const r = addOrReplaceChunk(s, chunk('b2', 500), 'b');
    expect(r.chunks.map((c) => [c.meta.id, c.take])).toEqual([
      ['a', 1],
      ['b2', 3],
    ]);
  });

  it('patches status and audio of one chunk', () => {
    const s = withChunks(['a', 0], ['b', 500]);
    const p = patchChunk(s, 'a', { status: 'failed' });
    expect(p.chunks[0]!.status).toBe('failed');
    expect(p.chunks[1]).toBe(s.chunks[1]);
    expect(patchChunk(s, 'x', { status: 'failed' })).toBe(s);
  });

  it('cycles selection through takes by start time', () => {
    const s = withChunks(['late', 5000], ['early', 100], ['mid', 2000]);
    const none = selectChunk(s, null);
    expect(neighbourChunk(none, 1)).toBe('early');
    expect(neighbourChunk(none, -1)).toBe('late');
    expect(neighbourChunk(selectChunk(s, 'early'), 1)).toBe('mid');
    expect(neighbourChunk(selectChunk(s, 'late'), 1)).toBe('early');
  });

  it('reset keeps listening preferences but drops chunks', () => {
    const s = { ...withChunks(['a', 0]), speed: 2 as const, refVolume: 0.4, refAudio: false };
    const r = resetFor(s, 'K2', 30_000);
    expect(r.chunks).toEqual([]);
    expect(r.key).toBe('K2');
    expect(r.durationMs).toBe(30_000);
    expect([r.speed, r.refVolume, r.refAudio]).toEqual([2, 0.4, false]);
    expect(r.nextTake).toBe(1);
  });

  it('sums bytes and formats precise times', () => {
    expect(totalBytes(withChunks(['a', 0], ['b', 1]))).toBe(200);
    expect(formatPrecise(0)).toBe('0:00.00');
    expect(formatPrecise(4210)).toBe('0:04.21');
    expect(formatPrecise(75_005)).toBe('1:15.01');
  });
});

describe('effects (#48)', () => {
  it('setChunkFx sets / clears meta.fx immutably and keeps unrelated takes', () => {
    const s = withChunks(['a', 0], ['b', 500]);
    const s2 = setChunkFx(s, 'a', 'ghost');
    expect(s2.chunks[0]!.meta.fx).toBe('ghost');
    expect(s.chunks[0]!.meta.fx).toBeUndefined();
    expect(s2.chunks[1]).toBe(s.chunks[1]);
    expect(setChunkFx(s2, 'a', 'ghost')).toBe(s2);
    expect(setChunkFx(s2, 'a', 'none').chunks[0]!.meta).not.toHaveProperty('fx');
    expect(setChunkFx(s, 'zzz', 'robot')).toBe(s);
  });
  it('nextFx cycles through none + 16 effects; randomFx never repeats or picks none', () => {
    expect(FX_CHOICES).toHaveLength(17);
    let fx = FX_CHOICES[0]!;
    const seen = new Set<string>();
    for (let i = 0; i < 17; i++) {
      seen.add(fx);
      fx = nextFx(fx);
    }
    expect(seen.size).toBe(17);
    expect(fx).toBe('none');
    expect(nextFx('none', -1)).toBe(FX_CHOICES[16]);
    for (let i = 0; i < 50; i++) {
      const r = randomFx('robot');
      expect(r).not.toBe('robot');
      expect(r).not.toBe('none');
    }
  });
  it('the sticky effect survives a new round', () => {
    const s = { ...withChunks(['a', 0]), fx: 'helium' as const, fxOpen: true };
    const r = resetFor(s, 'K2', 5000);
    expect(r.fx).toBe('helium');
    expect(r.fxOpen).toBe(false);
    expect(r.chunks).toEqual([]);
  });
});
