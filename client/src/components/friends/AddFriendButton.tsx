import { Check, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { useRoomStore } from '@/state/room';
import { friendsApi, FriendsApiError } from './api';
import { loadRoomRelations, refreshFriends, useFriends, useIsRegistered } from './store';

/**
 * "Add friend" next to a room player (results / final lists). Shows only for other registered
 * humans: the server says which (`GET /api/friends/room/:code`, keyed by playerId, no user ids).
 */
export function AddFriendButton({ playerId }: { playerId: string }) {
  const registered = useIsRegistered();
  const code = useRoomStore((s) => s.snapshot?.code ?? null);
  const playerCount = useRoomStore((s) => s.snapshot?.players.length ?? 0);
  const rel = useFriends((s) => (s.room.code === code ? s.room.players[playerId] : undefined));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (registered && code) void loadRoomRelations(code);
    // One fetch per room/player count, shared by every button (they all dedupe on this key).
  }, [registered, code, playerCount]);

  if (!registered || !code || !rel) return null;
  if (rel === 'friend') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-emerald-300"
        data-testid="is-friend"
      >
        <Check className="size-3.5" /> Friends
      </span>
    );
  }
  if (rel === 'outgoing') return <span className="text-xs text-zinc-500">Requested</span>;
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="add-friend"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await friendsApi.addFromRoom(code, playerId);
          if (r.result === 'accepted')
            toast("You're friends now", { variant: 'success', durationMs: 2500 });
        } catch (e) {
          toast(e instanceof FriendsApiError ? e.message : 'Could not send the request', {
            variant: 'warning',
          });
        } finally {
          setBusy(false);
          void loadRoomRelations(code);
          void refreshFriends();
        }
      }}
    >
      <UserPlus /> {rel === 'incoming' ? 'Accept' : 'Add friend'}
    </Button>
  );
}
