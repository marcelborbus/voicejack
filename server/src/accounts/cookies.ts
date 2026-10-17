/** Minimal cookie helpers (one cookie, no dependency). */

export const SESSION_COOKIE = 'vj_session';

/** Value of cookie `name` in a `Cookie:` header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
