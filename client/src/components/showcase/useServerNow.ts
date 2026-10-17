import { useEffect, useState } from 'react';
import { serverNow } from '@/state/session';

/** Server clock (epoch ms), re-rendering every `intervalMs` while `active`. */
export function useServerNow(intervalMs = 200, active = true): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
