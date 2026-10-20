import { paths, PLAYER_TOKEN_HEADER, type ChunkMeta, type ErrorCode, type FxId } from '@dub/shared';

/**
 * Per-round upload queue (§2.3): POSTs each take right after it is recorded (3 retries with
 * backoff), and keeps the server's manifest equal to the live set of takes. The manifest
 * lists chunks that are uploaded *or still pending*; failed and deleted chunks drop out
 * (the server only keeps `manifest ∩ uploaded` at the deadline anyway).
 */

export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface UploadQueueDeps {
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  /** Sends `{t:'manifest', round, chunks}` (and keeps it for reconnects). */
  sendManifest: (round: number, chunks: ChunkMeta[]) => void;
  getToken: () => string | null;
  onState?: (id: string, state: UploadState) => void;
  /** Final failure of one chunk (after retries, or a non-retryable error). */
  onError?: (id: string, code: ErrorCode | 'NETWORK', message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadQueueOptions {
  code: string;
  round: number;
  deps: UploadQueueDeps;
  /** Delay before retry n (1-based); its length is the number of retries. */
  backoffMs?: readonly number[];
}

interface Item {
  meta: ChunkMeta;
  blob: Blob | null;
  state: UploadState;
  /** Bumped on remove/retry so a stale upload loop stops. */
  gen: number;
}

const DEFAULT_BACKOFF = [500, 1500, 3000] as const;

/** HTTP statuses worth retrying. 409 (phase over), 413, 401, 415 are final. */
const retryable = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;

export class UploadQueue {
  readonly code: string;
  readonly round: number;
  private readonly deps: UploadQueueDeps;
  private readonly backoff: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private items = new Map<string, Item>();
  private idleWaiters: (() => void)[] = [];
  private disposed = false;
  private lastSent: string | null = null;

  constructor(opts: UploadQueueOptions) {
    this.code = opts.code;
    this.round = opts.round;
    this.deps = opts.deps;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.sleep = opts.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The manifest the server should have: uploaded + pending chunks, sorted by start. */
  manifest(): ChunkMeta[] {
    return [...this.items.values()]
      .filter((i) => i.state !== 'failed')
      .map((i) => i.meta)
      .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  state(id: string): UploadState | null {
    return this.items.get(id)?.state ?? null;
  }

  get pendingCount(): number {
    let n = 0;
    for (const i of this.items.values()) if (i.state === 'pending' || i.state === 'uploading') n++;
    return n;
  }

  /** A fresh take: upload it, then sync the manifest. `replaces` is dropped in the same step. */
  add(meta: ChunkMeta, blob: Blob, replaces: string | null = null): void {
    if (this.disposed) return;
    if (replaces) this.drop(replaces);
    const item: Item = { meta, blob, state: 'pending', gen: 0 };
    this.items.set(meta.id, item);
    this.setState(item, 'pending');
    this.syncManifest();
    void this.run(item);
  }

  /** Already on the server (restored after a reload). */
  adopt(meta: ChunkMeta): void {
    if (this.disposed || this.items.has(meta.id)) return;
    this.items.set(meta.id, { meta, blob: null, state: 'uploaded', gen: 0 });
  }

  /** #48: change a take's effect (uploaded or not); the server gets the new manifest. */
  setFx(id: string, fx: FxId): void {
    const item = this.items.get(id);
    if (!item || this.disposed) return;
    const { fx: _old, ...rest } = item.meta;
    item.meta = fx === 'none' ? rest : { ...rest, fx };
    this.syncManifest();
  }

  /** Delete a take. */
  remove(id: string): void {
    if (this.drop(id)) this.syncManifest();
  }

  /** Try a failed upload again. */
  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || item.state !== 'failed' || !item.blob || this.disposed) return;
    item.gen++;
    this.setState(item, 'pending');
    this.syncManifest();
    void this.run(item);
  }

  /** Send the manifest if it differs from the last one sent (`force`: always). */
  syncManifest(force = false): void {
    if (this.disposed) return;
    const chunks = this.manifest();
    const key = JSON.stringify(chunks);
    if (!force && key === this.lastSent) return;
    this.lastSent = key;
    this.deps.sendManifest(this.round, chunks);
  }

  /** Resolves once nothing is pending or uploading (failed counts as settled). */
  whenIdle(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  dispose(): void {
    this.disposed = true;
    for (const i of this.items.values()) i.gen++;
    this.resolveIdle(true);
  }

  // ---------- internals ----------

  private drop(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.gen++;
    this.items.delete(id);
    this.resolveIdle();
    return true;
  }

  private setState(item: Item, state: UploadState) {
    item.state = state;
    this.deps.onState?.(item.meta.id, state);
  }

  private alive(item: Item, gen: number): boolean {
    return !this.disposed && item.gen === gen && this.items.get(item.meta.id) === item;
  }

  private async run(item: Item): Promise<void> {
    const gen = item.gen;
    const { meta } = item;
    let lastCode: ErrorCode | 'NETWORK' = 'NETWORK';
    let lastMsg = 'Upload failed';
    for (let attempt = 0; attempt <= this.backoff.length; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.backoff[attempt - 1]!);
        if (!this.alive(item, gen)) return;
      }
      if (!this.alive(item, gen)) return;
      this.setState(item, 'uploading');
      let status = 0;
      try {
        const headers: Record<string, string> = { 'Content-Type': meta.mime };
        const token = this.deps.getToken();
        if (token) headers[PLAYER_TOKEN_HEADER] = token;
        const res = await this.deps.fetch(paths.chunkUpload(this.code, this.round, meta.id), {
          method: 'POST',
          headers,
          body: item.blob,
        });
        status = res.status;
        if (res.ok) {
          if (!this.alive(item, gen)) return;
          item.blob = null; // free memory; the decoded buffer lives in the editor
          this.setState(item, 'uploaded');
          this.syncManifest(true);
          this.resolveIdle();
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          error?: ErrorCode;
          message?: string;
        } | null;
        lastCode = body?.error ?? 'NETWORK';
        lastMsg = body?.message ?? `HTTP ${status}`;
      } catch (e) {
        lastCode = 'NETWORK';
        lastMsg = e instanceof Error ? e.message : String(e);
      }
      if (!this.alive(item, gen)) return;
      if (status !== 0 && !retryable(status)) break;
    }
    if (!this.alive(item, gen)) return;
    this.setState(item, 'failed');
    this.syncManifest();
    this.deps.onError?.(meta.id, lastCode, lastMsg);
    this.resolveIdle();
  }

  private resolveIdle(all = false) {
    if (!all && this.pendingCount > 0) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }
}

// ---------- one queue per round, surviving StrictMode remounts ----------

let current: { key: string; queue: UploadQueue } | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;

/** The queue for `key` (`code:round:submissionId`), creating it (and dropping an old one). */
export function acquireUploadQueue(key: string, create: () => UploadQueue): UploadQueue {
  if (disposeTimer) {
    clearTimeout(disposeTimer);
    disposeTimer = null;
  }
  if (current?.key === key) return current.queue;
  current?.queue.dispose();
  current = { key, queue: create() };
  return current.queue;
}

/** Dispose on the next tick unless re-acquired (remount). */
export function releaseUploadQueue(key: string, onDispose?: () => void): void {
  if (current?.key !== key) return;
  if (disposeTimer) clearTimeout(disposeTimer);
  disposeTimer = setTimeout(() => {
    disposeTimer = null;
    if (current?.key !== key) return;
    current.queue.dispose();
    current = null;
    onDispose?.();
  }, 0);
}
