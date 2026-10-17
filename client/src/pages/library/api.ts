import {
  libraryPaths,
  type AdminClip,
  type AdminLibrary,
  type CreateLibraryBody,
  type LibrariesResponse,
  type LibrarySummary,
  type MyClipsResponse,
  type MyLibrariesResponse,
  type UpdateClipBody,
  type UpdateLibraryBody,
  type UploadMyClipQuery,
} from '@dub/shared';
import { AdminError, uploadTo } from '@/admin/api';

/** V06 `/api/my/*` client (registered users' private clip libraries). */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    throw new AdminError('Could not reach the server.', 0);
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    throw new AdminError(
      (body as { message?: string } | null)?.message ?? res.statusText,
      res.status,
    );
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const myApi = {
  libraries: () => call<MyLibrariesResponse>(libraryPaths.myLibraries()),
  createLibrary: (body: CreateLibraryBody) =>
    call<{ library: AdminLibrary }>(libraryPaths.myLibraries(), json('POST', body)),
  updateLibrary: (id: string, body: UpdateLibraryBody) =>
    call<{ library: AdminLibrary }>(libraryPaths.myLibrary(id), json('PATCH', body)),
  deleteLibrary: (id: string) => call<void>(libraryPaths.myLibrary(id), json('DELETE')),
  clips: (id: string) =>
    call<MyClipsResponse>(libraryPaths.myLibraryClips(id)).then((r) => r.clips),
  updateClip: (id: string, body: UpdateClipBody) =>
    call<{ clip: AdminClip }>(libraryPaths.myClip(id), json('PATCH', body)),
  deleteClip: (id: string) => call<void>(libraryPaths.myClip(id), json('DELETE')),
  reportClip: (id: string, reason: string) =>
    call<{ id: number }>(libraryPaths.reportClip(id), json('POST', { reason })),
};

export function uploadMyClip(
  libraryId: string,
  file: File,
  meta: UploadMyClipQuery,
  onProgress: (fraction: number) => void,
) {
  return uploadTo(libraryPaths.myLibraryClips(libraryId), file, meta, onProgress);
}

let official: Promise<LibrarySummary[]> | null = null;
/** Official libraries (cached; anything else in a room is a host's private library). */
export function officialLibraries(): Promise<LibrarySummary[]> {
  official ??= fetch(libraryPaths.libraries(), { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<LibrariesResponse>) : { libraries: [] }))
    .then((r) => r.libraries.filter((l) => l.visibility === 'official'))
    .catch(() => {
      official = null;
      return [];
    });
  return official;
}
