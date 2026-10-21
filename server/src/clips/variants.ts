import type { JobOptions } from './normalize.js';
import { encodeLow } from './normalize.js';

/**
 * #53: makes the missing 480p renditions of official clips (`ClipLibrary.missingVariants`), one
 * clip per `low` priority job on the shared clip JobQueue, so uploads always go first. Started at
 * server startup and after every library change (imports); a refused push (another low job is
 * queued) is retried a little later. Each finished clip reloads the library, so its `lowUrl`
 * appears in new rooms right away.
 */
export interface VariantSource {
  missingVariants(): { libraryId: string; input: string; output: string }[];
  reload(): void;
  readonly jobs: { push<T>(job: () => Promise<T>, opts?: JobOptions): Promise<T> | null };
}

export class ClipVariants {
  private busy = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Inputs that failed once (corrupt file): not retried until the process restarts. */
  private readonly failed = new Set<string>();

  constructor(
    private readonly lib: VariantSource,
    private readonly opts: {
      encode?: (input: string, output: string) => Promise<void>;
      log?: (msg: string) => void;
      retryMs?: number;
    } = {},
  ) {}

  /** Starts (or continues) working through the missing renditions. */
  pump(): void {
    if (this.busy || this.stopped) return;
    const next = this.lib.missingVariants().find((v) => !this.failed.has(v.input));
    if (!next) return;
    const encode = this.opts.encode ?? encodeLow;
    this.busy = true;
    const job = this.lib.jobs.push(() => encode(next.input, next.output), {
      priority: 'low',
      owner: 'clip-variants',
    });
    if (!job) {
      this.busy = false;
      this.retry ??= setTimeout(() => {
        this.retry = null;
        this.pump();
      }, this.opts.retryMs ?? 30_000);
      this.retry.unref?.();
      return;
    }
    job.then(
      () => {
        this.busy = false;
        if (this.stopped) return;
        this.lib.reload();
        this.next();
      },
      (e: unknown) => {
        this.busy = false;
        this.failed.add(next.input);
        this.opts.log?.(`480p rendition failed for ${next.input}: ${(e as Error).message}`);
        this.next();
      },
    );
  }

  /** The next clip once the queue has let go of this job (it counts until then). */
  private next(): void {
    setTimeout(() => this.pump(), 0).unref?.();
  }

  /** Resolves when nothing is left to do (tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
  }
}
