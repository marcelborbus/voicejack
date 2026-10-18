import { LIBRARY_CLIP_MAX_SECONDS } from '@dub/shared';

/**
 * Trim window of a clip upload (#42), in seconds of the source video. The form keeps the raw
 * field text; the upload sends `ss` = start and `t` = end − start (the server clamps `t` to
 * LIBRARY_CLIP_MAX_SECONDS and to the end of the video).
 */
export interface TrimFields {
  start: string;
  /** '' = not set: up to LIBRARY_CLIP_MAX_SECONDS from the start. */
  end: string;
}

export const TRIM_MAX = LIBRARY_CLIP_MAX_SECONDS;
export const TRIM_MIN = 1;

export const INITIAL_TRIM: TrimFields = { start: '0', end: '' };

const round1 = (n: number) => Math.round(n * 10) / 10;
const str = (n: number) => String(round1(n));
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

export interface TrimUpdate {
  fields: TrimFields;
  /** What else moved (or why nothing did), shown next to the buttons. */
  note: string | null;
}

/** Once the preview knows its duration: an unset end becomes min(start + max, duration). */
export function withDuration(f: TrimFields, duration: number): TrimFields {
  if (f.end !== '' || !(duration > 0)) return f;
  const start = num(f.start);
  const s = Number.isFinite(start) ? start : 0;
  return { ...f, end: str(Math.min(s + TRIM_MAX, duration)) };
}

/** "Start here" at `at`; the end follows when the window would be empty or too long. */
export function markStart(f: TrimFields, at: number, duration?: number): TrimUpdate {
  let start = round1(Math.max(0, at));
  if (duration && duration > 0) start = Math.min(start, round1(Math.max(0, duration - TRIM_MIN)));
  const end = num(f.end);
  const limit = duration && duration > 0 ? duration : Infinity;
  if (Number.isFinite(end) && end - start >= TRIM_MIN && end - start <= TRIM_MAX) {
    return { fields: { start: str(start), end: f.end }, note: null };
  }
  if (!Number.isFinite(end) && f.end === '') {
    return { fields: { start: str(start), end: '' }, note: null };
  }
  const newEnd = round1(Math.min(start + TRIM_MAX, limit));
  return {
    fields: { start: str(start), end: str(newEnd) },
    note: `End moved to ${str(newEnd)} s (clips are ${TRIM_MIN}–${TRIM_MAX} s long).`,
  };
}

/** "End here" at `at`: must be after the start; a window over the max pulls the start along. */
export function markEnd(f: TrimFields, at: number): TrimUpdate {
  const end = round1(Math.max(0, at));
  const s = num(f.start);
  const start = Number.isFinite(s) ? s : 0;
  if (end - start < TRIM_MIN) {
    return {
      fields: f,
      note: `The end has to be at least ${TRIM_MIN} s after the start (${str(start)} s).`,
    };
  }
  if (end - start > TRIM_MAX) {
    const newStart = round1(end - TRIM_MAX);
    return {
      fields: { start: str(newStart), end: str(end) },
      note: `Start moved to ${str(newStart)} s: clips are at most ${TRIM_MAX} s long.`,
    };
  }
  return { fields: { start: f.start, end: str(end) }, note: null };
}

/** Why the typed window can't be uploaded, or null. */
export function trimError(f: TrimFields): string | null {
  const start = num(f.start);
  if (!(start >= 0)) return 'Start must be a number of seconds (0 or more).';
  if (f.end.trim() === '') return null;
  const end = num(f.end);
  if (!Number.isFinite(end)) return 'End must be a number of seconds.';
  if (end - start < TRIM_MIN) return `End must be at least ${TRIM_MIN} s after the start.`;
  if (end - start > TRIM_MAX + 1e-9) return `Clips are at most ${TRIM_MAX} s long.`;
  return null;
}

/** Length shown under the fields (null while the end is unset or invalid). */
export function trimLength(f: TrimFields): number | null {
  const start = num(f.start);
  const end = num(f.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? round1(end - start) : null;
}

/** Upload query params (`t` omitted while the end is unset). */
export function trimQuery(f: TrimFields): { ss: number; t?: number } {
  const ss = round1(num(f.start) || 0);
  const len = trimLength(f);
  return len === null ? { ss } : { ss, t: Math.min(len, TRIM_MAX) };
}
