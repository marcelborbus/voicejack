import fs from 'node:fs';
import path from 'node:path';
import {
  ClipManifestSchema,
  collectTags,
  paths,
  type ClipInfo,
  type ClipManifestEntry,
} from '@dub/shared';

export interface LibraryClip extends ClipInfo {
  file: string;
  poster?: string;
}

/** Reads `CLIPS_DIR/manifest.json`, validates it and keeps only clips whose file exists. */
export class ClipLibrary {
  readonly dir: string;
  readonly clips: readonly LibraryClip[];
  /** Human-readable problems found while loading (missing files, missing manifest). */
  readonly warnings: readonly string[];
  private readonly byId: Map<string, LibraryClip>;
  private readonly files: Set<string>;

  constructor(dir: string, clips: LibraryClip[], warnings: string[] = []) {
    this.dir = dir;
    this.clips = clips;
    this.warnings = warnings;
    this.byId = new Map(clips.map((c) => [c.id, c]));
    this.files = new Set(clips.flatMap((c) => (c.poster ? [c.file, c.poster] : [c.file])));
  }

  /**
   * Throws if the manifest exists but is invalid. A missing manifest yields an empty library
   * (with a warning) so the server can still start.
   */
  static load(dir: string): ClipLibrary {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return new ClipLibrary(dir, [], [`no manifest at ${manifestPath}`]);
    }
    return ClipLibrary.fromManifest(dir, JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  }

  static fromManifest(dir: string, json: unknown): ClipLibrary {
    const parsed = ClipManifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`invalid clip manifest in ${dir}: ${parsed.error.message}`);
    }
    const warnings: string[] = [];
    const clips: LibraryClip[] = [];
    for (const e of parsed.data.clips) {
      if (!fs.existsSync(path.join(dir, e.file))) {
        warnings.push(`clip ${e.id}: file ${e.file} missing, skipped`);
        continue;
      }
      let poster = e.poster;
      if (poster && !fs.existsSync(path.join(dir, poster))) {
        warnings.push(`clip ${e.id}: poster ${poster} missing, ignored`);
        poster = undefined;
      }
      clips.push(toLibraryClip({ ...e, poster }));
    }
    return new ClipLibrary(dir, clips, warnings);
  }

  get size(): number {
    return this.clips.length;
  }

  get(id: string): LibraryClip | undefined {
    return this.byId.get(id);
  }

  /** True if `file` is a clip or poster listed in the manifest (only those are served). */
  hasFile(file: string): boolean {
    return this.files.has(file);
  }

  tags(): string[] {
    return collectTags(this.clips);
  }
}

function toLibraryClip(e: ClipManifestEntry): LibraryClip {
  const info: LibraryClip = {
    id: e.id,
    title: e.title,
    url: paths.clip(e.file),
    durationMs: e.durationMs,
    width: e.width,
    height: e.height,
    tags: e.tags,
    attribution: e.attribution,
    file: e.file,
  };
  if (e.poster) {
    info.poster = e.poster;
    info.posterUrl = paths.clip(e.poster);
  }
  return info;
}

/** The wire shape (drops server-only fields). */
export function toClipInfo(c: LibraryClip): ClipInfo {
  const { file: _file, poster: _poster, ...info } = c;
  return info;
}
