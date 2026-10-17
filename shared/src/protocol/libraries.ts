import { z } from 'zod';
import { MAX_TAG_LENGTH, MAX_TAGS } from '../constants.js';
import type { ClipAttribution } from './common.js';
import { ClipAttributionSchema } from './common.js';

// Clip libraries (V05). Official libraries are managed on /admin; V06 adds private ones.

export const LIBRARY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LibraryIdSchema = z.string().regex(LIBRARY_ID_RE);

/** Raw upload cap for /api/admin (input before normalization). */
export const ADMIN_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** Normalized clips are at most this long (the game's limit, PLAN §2.1). */
export const LIBRARY_CLIP_MAX_SECONDS = 60;

export type LibraryVisibility = 'official' | 'private';

/** GET /api/libraries: libraries a host can pick in the lobby. */
export interface LibrarySummary {
  id: string;
  name: string;
  description: string;
  visibility: LibraryVisibility;
  isDefault: boolean;
  /** Playable clips (enabled, ready, file present). */
  clipCount: number;
}
export interface LibrariesResponse {
  libraries: LibrarySummary[];
}

// ---------- admin (/api/admin/*, Authelia group `admins`) ----------

export interface AdminLibrary extends LibrarySummary {
  ownerUserId: string | null;
  /** All clips including disabled / processing / failed. */
  totalClips: number;
  /** Built-in (imported from clips/manifest.json): cannot be deleted. */
  builtin: boolean;
  createdAt: number;
  /** V06: disabled by an admin (private libraries only): not playable, not served. */
  disabled: boolean;
}

export type ClipStatus = 'processing' | 'ready' | 'failed';

export interface AdminClip {
  id: string;
  libraryId: string;
  title: string;
  url: string | null;
  posterUrl: string | null;
  durationMs: number;
  width: number;
  height: number;
  bytes: number;
  tags: string[];
  attribution: ClipAttribution;
  enabled: boolean;
  status: ClipStatus;
  error: string | null;
  /** From clips/manifest.json (read-only files, cannot be deleted, only disabled). */
  builtin: boolean;
  /** True if the clip can be picked in a game right now. */
  playable: boolean;
  createdAt: number;
  /** V06: user id of the uploader (null for built-in clips and admin uploads). */
  uploadedBy: string | null;
  /** V06: when the uploader confirmed they hold the rights (takedown notice). */
  rightsConfirmedAt: number | null;
}

export interface AdminMeResponse {
  user: string;
  groups: string[];
  /** ADMIN_DEV=1 bypass is active (local development only). */
  dev: boolean;
}
export interface AdminLibrariesResponse {
  libraries: AdminLibrary[];
}
export interface AdminClipsResponse {
  clips: AdminClip[];
}

export const LibraryNameSchema = z.string().trim().min(1).max(60);
export const LibraryDescriptionSchema = z.string().trim().max(500);

export const CreateLibraryBodySchema = z.object({
  name: LibraryNameSchema,
  description: LibraryDescriptionSchema.default(''),
});
export type CreateLibraryBody = z.input<typeof CreateLibraryBodySchema>;

export const UpdateLibraryBodySchema = z
  .object({ name: LibraryNameSchema, description: LibraryDescriptionSchema })
  .partial();
export type UpdateLibraryBody = z.infer<typeof UpdateLibraryBodySchema>;

export const ClipTitleSchema = z.string().trim().min(1).max(120);
export const ClipTagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_TAGS);

export const UpdateClipBodySchema = z
  .object({
    title: ClipTitleSchema,
    tags: ClipTagsSchema,
    attribution: ClipAttributionSchema,
    enabled: z.boolean(),
  })
  .partial();
export type UpdateClipBody = z.infer<typeof UpdateClipBodySchema>;

/**
 * POST /api/admin/libraries/:id/clips — the raw video is the request body
 * (`Content-Type: application/octet-stream` or `video/*`), metadata goes in the query string.
 * `ss`/`t` (seconds) trim the input; the result is at most LIBRARY_CLIP_MAX_SECONDS long.
 */
export const UploadClipQuerySchema = z.object({
  title: ClipTitleSchema,
  ss: z.coerce
    .number()
    .min(0)
    .max(24 * 3600)
    .default(0),
  t: z.coerce.number().positive().max(LIBRARY_CLIP_MAX_SECONDS).optional(),
  /** Comma-separated. */
  tags: z.string().max(1200).default(''),
  author: z.string().max(200).default(''),
  source: z.string().max(500).default(''),
  license: z.string().max(100).default(''),
  licenseUrl: z.string().max(500).optional(),
});
export type UploadClipQuery = z.input<typeof UploadClipQuerySchema>;
export interface UploadClipResponse {
  clip: AdminClip;
}

// ---------- V06: host libraries (/api/my/*, registered users) ----------

/** Per-user quotas for private libraries. */
export const USER_MAX_LIBRARIES = 5;
export const USER_MAX_CLIPS = 30;
export const USER_MAX_BYTES = 300 * 1024 * 1024;
export const USER_UPLOADS_PER_DAY = 10;
/** Raw upload cap for users (input before normalization). */
export const USER_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

export interface UserQuota {
  libraries: number;
  maxLibraries: number;
  /** Clips the user uploaded (every status). */
  clips: number;
  maxClips: number;
  /** Bytes of the user's normalized clips. */
  bytes: number;
  maxBytes: number;
  /** Uploads in the last 24 h. */
  uploadsToday: number;
  maxUploadsPerDay: number;
  /** Banned from uploading by an admin. */
  uploadBanned: boolean;
}

export interface MyLibrariesResponse {
  libraries: AdminLibrary[];
  quota: UserQuota;
}
export interface MyClipsResponse {
  clips: AdminClip[];
}

/** Users edit title, tags, attribution and enabled of their own clips. */
export const UpdateMyClipBodySchema = UpdateClipBodySchema;

/** As the admin upload, plus the takedown notice checkbox (`rights=1`). */
export const UploadMyClipQuerySchema = UploadClipQuerySchema.extend({
  rights: z.literal('1', { message: 'confirm that you have the rights to this clip' }),
});
export type UploadMyClipQuery = z.input<typeof UploadMyClipQuerySchema>;

/** POST /api/clips/:id/report — players of a private room report a clip. */
export const ReportClipBodySchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type ReportClipBody = z.infer<typeof ReportClipBodySchema>;

/** Admin moderation of private libraries. */
export interface AdminLibraryOwner {
  id: string;
  email: string | null;
  displayName: string;
  uploadBanned: boolean;
}
export interface AdminUserLibrary extends AdminLibrary {
  owner: AdminLibraryOwner | null;
  clips: AdminClip[];
}
export interface AdminClipReport {
  id: number;
  createdAt: number;
  clipId: string;
  /** Null once the clip is deleted. */
  clipTitle: string | null;
  libraryId: string | null;
  roomCode: string | null;
  reporterName: string;
  reason: string;
  resolvedAt: number | null;
}
export interface AdminUserLibrariesResponse {
  libraries: AdminUserLibrary[];
  reports: AdminClipReport[];
}
export const SetDisabledBodySchema = z.object({ disabled: z.boolean() });
export const UploadBanBodySchema = z.object({ banned: z.boolean() });

export const libraryPaths = {
  libraries: () => '/api/libraries',
  libraryClip: (libraryId: string, file: string) =>
    `/clips/${encodeURIComponent(libraryId)}/${encodeURIComponent(file)}`,
  adminMe: () => '/api/admin/me',
  adminLibraries: () => '/api/admin/libraries',
  adminLibrary: (id: string) => `/api/admin/libraries/${encodeURIComponent(id)}`,
  adminLibraryDefault: (id: string) => `/api/admin/libraries/${encodeURIComponent(id)}/default`,
  adminLibraryClips: (id: string) => `/api/admin/libraries/${encodeURIComponent(id)}/clips`,
  adminClip: (id: string) => `/api/admin/clips/${encodeURIComponent(id)}`,
  adminClipFile: (id: string, kind: 'video' | 'poster') =>
    `/api/admin/clips/${encodeURIComponent(id)}/${kind}`,
  adminUserLibraries: () => '/api/admin/user-libraries',
  adminLibraryDisabled: (id: string) => `/api/admin/libraries/${encodeURIComponent(id)}/disabled`,
  adminUploadBan: (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}/upload-ban`,
  adminReportResolve: (id: number) => `/api/admin/reports/${id}/resolve`,
  myLibraries: () => '/api/my/libraries',
  myLibrary: (id: string) => `/api/my/libraries/${encodeURIComponent(id)}`,
  myLibraryClips: (id: string) => `/api/my/libraries/${encodeURIComponent(id)}/clips`,
  myClip: (id: string) => `/api/my/clips/${encodeURIComponent(id)}`,
  reportClip: (id: string) => `/api/clips/${encodeURIComponent(id)}/report`,
} as const;

export const libraryRoutes = {
  libraries: '/api/libraries',
  libraryClip: '/clips/:libraryId/:file',
  adminMe: '/api/admin/me',
  adminLibraries: '/api/admin/libraries',
  adminLibrary: '/api/admin/libraries/:id',
  adminLibraryDefault: '/api/admin/libraries/:id/default',
  adminLibraryClips: '/api/admin/libraries/:id/clips',
  adminClip: '/api/admin/clips/:id',
  adminClipFile: '/api/admin/clips/:id/:kind',
  adminUserLibraries: '/api/admin/user-libraries',
  adminLibraryDisabled: '/api/admin/libraries/:id/disabled',
  adminUploadBan: '/api/admin/users/:id/upload-ban',
  adminReportResolve: '/api/admin/reports/:id/resolve',
  myLibraries: '/api/my/libraries',
  myLibrary: '/api/my/libraries/:id',
  myLibraryClips: '/api/my/libraries/:id/clips',
  myClip: '/api/my/clips/:id',
  reportClip: '/api/clips/:id/report',
} as const;
