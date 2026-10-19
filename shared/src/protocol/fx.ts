import { z } from 'zod';

/**
 * #48 voice effects. The allow-list of effect ids a chunk may carry (`ChunkMeta.fx`). The id is
 * all that travels: the client renders the effect locally (WebAudio, `client/src/dub/fx`), so
 * the server only checks the id. Emojis/names live here so the editor, the showcase badge and
 * the bots agree on one list.
 */
export const FX_IDS = [
  'trashmic',
  'robot',
  'canyon',
  'gospel',
  'helium',
  'demon',
  'radio',
  'phone',
  'megaphone',
  'underwater',
  'alien',
  'ghost',
  'stadium',
  'tipsy',
  'chiptune',
  'walkie',
] as const;

/** A real effect (`'none'` = dry). */
export type FxEffectId = (typeof FX_IDS)[number];
export type FxId = FxEffectId | 'none';

export const FxIdSchema = z.enum(['none', ...FX_IDS]);

export const FX_INFO: Readonly<Record<FxId, { emoji: string; name: string }>> = {
  none: { emoji: '🎙️', name: 'No effect' },
  trashmic: { emoji: '🎤', name: 'Trashy mic' },
  robot: { emoji: '🤖', name: 'Robot' },
  canyon: { emoji: '🏔️', name: 'Echo canyon' },
  gospel: { emoji: '🙌', name: 'Gospel choir' },
  helium: { emoji: '🎈', name: 'Helium' },
  demon: { emoji: '😈', name: 'Demon' },
  radio: { emoji: '📻', name: '1940s radio' },
  phone: { emoji: '📞', name: 'Telephone' },
  megaphone: { emoji: '📣', name: 'Megaphone' },
  underwater: { emoji: '🐟', name: 'Underwater' },
  alien: { emoji: '👽', name: 'Alien' },
  ghost: { emoji: '👻', name: 'Ghost' },
  stadium: { emoji: '🏟️', name: 'Stadium announcer' },
  tipsy: { emoji: '🍺', name: 'Tipsy' },
  chiptune: { emoji: '🎮', name: '8-bit' },
  walkie: { emoji: '📟', name: 'Walkie-talkie' },
};

const FX_SET: ReadonlySet<string> = new Set<string>(['none', ...FX_IDS]);

export function isFxId(v: unknown): v is FxId {
  return typeof v === 'string' && FX_SET.has(v);
}

/** The chunk's effect, `'none'` when absent (old manifests) or unknown. */
export function fxOf(c: { fx?: string | undefined }): FxId {
  return isFxId(c.fx) ? c.fx : 'none';
}

/** Distinct effect emojis used by a dub, in first-use order (`'none'` left out). Emoji only, so
 * the showcase badge says nothing about who dubbed it. */
export function fxEmojis(chunks: readonly { fx?: string | undefined }[]): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    const fx = fxOf(c);
    if (fx === 'none') continue;
    const e = FX_INFO[fx].emoji;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
