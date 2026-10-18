import { LEGAL_ROUTE, type LegalPublic, type LegalResponse } from '@dub/shared';
import { useEffect, useState } from 'react';

/** `undefined` while loading, `null` when not configured (or unreachable). */
export function useLegal(): LegalPublic | null | undefined {
  const [legal, setLegal] = useState<LegalPublic | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(LEGAL_ROUTE, { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<LegalResponse>) : null))
      .then((r) => live && setLegal(r?.configured ? r.legal : null))
      .catch(() => live && setLegal(null));
    return () => {
      live = false;
    };
  }, []);
  return legal;
}

export function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
