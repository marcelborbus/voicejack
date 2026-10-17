import { paths, type ChunkMeta } from '@dub/shared';
import { loadChunkAudio, type DecodedAudio } from '@/dub/chunkLoader';
import { toast } from '@/lib/toast';
import { addOrReplaceChunk, deleteChunk, editorStore, patchChunk } from './editorStore';
import type { UploadQueue } from './uploadQueue';

export interface RestoreInput {
  code: string;
  round: number;
  submissionId: string;
  /** `you.manifest` / `you.uploaded` from the snapshot. */
  manifest: readonly ChunkMeta[];
  uploaded: readonly string[];
  token: string | null;
  ctx: BaseAudioContext;
  queue: UploadQueue;
  /** Injected for tests. */
  load?: (url: string) => Promise<DecodedAudio>;
}

/** Which manifest entries can come back: only those the server actually has. */
export function restorable(manifest: readonly ChunkMeta[], uploaded: readonly string[]) {
  const have = new Set(uploaded);
  const keep = manifest.filter((c) => have.has(c.id)).sort((a, b) => a.startMs - b.startMs);
  return { keep, lost: manifest.length - keep.length };
}

/**
 * After a reload / reconnect into a fresh editor: rebuild the takes from the server's view
 * of our manifest. Chunks that never finished uploading are gone (their audio died with the
 * page) and are dropped from the manifest; the rest are re-downloaded and decoded.
 */
export async function restoreFromServer(input: RestoreInput): Promise<void> {
  const { code, round, submissionId, queue } = input;
  const { keep, lost } = restorable(input.manifest, input.uploaded);
  if (keep.length === 0 && lost === 0) return;

  editorStore.set((s) => {
    let n = { ...s, restoring: keep.length > 0 };
    for (const meta of keep) n = addOrReplaceChunk(n, { meta, buffer: null, peaks: null, status: 'restoring' });
    return { ...n, selectedId: null };
  });
  for (const meta of keep) queue.adopt(meta);
  if (lost > 0) queue.syncManifest(true);

  const load =
    input.load ??
    ((url: string) => loadChunkAudio(input.ctx, url, { token: input.token }));
  let failed = 0;
  await Promise.all(
    keep.map(async (meta) => {
      try {
        const audio = await load(paths.chunk(code, round, submissionId, meta.id));
        editorStore.set((s) =>
          patchChunk(s, meta.id, { buffer: audio.buffer, peaks: audio.peaks, status: 'uploaded' }),
        );
      } catch {
        failed++;
        editorStore.set((s) => deleteChunk(s, meta.id));
        queue.remove(meta.id);
      }
    }),
  );
  editorStore.set((s) => ({ ...s, restoring: false }));

  if (lost > 0 || failed > 0) {
    const n = lost + failed;
    toast(n === 1 ? 'One take could not be restored' : `${n} takes could not be restored`, {
      variant: 'warning',
      description: 'They had not finished uploading. Everything else is back.',
    });
  } else if (keep.length > 0) {
    toast(`Restored ${keep.length} take${keep.length === 1 ? '' : 's'}`, { variant: 'success', durationMs: 2500 });
  }
}
