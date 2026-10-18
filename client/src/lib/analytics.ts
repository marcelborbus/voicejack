import {
  TRACK_PATH,
  type ErrorSource,
  type FeedbackContext,
  type Phase,
  type TrackBody,
  type TrackRoute,
} from '@dub/shared';

/**
 * V15 first-party analytics (#39). Sends only allow-listed, aggregate events to our own
 * `POST /api/t`: the route *name* of a page view, a hash of a client error message, and
 * feedback. No cookies, no localStorage/sessionStorage, no ids, no third-party scripts. Recent
 * error hashes live in memory only (attached to a bug report so we can match it to errors).
 */

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** `/r/ABC123` → `room`: never the code, never query strings. */
export function routeName(pathname: string): TrackRoute {
  if (pathname === '/' || pathname === '') return 'home';
  if (/^\/r\//.test(pathname)) return 'room';
  if (/^\/admin(\/|$)/.test(pathname)) return 'admin';
  const m = /^\/(library|impressum|datenschutz|takedown)\/?$/.exec(pathname);
  if (m) return m[1] as TrackRoute;
  return 'not_found';
}

function post(body: TrackBody): void {
  try {
    void fetch(TRACK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit', // no cookie for analytics
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let analytics break the app */
  }
}

let lastView: string | null = null;

/** Called on every route change (Shell). Consecutive views of the same path count once. */
export function trackPageView(pathname: string): void {
  if (pathname === lastView) return;
  lastView = pathname;
  post({ e: 'page_view', route: routeName(pathname) });
}

// ---------------------------------------------------------------- client errors

/**
 * Strips what makes messages unique or personal (URLs, numbers, quoted strings, room codes),
 * so equal errors hash equal and nothing personal is hashed.
 */
export function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\b[A-Z0-9]{6}\b/g, '<code>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** FNV-1a 32-bit as 8 hex chars. */
export function hashMessage(msg: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < msg.length; i++) {
    h ^= msg.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const RECENT_MAX = 10;
const REPORT_EVERY_MS = 60_000;
/** Newest last. In memory only. */
const recent: string[] = [];
const pending = new Map<string, { where: ErrorSource; route: TrackRoute; n: number }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlushAt = 0;

export function recentErrorHashes(): string[] {
  return [...recent];
}

function flushErrors(): void {
  flushTimer = null;
  lastFlushAt = Date.now();
  for (const [hash, p] of pending) {
    post({ e: 'client_error', hash, where: p.where, route: p.route, n: Math.min(50, p.n) });
  }
  pending.clear();
}

export function reportError(err: unknown, where: ErrorSource): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : 'non-error thrown';
  const hash = hashMessage(normalizeErrorMessage(raw));
  const i = recent.indexOf(hash);
  if (i >= 0) recent.splice(i, 1);
  recent.push(hash);
  if (recent.length > RECENT_MAX) recent.shift();
  const route = routeName(location.pathname);
  const p = pending.get(hash);
  if (p) p.n++;
  else pending.set(hash, { where, route, n: 1 });
  // Batched: at most one report per minute (a burst of the same error becomes one `n`).
  flushTimer ??= setTimeout(
    flushErrors,
    Math.max(2000, lastFlushAt + REPORT_EVERY_MS - Date.now()),
  );
  // Lets a developer match the hash in the dashboard to a console message.
  console.info(`[vj] error ${hash}`);
  return hash;
}

let installed = false;
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    // Resource load errors (img/video) have no `error`; skip them.
    if (!ev.error && !ev.message) return;
    reportError(ev.error ?? ev.message, 'error');
  });
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'rejection'));
}

// ---------------------------------------------------------------- feedback

export function sendFeedback(f: {
  kind: 'mood' | 'bug';
  mood?: number;
  comment?: string;
  phase?: Phase;
}): void {
  const context: FeedbackContext = {
    route: routeName(location.pathname),
    version: APP_VERSION,
    errors: recentErrorHashes(),
    ...(f.phase && { phase: f.phase }),
  };
  const comment = f.comment?.trim();
  post({
    e: 'feedback',
    kind: f.kind,
    ...(f.mood !== undefined && { mood: f.mood }),
    ...(comment && { comment }),
    context,
  });
}
