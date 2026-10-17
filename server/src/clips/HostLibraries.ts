import {
  USER_MAX_BYTES,
  USER_MAX_CLIPS,
  USER_MAX_LIBRARIES,
  USER_UPLOADS_PER_DAY,
  type AdminClipReport,
  type AdminLibraryOwner,
  type AdminUserLibrary,
  type UserQuota,
} from '@dub/shared';
import type { ClipLibrary } from './ClipLibrary.js';

const DAY_MS = 24 * 3600_000;

/** Narrow view of the rooms (RoomManager) for private clip access and reports. */
export interface RoomsView {
  codes(): string[];
  get(code: string):
    | { servesLibraryTo(userId: string, libraryId: string): boolean }
    | undefined;
}

/**
 * V06 host libraries on top of `ClipLibrary`: per-user quotas, the upload ban, the rolling 24 h
 * upload counter, room-based access to private clips, clip reports and the admin overview.
 */
export class HostLibraries {
  constructor(
    readonly clips: ClipLibrary,
    private readonly now: () => number = Date.now,
  ) {}

  private get db() {
    return this.clips.db;
  }

  isUploadBanned(userId: string): boolean {
    const r = this.db.prepare('SELECT upload_banned AS b FROM users WHERE id = ?').get(userId) as
      | { b: number }
      | undefined;
    return r?.b === 1;
  }

  setUploadBanned(userId: string, banned: boolean): boolean {
    const res = this.db
      .prepare('UPDATE users SET upload_banned = ? WHERE id = ?')
      .run(banned ? 1 : 0, userId);
    return Number(res.changes) > 0;
  }

  uploadsToday(userId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM clip_uploads WHERE user_id = ? AND created_at > ?')
      .get(userId, this.now() - DAY_MS) as { n: number };
    return r.n;
  }

  recordUpload(userId: string): void {
    const t = this.now();
    this.db.prepare('INSERT INTO clip_uploads (user_id, created_at) VALUES (?, ?)').run(userId, t);
    this.db.prepare('DELETE FROM clip_uploads WHERE created_at < ?').run(t - 2 * DAY_MS);
  }

  quota(userId: string): UserQuota {
    const u = this.clips.usage(userId);
    return {
      libraries: u.libraries,
      maxLibraries: USER_MAX_LIBRARIES,
      clips: u.clips,
      maxClips: USER_MAX_CLIPS,
      bytes: u.bytes,
      maxBytes: USER_MAX_BYTES,
      uploadsToday: this.uploadsToday(userId),
      maxUploadsPerDay: USER_UPLOADS_PER_DAY,
      uploadBanned: this.isUploadBanned(userId),
    };
  }

  /** Why `userId` may not upload another clip right now, or null. */
  uploadRefusal(userId: string): string | null {
    const q = this.quota(userId);
    if (q.uploadBanned) return 'uploading is disabled for your account';
    if (q.clips >= q.maxClips) return `you have reached the limit of ${q.maxClips} clips`;
    if (q.bytes >= q.maxBytes) {
      return `you have used your ${Math.round(q.maxBytes / 1024 / 1024)} MB of clip storage`;
    }
    if (q.uploadsToday >= q.maxUploadsPerDay) {
      return `at most ${q.maxUploadsPerDay} uploads per day, try again tomorrow`;
    }
    return null;
  }

  /** Storage check after normalizing (the size is only known then). */
  storageExceeded(userId: string): string | null {
    return this.clips.usage(userId).bytes > USER_MAX_BYTES
      ? `clip storage quota (${Math.round(USER_MAX_BYTES / 1024 / 1024)} MB) exceeded`
      : null;
  }

  /**
   * May `userId` load the files of `libraryId`? Official: everyone. Private: the owner, or a
   * player of a live room whose selected library it is. Disabled libraries: nobody.
   */
  canView(libraryId: string, userId: string | null, rooms: RoomsView | undefined): boolean {
    const a = this.clips.access(libraryId);
    if (!a || a.disabled) return false;
    if (a.visibility === 'official') return true;
    if (!userId) return false;
    if (a.ownerUserId === userId) return true;
    return this.roomOf(libraryId, userId, rooms) !== null;
  }

  /** Code of a live room where `userId` plays with `libraryId` selected, or null. */
  roomOf(libraryId: string, userId: string, rooms: RoomsView | undefined): string | null {
    if (!rooms) return null;
    for (const code of rooms.codes()) {
      if (rooms.get(code)?.servesLibraryTo(userId, libraryId)) return code;
    }
    return null;
  }

  /** Files a clip report (a `reports` row with `clip_id`). Null if already reported by them. */
  reportClip(r: {
    clipId: string;
    roomCode: string;
    reporterUserId: string;
    reporterName: string;
    reason: string;
  }): number | null {
    const clip = this.clips.clipMeta(r.clipId);
    if (!clip) return null;
    const dup = this.db
      .prepare(
        'SELECT 1 FROM reports WHERE clip_id = ? AND reporter_user_id = ? AND resolved_at IS NULL',
      )
      .get(r.clipId, r.reporterUserId);
    if (dup) return null;
    const uploader =
      clip.uploadedBy && this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(clip.uploadedBy)
        ? clip.uploadedBy
        : null;
    const res = this.db
      .prepare(
        `INSERT INTO reports (created_at, context, room_code, reporter_user_id, reporter_name,
           reported_user_id, reported_name, reason, clip_id)
         VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        r.roomCode,
        r.reporterUserId,
        r.reporterName,
        uploader,
        `clip: ${clip.title}`.slice(0, 140),
        r.reason,
        r.clipId,
      );
    return Number(res.lastInsertRowid);
  }

  clipReports(limit = 200): AdminClipReport[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, clip_id, room_code, reporter_name, reason, resolved_at
         FROM reports WHERE clip_id IS NOT NULL ORDER BY (resolved_at IS NOT NULL), id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as {
      id: number;
      created_at: number;
      clip_id: string;
      room_code: string | null;
      reporter_name: string;
      reason: string;
      resolved_at: number | null;
    }[];
    return rows.map((r) => {
      const c = this.clips.clipMeta(r.clip_id);
      return {
        id: r.id,
        createdAt: r.created_at,
        clipId: r.clip_id,
        clipTitle: c?.title ?? null,
        libraryId: c?.libraryId ?? null,
        roomCode: r.room_code,
        reporterName: r.reporter_name,
        reason: r.reason,
        resolvedAt: r.resolved_at,
      };
    });
  }

  resolveReport(id: number): boolean {
    const res = this.db
      .prepare(
        'UPDATE reports SET resolved_at = ? WHERE id = ? AND clip_id IS NOT NULL AND resolved_at IS NULL',
      )
      .run(this.now(), id);
    return Number(res.changes) > 0;
  }

  private owner(userId: string | null): AdminLibraryOwner | null {
    if (!userId) return null;
    const r = this.db
      .prepare('SELECT id, email, display_name, upload_banned FROM users WHERE id = ?')
      .get(userId) as
      | { id: string; email: string | null; display_name: string; upload_banned: number }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      uploadBanned: r.upload_banned === 1,
    };
  }

  /** Admin "User libraries": every private library with owner and clips. */
  adminOverview(): AdminUserLibrary[] {
    return this.clips.adminLibraries({ visibility: 'private' }).map((l) => ({
      ...l,
      owner: this.owner(l.ownerUserId),
      clips: this.clips.adminClips(l.id),
    }));
  }
}

const instances = new WeakMap<ClipLibrary, HostLibraries>();

/** The `HostLibraries` of a library instance (one per app; routes share it). */
export function hostLibraries(clips: ClipLibrary): HostLibraries {
  let h = instances.get(clips);
  if (!h) instances.set(clips, (h = new HostLibraries(clips)));
  return h;
}
