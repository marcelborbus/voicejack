/**
 * V11 support prompt data. `/costs.json` is fetched at runtime (not bundled), so the owner can
 * change the numbers without a rebuild: in prod the server prefers `COSTS_PATH`
 * (`/app/data/costs.json`) and falls back to the copy shipped from `client/public/`.
 */
import { useEffect, useState } from 'react';

export const DONATE_URL = 'https://liberapay.com/marcel.borbus/donate';

export interface Costs {
  monthlyEur: number;
  players: number;
  updated?: string;
}

/** Validates the JSON body; anything odd → null (the card then shows copy without numbers). */
export function parseCosts(raw: unknown): Costs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!ok(r.monthlyEur) || !ok(r.players)) return null;
  return {
    monthlyEur: r.monthlyEur,
    players: Math.round(r.players),
    ...(typeof r.updated === 'string' ? { updated: r.updated } : {}),
  };
}

/** "€5" / "€3.49" */
export function formatEur(n: number): string {
  return `€${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

let cached: Promise<Costs | null> | null = null;

export function fetchCosts(): Promise<Costs | null> {
  cached ??= fetch('/costs.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseCosts)
    .catch(() => null);
  return cached;
}

/** `undefined` while loading, `null` when unavailable. */
export function useCosts(enabled = true): Costs | null | undefined {
  const [costs, setCosts] = useState<Costs | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchCosts().then((c) => live && setCosts(c));
    return () => {
      live = false;
    };
  }, [enabled]);
  return costs;
}

// "At most once per session": sessionStorage, guarded (private mode / blocked storage).
const SHOWN_KEY = 'vj.supportShown';
let shownInMemory = false;

export function supportShownThisSession(): boolean {
  if (shownInMemory) return true;
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markSupportShown(): void {
  shownInMemory = true;
  try {
    sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    /* in-memory only */
  }
}
