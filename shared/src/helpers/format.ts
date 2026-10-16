/**
 * `m:ss` (or `h:mm:ss` from one hour). Negative/NaN → `0:00`. `mode: 'ceil'` suits
 * countdowns (shows 0:01 until the last second is fully over).
 */
export function formatClock(ms: number, mode: 'floor' | 'ceil' = 'floor'): string {
  const totalS =
    Number.isFinite(ms) && ms > 0
      ? mode === 'ceil'
        ? Math.ceil(ms / 1000)
        : Math.floor(ms / 1000)
      : 0;
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
