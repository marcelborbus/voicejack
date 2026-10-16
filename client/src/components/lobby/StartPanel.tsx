import type { PlayerPublic } from '@dub/shared';
import { Hourglass, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { send } from '@/state/session';

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function StartPanel({
  isHost,
  canStart,
  blockers,
  players,
  hostName,
}: {
  isHost: boolean;
  canStart: boolean;
  blockers: string[];
  players: PlayerPublic[];
  hostName: string;
}) {
  const readyCount = players.filter((p) => p.ready && p.connected).length;
  const total = players.length;

  if (!isHost) {
    return (
      <div
        className="flex items-center justify-center gap-3 rounded-3xl border border-dashed border-white/10 px-5 py-5 text-zinc-400"
        data-testid="waiting-for-host"
      >
        <Hourglass className="size-5 animate-[spin_3s_linear_infinite] text-orange-300" />
        <span>
          Waiting for <span className="font-semibold text-zinc-200">{hostName}</span> to start ·{' '}
          <span className="tabular-nums">
            {readyCount}/{total}
          </span>{' '}
          ready
        </span>
      </div>
    );
  }

  const button = (
    <Button
      size="xl"
      className="w-full"
      data-testid="start-game"
      disabled={!canStart}
      onClick={() => send({ t: 'startGame' })}
    >
      <Play className="fill-current" /> Start game
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {canStart ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span wrapper: disabled buttons don't fire pointer events */}
            <span tabIndex={0} className="block rounded-3xl">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <ul className="list-disc space-y-0.5 pl-4">
              {blockers.map((b) => (
                <li key={b}>{capitalize(b)}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-zinc-400" data-testid="start-blockers">
          {canStart
            ? 'Everyone is ready. Lights, camera…'
            : blockers.length > 0
              ? capitalize(blockers[0]!)
              : ''}
          {blockers.length > 1 && (
            <span className="text-zinc-500"> (+{blockers.length - 1} more)</span>
          )}
        </span>
        <span className="shrink-0 tabular-nums text-zinc-500">
          {readyCount}/{total} ready
        </span>
      </div>
    </div>
  );
}
