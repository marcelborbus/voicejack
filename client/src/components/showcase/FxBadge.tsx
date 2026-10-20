import { fxEmojis, type ChunkRef } from '@dub/shared';
import { cn } from '@/lib/utils';

/**
 * #48: the voice effects this dub uses, as emojis only (names or counts could hint at who
 * made it). Static: no animation over the playing clip.
 */
export function FxBadge({
  chunks,
  className,
}: {
  chunks: readonly ChunkRef[];
  className?: string;
}) {
  const emojis = fxEmojis(chunks);
  if (emojis.length === 0) return null;
  return (
    <span
      data-testid="fx-badge"
      title="Voice effects in this dub"
      aria-label={`Voice effects: ${emojis.join(' ')}`}
      className={cn(
        'pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-2xl border-2 border-[#1a1027] bg-ink-900/90 px-2.5 py-1 text-sm shadow-[0_3px_0_rgb(0_0_0/0.5)]',
        className,
      )}
    >
      {emojis.join(' ')}
    </span>
  );
}
