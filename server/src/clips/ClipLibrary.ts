import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import {
  ClipAttributionSchema,
  ClipManifestSchema,
  collectTags,
  libraryPaths,
  paths,
  type AdminClip,
  type AdminLibrary,
  type ClipAttribution,
  type ClipInfo,
  type ClipManifestEntry,
  type ClipStatus,
  type LibrarySummary,
  type LibraryVisibility,
} from '@dub/shared';
import { openDb, tx, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { JobQueue } from './normalize.js';

/** Id of the official library imported from `CLIPS_DIR/manifest.json`. */
export const BUILTIN_LIBRARY_ID = 'classics';
const BUILTIN_NAME = 'Classics';
const BUILTIN_DESCRIPTION = 'The built-in collection of open-licensed film clips.';

export type ClipOrigin = 'manifest' | 'upload';

/** A playable clip with its server-only fields (never sent as is: see `toClipInfo`). */
export interface LibraryClip extends ClipInfo {
  file: string;
  poster?: string;
  libraryId: string;
  origin: ClipOrigin;
}

/** What a Room needs from the library (types.ts `RoomLibrary`). */
export interface RoomLibrarySource {
  defaultId(): string | null;
  clipsOf(libraryId: string): readonly ClipInfo[] | null;
  canUse(libraryId: string, userId: string | undefined): boolean;
}

export class LibraryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

interface LibraryRow {
  id: string;
  name: string;
  description: string;
  owner_user_id: string | null;
  visibility: LibraryVisibility;
  is_default: number;
  disabled: number;
  created_at: number;
  updated_at: number;
}

/** Ownership facts of a library (V06 access checks). */
export interface LibraryAccess {
  id: string;
  visibility: LibraryVisibility;
  ownerUserId: string | null;
  disabled: boolean;
}

/** Server-side facts about any clip row (V06 ownership / reports). */
export interface ClipMeta {
  id: string;
  libraryId: string;
  title: string;
  origin: ClipOrigin;
  status: ClipStatus;
  uploadedBy: string | null;
  file: string;
  poster: string | null;
  /** Directory the clip's files live in (null if uploads are not configured). */
  dir: string | null;
}

interface ClipRow {
  id: string;
  library_id: string;
  title: string;
  file: string;
  poster: string | null;
  duration_ms: number;
  width: number;
  height: number;
  bytes: number;
  tags: string;
  attribution: string;
  enabled: number;
  origin: ClipOrigin;
  status: ClipStatus;
  error: string | null;
  uploaded_by: string | null;
  rights_confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClipLibraryOptions {
  /** Read-only built-in clips + manifest.json. */
  clipsDir: string;
  /** Writable upload storage (`<libraryDir>/<libraryId>/<file>`). Uploads need it. */
  libraryDir?: string;
  now?: () => number;
}

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

/** Validates `CLIPS_DIR/manifest.json` (or `json`) and drops entries whose file is missing. */
export function readManifest(
  dir: string,
  json?: unknown,
): { entries: ClipManifestEntry[]; warnings: string[]; found: boolean } {
  if (json === undefined) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { entries: [], warnings: [`no manifest at ${manifestPath}`], found: false };
    }
    json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const parsed = ClipManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid clip manifest in ${dir}: ${parsed.error.message}`);
  }
  const warnings: string[] = [];
  const entries: ClipManifestEntry[] = [];
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
    entries.push({ ...e, poster });
  }
  return { entries, warnings, found: true };
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowAttribution(r: ClipRow): ClipAttribution {
  const a = ClipAttributionSchema.safeParse(parseJson(r.attribution, {}));
  return a.success ? a.data : { author: '', source: '', license: '' };
}

/**
 * DB-backed clip libraries (V05). Libraries and clips live in SQLite; built-in clips are files in
 * the read-only CLIPS_DIR (imported from its manifest at startup), uploads live in LIBRARY_DIR.
 * Playable clips are cached in memory and rebuilt after every mutation (`reload`).
 */
export class ClipLibrary implements RoomLibrarySource {
  readonly dir: string;
  readonly libraryDir: string | null;
  /** Problems found while importing the manifest (missing files, missing manifest). */
  warnings: readonly string[] = [];
  private readonly now: () => number;
  private libs = new Map<string, LibraryRow>();
  private rows = new Map<string, ClipRow>();
  private playable = new Map<string, LibraryClip[]>();
  private playableInfo = new Map<string, ClipInfo[]>();
  private byId = new Map<string, LibraryClip>();
  /** Serve index: `<libraryId>/<file>` → directory; `/<file>` for the legacy `/clips/<file>`. */
  private serve = new Map<string, string>();
  private defaultLib: string | null = null;
  private readonly listeners = new Set<() => void>();
  /** The one normalize queue, shared by admin and user uploads (V06: admin jobs go first). */
  readonly jobs = new JobQueue(5, 10, 1);

  constructor(
    readonly db: Db,
    opts: ClipLibraryOptions,
  ) {
    this.dir = opts.clipsDir;
    this.libraryDir = opts.libraryDir ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** Imports the manifest, fails clips interrupted by a restart, and loads the caches. */
  static open(db: Db, opts: ClipLibraryOptions): ClipLibrary {
    const lib = new ClipLibrary(db, opts);
    lib.importManifest();
    db.prepare(
      `UPDATE clips SET status = 'failed', error = 'interrupted by a server restart', updated_at = ?
       WHERE status = 'processing'`,
    ).run(lib.now());
    lib.reload();
    return lib;
  }

  /** Stand-alone library over `dir` with an in-memory DB (tests, tools). */
  static load(dir: string): ClipLibrary {
    const db = openDb(':memory:');
    migrate(db);
    return ClipLibrary.open(db, { clipsDir: dir });
  }

  static fromManifest(dir: string, json: unknown): ClipLibrary {
    const db = openDb(':memory:');
    migrate(db);
    const lib = new ClipLibrary(db, { clipsDir: dir });
    lib.importManifest(json);
    lib.reload();
    return lib;
  }

  /**
   * Idempotent: creates the official `classics` library (default if there is none yet) and upserts
   * every manifest clip. Technical fields follow the manifest; admin edits (title, tags,
   * attribution, enabled) are kept.
   */
  importManifest(json?: unknown): void {
    const { entries, warnings } = readManifest(this.dir, json);
    this.warnings = warnings;
    const now = this.now();
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO libraries
             (id, name, description, owner_user_id, visibility, is_default, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'official',
             (SELECT COUNT(*) = 0 FROM libraries WHERE is_default = 1), ?, ?)`,
        )
        .run(BUILTIN_LIBRARY_ID, BUILTIN_NAME, BUILTIN_DESCRIPTION, now, now);
      const dropSameFile = this.db.prepare(
        `DELETE FROM clips WHERE origin = 'manifest' AND library_id = ? AND file = ? AND id <> ?`,
      );
      const upsert = this.db.prepare(
        `INSERT INTO clips (id, library_id, title, file, poster, duration_ms, width, height, bytes,
                            tags, attribution, enabled, origin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manifest', 'ready', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file = excluded.file, poster = excluded.poster, duration_ms = excluded.duration_ms,
           width = excluded.width, height = excluded.height, bytes = excluded.bytes
         WHERE clips.origin = 'manifest'`,
      );
      for (const e of entries) {
        let bytes = 0;
        try {
          bytes = fs.statSync(path.join(this.dir, e.file)).size;
        } catch {
          /* checked by readManifest */
        }
        dropSameFile.run(BUILTIN_LIBRARY_ID, e.file, e.id);
        upsert.run(
          e.id,
          BUILTIN_LIBRARY_ID,
          e.title,
          e.file,
          e.poster ?? null,
          e.durationMs,
          e.width,
          e.height,
          bytes,
          JSON.stringify(e.tags),
          JSON.stringify(e.attribution),
          now,
          now,
        );
      }
    });
  }

  /** Rebuilds the in-memory caches from the DB and notifies `onChange` listeners. */
  reload(): void {
    const libs = this.db.prepare('SELECT * FROM libraries').all() as unknown as LibraryRow[];
    const rows = this.db
      .prepare('SELECT * FROM clips ORDER BY created_at, id')
      .all() as unknown as ClipRow[];
    this.libs = new Map(libs.map((l) => [l.id, l]));
    this.rows = new Map(rows.map((r) => [r.id, r]));
    this.defaultLib = libs.find((l) => l.is_default === 1)?.id ?? null;
    // Disabled libraries (V06) have no playable list: `clipsOf` is null, rooms fall back.
    this.playable = new Map(libs.filter((l) => l.disabled !== 1).map((l) => [l.id, []]));
    this.byId = new Map();
    this.serve = new Map();
    for (const r of rows) {
      if (r.status !== 'ready') continue;
      if (this.libs.get(r.library_id)?.disabled === 1) continue;
      const dir = this.dirOf(r);
      if (!dir || !fs.existsSync(path.join(dir, r.file))) continue;
      const hasPoster = !!r.poster && fs.existsSync(path.join(dir, r.poster));
      for (const f of hasPoster ? [r.file, r.poster!] : [r.file]) {
        this.serve.set(`${r.library_id}/${f}`, dir);
        if (r.origin === 'manifest') this.serve.set(`/${f}`, dir);
      }
      if (r.enabled !== 1) continue;
      const clip = this.toLibraryClip(r, hasPoster);
      this.playable.get(r.library_id)?.push(clip);
      this.byId.set(clip.id, clip);
    }
    this.playableInfo = new Map([...this.playable].map(([id, list]) => [id, list.map(toClipInfo)]));
    for (const fn of this.listeners) fn();
  }

  /** `fn` runs after every reload (rooms refresh their lobby clip counts). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private dirOf(r: ClipRow): string | null {
    if (r.origin === 'manifest') return this.dir;
    return this.libraryDir ? path.join(this.libraryDir, r.library_id) : null;
  }

  private urlOf(r: ClipRow, file: string): string {
    return r.origin === 'manifest'
      ? paths.clip(file)
      : libraryPaths.libraryClip(r.library_id, file);
  }

  private toLibraryClip(r: ClipRow, hasPoster: boolean): LibraryClip {
    const c: LibraryClip = {
      id: r.id,
      title: r.title,
      url: this.urlOf(r, r.file),
      durationMs: r.duration_ms,
      width: r.width,
      height: r.height,
      tags: parseJson<string[]>(r.tags, []),
      attribution: rowAttribution(r),
      file: r.file,
      libraryId: r.library_id,
      origin: r.origin,
    };
    if (hasPoster && r.poster) {
      c.poster = r.poster;
      c.posterUrl = this.urlOf(r, r.poster);
    }
    return c;
  }

  // ------------------------------------------------------------ queries (game)

  defaultId(): string | null {
    return this.defaultLib;
  }

  clipsOf(libraryId: string): readonly ClipInfo[] | null {
    return this.playableInfo.get(libraryId) ?? null;
  }

  /** Official libraries are open to every host; private ones (V06) only to their owner. */
  canUse(libraryId: string, userId: string | undefined): boolean {
    const l = this.libs.get(libraryId);
    if (!l || l.disabled === 1) return false;
    return l.visibility === 'official' || (!!userId && l.owner_user_id === userId);
  }

  /** Playable clips of the default library. */
  get clips(): readonly LibraryClip[] {
    return (this.defaultLib && this.playable.get(this.defaultLib)) || [];
  }

  get size(): number {
    return this.clips.length;
  }

  /** A playable clip in any library. */
  get(id: string): LibraryClip | undefined {
    return this.byId.get(id);
  }

  /** Legacy `/clips/<file>`: true for built-in clip / poster files. */
  hasFile(file: string): boolean {
    return this.serve.has(`/${file}`);
  }

  /** Directory to serve `file` from (`libraryId` null = legacy built-in URL), or null. */
  serveDir(libraryId: string | null, file: string): string | null {
    return this.serve.get(`${libraryId ?? ''}/${file}`) ?? null;
  }

  tags(): string[] {
    return collectTags(this.clips);
  }

  /**
   * Libraries for the lobby picker: official ones (default first), then `userId`'s own private
   * ones (V06, not disabled).
   */
  summaries(userId?: string | null): LibrarySummary[] {
    const official = [...this.libs.values()]
      .filter((l) => l.visibility === 'official' && l.disabled !== 1)
      .map((l) => this.summary(l))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
    const own = userId
      ? [...this.libs.values()]
          .filter((l) => l.visibility === 'private' && l.owner_user_id === userId && !l.disabled)
          .sort((a, b) => a.created_at - b.created_at)
          .map((l) => this.summary(l))
      : [];
    return [...official, ...own];
  }

  /** Visibility / owner / disabled of a library, or null if unknown. */
  access(libraryId: string): LibraryAccess | null {
    const l = this.libs.get(libraryId);
    if (!l) return null;
    return {
      id: l.id,
      visibility: l.visibility,
      ownerUserId: l.owner_user_id,
      disabled: l.disabled === 1,
    };
  }

  /** Any clip row (also processing / failed / disabled), or null. */
  clipMeta(id: string): ClipMeta | null {
    const r = this.rows.get(id);
    if (!r) return null;
    return {
      id: r.id,
      libraryId: r.library_id,
      title: r.title,
      origin: r.origin,
      status: r.status,
      uploadedBy: r.uploaded_by,
      file: r.file,
      poster: r.poster,
      dir: this.dirOf(r),
    };
  }

  private summary(l: LibraryRow): LibrarySummary {
    return {
      id: l.id,
      name: l.name,
      description: l.description,
      visibility: l.visibility,
      isDefault: l.is_default === 1,
      clipCount: this.playable.get(l.id)?.length ?? 0,
    };
  }

  // ------------------------------------------------------------ admin

  private requireLib(id: string): LibraryRow {
    const l = this.libs.get(id);
    if (!l) throw new LibraryError('NOT_FOUND', 'unknown library');
    return l;
  }

  private requireClip(id: string): ClipRow {
    const r = this.rows.get(id);
    if (!r) throw new LibraryError('NOT_FOUND', 'unknown clip');
    return r;
  }

  private isBuiltinLib(id: string): boolean {
    if (id === BUILTIN_LIBRARY_ID) return true;
    for (const r of this.rows.values()) {
      if (r.library_id === id && r.origin === 'manifest') return true;
    }
    return false;
  }

  /** All libraries, or only those of one visibility / owner. */
  adminLibraries(
    filter: { visibility?: LibraryVisibility; ownerUserId?: string } = {},
  ): AdminLibrary[] {
    const totals = new Map<string, number>();
    for (const r of this.rows.values())
      totals.set(r.library_id, (totals.get(r.library_id) ?? 0) + 1);
    return [...this.libs.values()]
      .filter((l) => !filter.visibility || l.visibility === filter.visibility)
      .filter((l) => !filter.ownerUserId || l.owner_user_id === filter.ownerUserId)
      .sort((a, b) => b.is_default - a.is_default || a.created_at - b.created_at)
      .map((l) => ({
        ...this.summary(l),
        ownerUserId: l.owner_user_id,
        totalClips: totals.get(l.id) ?? 0,
        builtin: this.isBuiltinLib(l.id),
        createdAt: l.created_at,
        disabled: l.disabled === 1,
      }));
  }

  adminLibrary(id: string): AdminLibrary {
    this.requireLib(id);
    return this.adminLibraries().find((l) => l.id === id)!;
  }

  createLibrary(
    body: { name: string; description?: string },
    owner: { userId: string; visibility: 'private' } | null = null,
  ): AdminLibrary {
    const id = newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO libraries (id, name, description, owner_user_id, visibility, is_default,
                                created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        body.name,
        body.description ?? '',
        owner?.userId ?? null,
        owner ? 'private' : 'official',
        now,
        now,
      );
    this.reload();
    return this.adminLibrary(id);
  }

  updateLibrary(id: string, patch: { name?: string; description?: string }): AdminLibrary {
    const l = this.requireLib(id);
    this.db
      .prepare('UPDATE libraries SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? l.name, patch.description ?? l.description, this.now(), id);
    this.reload();
    return this.adminLibrary(id);
  }

  setDefault(id: string): AdminLibrary {
    const l = this.requireLib(id);
    if (l.visibility !== 'official') {
      throw new LibraryError('INVALID', 'only an official library can be the default');
    }
    tx(this.db, () => {
      this.db.prepare('UPDATE libraries SET is_default = 0 WHERE is_default = 1').run();
      this.db
        .prepare('UPDATE libraries SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(this.now(), id);
    });
    this.reload();
    return this.adminLibrary(id);
  }

  /** V06 admin: disables / re-enables a private library (its clips stop being played/served). */
  setLibraryDisabled(id: string, disabled: boolean): AdminLibrary {
    const l = this.requireLib(id);
    if (l.visibility !== 'private') {
      throw new LibraryError('INVALID', 'only private libraries can be disabled');
    }
    this.db
      .prepare('UPDATE libraries SET disabled = ?, updated_at = ? WHERE id = ?')
      .run(disabled ? 1 : 0, this.now(), id);
    this.reload();
    return this.adminLibrary(id);
  }

  /** V06 quotas: what `userId` owns / uploaded. */
  usage(userId: string): { libraries: number; clips: number; bytes: number } {
    const libs = this.db
      .prepare(`SELECT COUNT(*) AS n FROM libraries WHERE owner_user_id = ?`)
      .get(userId) as { n: number };
    const clips = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM clips WHERE uploaded_by = ?`)
      .get(userId) as { n: number; b: number };
    return { libraries: libs.n, clips: clips.n, bytes: clips.b };
  }

  /** V06: removes every private library of `userId` with its files (account deletion). */
  deleteUserLibraries(userId: string): void {
    const ids = [...this.libs.values()]
      .filter((l) => l.owner_user_id === userId && l.visibility === 'private')
      .map((l) => l.id);
    if (!ids.length) return;
    for (const id of ids) {
      this.db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
      if (this.libraryDir) {
        fs.rmSync(path.join(this.libraryDir, id), { recursive: true, force: true });
      }
    }
    this.reload();
  }

  /** Deletes a library with all its uploads. The default and the built-in one are protected. */
  deleteLibrary(id: string): void {
    const l = this.requireLib(id);
    if (l.is_default === 1) {
      throw new LibraryError('CONFLICT', 'make another library the default first');
    }
    if (this.isBuiltinLib(id)) throw new LibraryError('CONFLICT', 'the built-in library stays');
    for (const r of this.rows.values()) {
      if (r.library_id === id && r.status === 'processing') {
        throw new LibraryError('CONFLICT', 'a clip of this library is still processing');
      }
    }
    this.db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
    if (this.libraryDir) {
      fs.rmSync(path.join(this.libraryDir, id), { recursive: true, force: true });
    }
    this.reload();
  }

  adminClips(libraryId: string): AdminClip[] {
    this.requireLib(libraryId);
    return [...this.rows.values()]
      .filter((r) => r.library_id === libraryId)
      .map((r) => this.adminClip(r.id));
  }

  adminClip(id: string): AdminClip {
    const r = this.requireClip(id);
    const served = this.serve.has(`${r.library_id}/${r.file}`);
    const posterServed = !!r.poster && this.serve.has(`${r.library_id}/${r.poster}`);
    return {
      id: r.id,
      libraryId: r.library_id,
      title: r.title,
      url: served ? this.urlOf(r, r.file) : null,
      posterUrl: posterServed ? this.urlOf(r, r.poster!) : null,
      durationMs: r.duration_ms,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      tags: parseJson<string[]>(r.tags, []),
      attribution: rowAttribution(r),
      enabled: r.enabled === 1,
      status: r.status,
      error: r.error,
      builtin: r.origin === 'manifest',
      playable: this.byId.has(r.id),
      createdAt: r.created_at,
      uploadedBy: r.uploaded_by,
      rightsConfirmedAt: r.rights_confirmed_at,
    };
  }

  /** Directory uploads of `libraryId` are written to (created on demand). */
  uploadDir(libraryId: string): string {
    if (!this.libraryDir) throw new LibraryError('INVALID', 'uploads are not configured');
    this.requireLib(libraryId);
    const dir = path.join(this.libraryDir, libraryId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** New `processing` clip row; the caller normalizes into `<uploadDir>/<file>` then `finishClip`. */
  createUpload(
    libraryId: string,
    meta: {
      title: string;
      tags: string[];
      attribution: ClipAttribution;
      uploadedBy?: string | null;
      rightsConfirmedAt?: number | null;
    },
  ): { id: string; file: string; poster: string } {
    const l = this.requireLib(libraryId);
    const id = `u${newId()}`;
    // V06: private clips get a random, unguessable file name (not derived from the clip id
    // that every room member sees); see routes/clips.ts for the access check.
    const base = l.visibility === 'private' ? randomBytes(16).toString('hex') : id;
    const file = `${base}.mp4`;
    const poster = `${base}.jpg`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO clips (id, library_id, title, file, poster, tags, attribution, enabled, origin,
                            status, uploaded_by, rights_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'upload', 'processing', ?, ?, ?, ?)`,
      )
      .run(
        id,
        libraryId,
        meta.title,
        file,
        poster,
        JSON.stringify(meta.tags),
        JSON.stringify(meta.attribution),
        meta.uploadedBy ?? null,
        meta.rightsConfirmedAt ?? null,
        now,
        now,
      );
    this.reload();
    return { id, file, poster };
  }

  finishUpload(
    id: string,
    info: { durationMs: number; width: number; height: number; bytes: number; poster: boolean },
  ): AdminClip {
    const r = this.requireClip(id);
    this.db
      .prepare(
        `UPDATE clips SET status = 'ready', error = NULL, duration_ms = ?, width = ?, height = ?,
                          bytes = ?, poster = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        info.durationMs,
        info.width,
        info.height,
        info.bytes,
        info.poster ? r.poster : null,
        this.now(),
        id,
      );
    this.reload();
    return this.adminClip(id);
  }

  failUpload(id: string, error: string): void {
    if (!this.rows.has(id)) return;
    this.db
      .prepare(`UPDATE clips SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(error.slice(0, 500), this.now(), id);
    this.reload();
  }

  updateClip(
    id: string,
    patch: { title?: string; tags?: string[]; attribution?: ClipAttribution; enabled?: boolean },
  ): AdminClip {
    const r = this.requireClip(id);
    this.db
      .prepare(
        `UPDATE clips SET title = ?, tags = ?, attribution = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? r.title,
        patch.tags ? JSON.stringify([...new Set(patch.tags)]) : r.tags,
        patch.attribution ? JSON.stringify(patch.attribution) : r.attribution,
        patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
        this.now(),
        id,
      );
    this.reload();
    return this.adminClip(id);
  }

  /** Deletes an uploaded clip and its files. Built-in clips can only be disabled. */
  deleteClip(id: string): void {
    const r = this.requireClip(id);
    if (r.origin === 'manifest') {
      throw new LibraryError('CONFLICT', 'built-in clips cannot be deleted, disable it instead');
    }
    if (r.status === 'processing') throw new LibraryError('CONFLICT', 'clip is still processing');
    this.db.prepare('DELETE FROM clips WHERE id = ?').run(id);
    const dir = this.dirOf(r);
    if (dir) {
      for (const f of [r.file, r.poster]) {
        if (f) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
    this.reload();
  }
}

/** The wire shape (drops server-only fields). */
export function toClipInfo(c: LibraryClip): ClipInfo {
  const { file: _f, poster: _p, libraryId: _l, origin: _o, ...info } = c;
  return info;
}
