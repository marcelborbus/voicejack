import type { PlayerPublic } from '@dub/shared';
import { Check, Hand } from 'lucide-react';
import { MicCheck } from '@/components/MicCheck';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { send } from '@/state/session';

/** Your own setup: mic check, then the ready toggle (disabled until the server has micOk). */
export function ReadyPanel({ me }: { me: PlayerPublic }) {
  const ready = me.ready;
  return (
    <Card
      className={cn('transition-shadow duration-500', ready && 'shadow-emerald-500/10')}
      data-testid="ready-panel"
    >
      <CardContent className="flex flex-col gap-5">
        <MicCheck />
        <Separator />
        <Button
          size="xl"
          variant={ready ? 'success' : 'default'}
          data-testid="ready-toggle"
          aria-pressed={ready}
          disabled={!me.micOk}
          onClick={() => send({ t: 'setReady', ready: !ready })}
        >
          {ready ? <Check className="animate-pop" strokeWidth={3} /> : <Hand />}
          {ready ? "I'm ready!" : 'Ready up'}
        </Button>
        <p className="-mt-2 text-center text-xs text-zinc-500">
          {!me.micOk
            ? 'Pass the mic check first.'
            : ready
              ? 'Tap again if you need a moment.'
              : 'Tap when you are good to go.'}
        </p>
      </CardContent>
    </Card>
  );
}
