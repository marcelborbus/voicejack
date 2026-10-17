import { MAX_BOTS, type PlayerPublic } from '@dub/shared';
import { Bot, Minus, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { send } from '@/state/session';

/** 🤖 badge on a bot's player card (V01). */
export function BotBadge() {
  return (
    <Badge variant="accent" data-testid="bot-badge" title="Server-side test bot">
      <span aria-hidden>🤖</span> bot
    </Badge>
  );
}

/**
 * Host-only dev test mode (V01): add/remove server-side bots. Rendered only when the server
 * allows it (`you.canManageBots`: DEV_BOTS=1, later admins).
 */
export function BotControls({
  players,
  maxPlayers,
}: {
  players: readonly PlayerPublic[];
  maxPlayers: number;
}) {
  const bots = players.filter((p) => p.isBot).length;
  const canAdd = bots < MAX_BOTS && players.length < maxPlayers;
  return (
    <Card data-testid="bot-controls">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl sm:text-xl">
          <Bot className="size-5 text-fuchsia-300" /> Test bots
        </CardTitle>
        <p className="text-xs text-zinc-500">
          Dev mode: bots ready up, dub with clip snippets and vote randomly. No voice.
        </p>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          data-testid="remove-bot"
          disabled={bots === 0}
          onClick={() => send({ t: 'removeBot' })}
        >
          <Minus /> Remove bot
        </Button>
        <span className="min-w-12 text-center text-sm tabular-nums text-zinc-300" data-testid="bot-count">
          {bots}/{MAX_BOTS}
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-testid="add-bot"
          disabled={!canAdd}
          onClick={() => send({ t: 'addBot' })}
        >
          <Plus /> Add bot
        </Button>
      </CardContent>
    </Card>
  );
}
