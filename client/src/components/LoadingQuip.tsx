import { useEffect, useState } from 'react';
import { MicJack } from '@/components/doodles';
import { cn } from '@/lib/utils';

const QUIPS = [
  'Untangling the cables…',
  'Warming up the vocal cords…',
  'Bribing the sound guy…',
  'Finding the jack…',
  'Tapping the mic. Is this thing on?',
  'Clearing our throats…',
];

/** Loading state with personality: a bobbing doodle mic and a rotating quip. */
export function LoadingQuip({
  title,
  className,
  testId,
}: {
  /** Fixed first line (e.g. "Joining the party…"); quips rotate underneath. */
  title?: string;
  className?: string;
  testId?: string;
}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * QUIPS.length));
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % QUIPS.length), 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex animate-fade-in flex-col items-center justify-center gap-3 text-center',
        className,
      )}
    >
      <MicJack className="size-16 animate-bob text-fuchsia-300" />
      {title && <p className="font-display text-xl font-bold text-zinc-100">{title}</p>}
      <p key={i} className="animate-fade-in font-scribble text-xl text-zinc-400">
        {QUIPS[i]}
      </p>
    </div>
  );
}
