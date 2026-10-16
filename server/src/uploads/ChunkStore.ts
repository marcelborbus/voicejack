import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  type AudioMime,
  type ChunkId,
  type Limits,
  type RoomCode,
  type SubmissionId,
} from '@dub/shared';
import type { RoomStore } from '../room/RoomManager.js';

export interface StoredChunk {
  round: number;
  mime: AudioMime;
  bytes: number;
  /** False while the write is in flight. */
  ready: boolean;
  file: string;
}

export type PutResult = { ok: true; bytes: number } | { ok: false; code: 'LIMIT'; message: string };

/** Safe path segment (room codes, nanoid submission ids, chunk ids). */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Uploaded dub chunks on disk at `DATA_DIR/<room>/<round>/<submissionId>/<chunkId>`, with mime
 * and size kept in memory. Writes are atomic (tmp + rename). `init()` wipes the directory.
 */
export class ChunkStore implements RoomStore {
  private readonly index = new Map<RoomCode, Map<SubmissionId, Map<ChunkId, StoredChunk>>>();
  private readonly limits: Limits;

  constructor(
    readonly dir: string,
    opts: { limits?: Limits } = {},
  ) {
    this.limits = opts.limits ?? LIMITS;
  }

  /** Startup wipe: uploads never survive a restart. */
  async init(): Promise<void> {
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.dir, { recursive: true });
    this.index.clear();
  }

  isUploaded(code: RoomCode, submissionId: SubmissionId, chunkId: ChunkId): boolean {
    return this.index.get(code)?.get(submissionId)?.get(chunkId)?.ready ?? false;
  }

  get(code: RoomCode, submissionId: SubmissionId, chunkId: ChunkId): StoredChunk | undefined {
    const c = this.index.get(code)?.get(submissionId)?.get(chunkId);
    return c?.ready ? c : undefined;
  }

  /** Bytes and count currently stored for a submission. */
  usage(code: RoomCode, submissionId: SubmissionId): { bytes: number; count: number } {
    const sub = this.index.get(code)?.get(submissionId);
    let bytes = 0;
    for (const c of sub?.values() ?? []) bytes += c.bytes;
    return { bytes, count: sub?.size ?? 0 };
  }

  /** Idempotent overwrite of one chunk, enforcing per-chunk and per-submission limits. */
  async put(
    code: RoomCode,
    round: number,
    submissionId: SubmissionId,
    chunkId: ChunkId,
    mime: AudioMime,
    data: Buffer,
  ): Promise<PutResult> {
    for (const s of [code, submissionId, chunkId]) {
      if (!SEGMENT.test(s)) throw new Error(`unsafe path segment ${JSON.stringify(s)}`);
    }
    if (!Number.isInteger(round) || round < 0) throw new Error('bad round');
    const lim = this.limits;
    if (data.length > lim.maxChunkBytes)
      return { ok: false, code: 'LIMIT', message: 'chunk too large' };
    let room = this.index.get(code);
    if (!room) this.index.set(code, (room = new Map()));
    let sub = room.get(submissionId);
    if (!sub) room.set(submissionId, (sub = new Map()));
    const prev = sub.get(chunkId);
    if (!prev && sub.size >= lim.maxChunksPerSubmission) {
      return { ok: false, code: 'LIMIT', message: 'too many chunks' };
    }
    let total = 0;
    for (const [id, c] of sub) if (id !== chunkId) total += c.bytes;
    if (total + data.length > lim.maxSubmissionBytes) {
      return { ok: false, code: 'LIMIT', message: 'submission too large' };
    }
    const dir = path.join(this.dir, code, String(round), submissionId);
    const file = path.join(dir, chunkId);
    // Reserve synchronously so concurrent uploads see the bytes.
    const entry: StoredChunk = { round, mime, bytes: data.length, ready: false, file };
    sub.set(chunkId, entry);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    } catch (e) {
      if (sub.get(chunkId) === entry) {
        if (prev) sub.set(chunkId, prev);
        else sub.delete(chunkId);
      }
      throw e;
    }
    if (!this.index.has(code)) {
      // room deleted while writing
      await fsp.rm(path.join(this.dir, code), { recursive: true, force: true });
      return { ok: true, bytes: data.length };
    }
    entry.ready = true;
    return { ok: true, bytes: data.length };
  }

  open(chunk: StoredChunk): fs.ReadStream {
    return fs.createReadStream(chunk.file);
  }

  async deleteRoom(code: RoomCode): Promise<void> {
    this.index.delete(code);
    if (!SEGMENT.test(code)) return;
    await fsp.rm(path.join(this.dir, code), { recursive: true, force: true });
  }
}
