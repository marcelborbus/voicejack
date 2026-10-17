/** Fun names for dev/test bots (V01). All ≤ 20 chars so `uniqueName` suffixes still fit. */
export const BOT_NAMES = [
  'Robo Bogart',
  'Dub Vader',
  'Lip Syncbot',
  'Mumbletron',
  'Voxel Streep',
  'Beep Brando',
  'Clank Hanks',
  'Botney Spears',
  'R2-Dub2',
  'Marlon Botdo',
  'Humphrey Bot',
  'Glitch Eastwood',
  'Audio Hepburn',
  'Tin Can Cage',
  'Sir Squeaks-a-Lot',
  'Captain Kazoo',
] as const;

/** Random name not in `taken`; falls back to any name (the room adds a number suffix). */
export function pickBotName(taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  const pool = free.length > 0 ? free : BOT_NAMES;
  return pool[Math.floor(rng() * pool.length)]!;
}
