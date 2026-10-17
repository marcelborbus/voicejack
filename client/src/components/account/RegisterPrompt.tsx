import { Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMe } from '@/state/me';
import { SignInDialog } from './SignInDialog';

/**
 * Post-game nudge for guests ("register to keep your rating"). Renders nothing for registered
 * users. V09 places it (e.g. on Final after a public game); it is not mounted anywhere yet.
 */
export function RegisterPrompt({
  className,
  title = 'Keep your rating',
  text = 'Guests lose their rating when the browser forgets them. Add your email to keep it on any device.',
}: {
  className?: string;
  title?: string;
  text?: string;
}) {
  const kind = useMe((s) => s.user?.kind);
  if (kind !== 'guest') return null;
  return (
    <div
      data-testid="register-prompt"
      className={cn(
        'flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-fuchsia-400/25 bg-fuchsia-500/[0.06] p-5 sm:flex-row sm:items-center',
        className,
      )}
    >
      <Trophy className="size-8 shrink-0 text-amber-300" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg font-bold">{title}</p>
        <p className="text-sm text-zinc-400">{text}</p>
      </div>
      <SignInDialog
        title="Keep your rating"
        trigger={<Button size="sm">Register</Button>}
      />
    </div>
  );
}
