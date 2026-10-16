import { ROOM_CODE_REGEX } from '@dub/shared';

// localStorage can throw (private mode, blocked storage); every access is guarded.
function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const tokenKey = (code: string) => `dub.token.${code}`;
export const getToken = (code: string) => get(tokenKey(code));
export const setToken = (code: string, token: string | null) => set(tokenKey(code), token);

export const getSavedName = () => get('dub.name') ?? '';
export const saveName = (name: string) => set('dub.name', name);

/** Normalizes user input like " ab-cd ef" or a pasted invite URL into a room code, or null. */
export function normalizeRoomCode(input: string): string | null {
  const fromUrl = /\/r\/([A-Za-z0-9]{6})(?:[/?#]|$)/.exec(input)?.[1];
  const raw = (fromUrl ?? input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOM_CODE_REGEX.test(raw) ? raw : null;
}
