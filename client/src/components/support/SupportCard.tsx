import { ChevronDown, Heart } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Sparkle } from '@/components/doodles';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  DONATE_URL,
  formatEur,
  markSupportShown,
  supportShownThisSession,
  useCosts,
  type Costs,
} from './costs';

/** Final screen: the card appears once the winner celebration (confetti, 6.5 s) is over. */
export const SUPPORT_DELAY_MS = 7000;

/** Plain link to Liberapay: no third-party script, no tracking (#34). */
function DonateLink({ className, size }: { className?: string; size?: 'sm' | 'default' }) {
  return (
    <Button asChild size={size} className={className}>
      <a href={DONATE_URL} target="_blank" rel="noopener noreferrer" data-testid="support-donate">
        <Heart /> Chip in
      </a>
    </Button>
  );
}

function costLine(costs: Costs | null | undefined): string {
  if (!costs) return 'Keeping it online costs real money every month.';
  return `It costs about ${formatEur(costs.monthlyEur)}/month to keep it up for ~${costs.players} players at once.`;
}

/** The friendly, non-pushy pitch. */
export function SupportCard({
  costs,
  onDismiss,
  className,
}: {
  costs: Costs | null | undefined;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <Card className={className} data-testid="support-card">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative hidden shrink-0 sm:block" aria-hidden>
          <div className="grid size-14 place-items-center rounded-2xl bg-ink-850">
            <Heart className="size-7 fill-rose-500/80 text-rose-400" />
          </div>
          <Sparkle className="absolute -right-2 -top-2 size-5 text-sun" />
        </div>
        <div className="min-w-0 flex-1 text-sm text-zinc-300">
          <p className="font-display text-lg font-bold text-zinc-50">Enjoyed the show?</p>
          <p>Voicejack is made by one dev and runs on a tiny server. {costLine(costs)} Chip in?</p>
          <p className="mt-1 text-xs text-zinc-500">
            Totally optional. Opens Liberapay in a new tab; nothing is loaded from them here.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <DonateLink />
          {onDismiss && (
            <Button variant="ghost" onClick={onDismiss} data-testid="support-dismiss">
              Maybe later
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Final screen mount. Shows at most once per browser session, and only after the celebration,
 * below the results (never on top of them).
 */
export function SupportPrompt({ delayMs = SUPPORT_DELAY_MS }: { delayMs?: number }) {
  // Decided once on mount: a second game in the same session never shows it again.
  const [eligible] = useState(() => !supportShownThisSession());
  const [visible, setVisible] = useState(false);
  const costs = useCosts(eligible);
  useEffect(() => {
    if (!eligible) return;
    const t = setTimeout(() => {
      markSupportShown();
      setVisible(true);
    }, delayMs);
    return () => clearTimeout(t);
  }, [eligible, delayMs]);
  if (!visible) return null;
  return (
    <SupportCard costs={costs} onDismiss={() => setVisible(false)} className="animate-fade-up" />
  );
}

/** Home page footer area: subtle and collapsed by default. */
export function HomeSupport({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const costs = useCosts(open);
  return (
    <div className={cn('w-full', className)} data-testid="home-support">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300"
        data-testid="home-support-toggle"
      >
        <Heart className="size-3.5" /> Keep Voicejack on air
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <SupportCard costs={costs} className="mt-3 animate-fade-up" />}
    </div>
  );
}

/** Small footer link (every page). */
export function SupportLink() {
  return (
    <a
      href={DONATE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:text-zinc-200"
      data-testid="support-link"
    >
      <Heart className="size-3.5" /> Support
    </a>
  );
}
