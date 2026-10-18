import { LAST_GAME_PATH, type GameEloResult, type LastGameResponse } from '@dub/shared';

/** V09: your rating change from the latest public game in room `code` (null if none). */
export async function fetchLastGame(code: string): Promise<GameEloResult | null> {
  const r = await fetch(`${LAST_GAME_PATH}?room=${encodeURIComponent(code)}`, {
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as LastGameResponse).game;
}
