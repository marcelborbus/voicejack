import {
  libraryPaths,
  type AdminClip,
  type AdminClipsResponse,
  type AdminLibrariesResponse,
  type AdminLibrary,
  type AdminMeResponse,
  type CreateLibraryBody,
  type UpdateClipBody,
  type UpdateLibraryBody,
  type UploadClipQuery,
  type UploadClipResponse,
} from '@dub/shared';

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    // An expired Authelia session redirects to the login portal (cross-origin → fetch fails).
    throw new AdminError('Could not reach the server. Your login may have expired: reload.', 0);
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message ?? res.statusText;
    throw new AdminError(msg, res.status);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const adminApi = {
  me: () => call<AdminMeResponse>(libraryPaths.adminMe()),
  libraries: () =>
    call<AdminLibrariesResponse>(libraryPaths.adminLibraries()).then((r) => r.libraries),
  createLibrary: (body: CreateLibraryBody) =>
    call<{ library: AdminLibrary }>(libraryPaths.adminLibraries(), json('POST', body)),
  updateLibrary: (id: string, body: UpdateLibraryBody) =>
    call<{ library: AdminLibrary }>(libraryPaths.adminLibrary(id), json('PATCH', body)),
  deleteLibrary: (id: string) => call<void>(libraryPaths.adminLibrary(id), json('DELETE')),
  setDefault: (id: string) =>
    call<{ library: AdminLibrary }>(libraryPaths.adminLibraryDefault(id), json('POST')),
  clips: (libraryId: string) =>
    call<AdminClipsResponse>(libraryPaths.adminLibraryClips(libraryId)).then((r) => r.clips),
  updateClip: (id: string, body: UpdateClipBody) =>
    call<{ clip: AdminClip }>(libraryPaths.adminClip(id), json('PATCH', body)),
  deleteClip: (id: string) => call<void>(libraryPaths.adminClip(id), json('DELETE')),
};

/** Raw-body upload with progress (fetch has no upload progress). Resolves with the new clip. */
export function uploadClip(
  libraryId: string,
  file: File,
  meta: UploadClipQuery,
  onProgress: (fraction: number) => void,
): { promise: Promise<AdminClip>; abort: () => void } {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const xhr = new XMLHttpRequest();
  const promise = new Promise<AdminClip>((resolve, reject) => {
    xhr.open('POST', `${libraryPaths.adminLibraryClips(libraryId)}?${qs}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { clip?: AdminClip; message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.clip) resolve(body.clip);
      else reject(new AdminError(body.message ?? `upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new AdminError('upload failed (network)', 0));
    xhr.onabort = () => reject(new AdminError('upload cancelled', 0));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
