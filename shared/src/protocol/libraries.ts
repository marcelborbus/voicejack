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
} as const;
