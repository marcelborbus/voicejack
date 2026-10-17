import { Timer } from 'lucide-react';
import { useServerNow } from '@/components/showcase/useServerNow';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useSnapshot } from '@/state/room';

/** Public lobby (V08): the ready-check countdown instead of host controls. */
export function PublicLobbyPanel() {
  const snap = useSnapshot();
  const endsAt = snap?.public?.readyEndsAt ?? null;
  const now = useServerNow(250, endsAt !== null);
  if (!snap) return null;
  const humans = snap.players.filter((p) => !p.isBot);
  const ready = humans.filter((p) => p.ready && p.connected).length;
  const left = endsAt === null ? 0 : Math.max(0, endsAt - now);
  const secs = Math.ceil(left / 1000);
  return (
    <Card data-testid="public-lobby">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="tape text-sm">Random game</span>
          <span className="flex items-center gap-1.5 font-mono text-2xl font-bold tabular-nums">
            <Timer className="size-5 text-zinc-400" />
            <span data-testid="ready-countdown">
              {endsAt === null ? '–' : `0:${String(secs).padStart(2, '0')}`}
            </span>
          </span>
        </div>
        <Progress value={endsAt === null ? 0 : (left / 20_000) * 100} />
        <p className="text-sm text-zinc-300">
          <span className="tabular-nums" data-testid="ready-count">
            {ready}/{humans.length}
          </span>{' '}
          ready. Pass the mic check and ready up: the game starts when everyone is ready, or when
          time is up with at least 2. Anyone not ready goes back to the queue.
        </p>
        <p className="text-xs text-zinc-500">Normal mode · 3 rounds · official clips</p>
      </CardContent>
    </Card>
  );
}
