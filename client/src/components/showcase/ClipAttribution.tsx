import type { ClipInfo } from '@dub/shared';
import { Film } from 'lucide-react';
import { cn } from '@/lib/utils';

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** One line of clip credit: title, author, source and license (with links where known). */
export function ClipAttribution({ clip, className }: { clip: ClipInfo; className?: string }) {
  const a = clip.attribution;
  const link = 'text-zinc-300 underline-offset-4 hover:text-fuchsia-200 hover:underline';
  return (
    <p
      data-testid="clip-attribution"
      className={cn('flex items-start gap-2 text-xs leading-relaxed text-zinc-500', className)}
    >
      <Film className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="text-zinc-400">“{clip.title}”</span> by {a.author}
        {' · '}
        {isUrl(a.source) ? (
          <a className={link} href={a.source} target="_blank" rel="noreferrer">
            {a.source.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
          </a>
        ) : (
          a.source
        )}
        {' · '}
        {a.licenseUrl ? (
          <a className={link} href={a.licenseUrl} target="_blank" rel="noreferrer">
            {a.license}
          </a>
        ) : (
          a.license
        )}
      </span>
    </p>
  );
}

/** Plain-text credit, e.g. burnt into a rendered video. */
export function attributionText(clip: ClipInfo): string {
  const a = clip.attribution;
  return `“${clip.title}” · ${a.author} · ${a.license}`;
}
