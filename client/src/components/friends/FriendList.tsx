import { Ban, Check, DoorOpen, MessageCircle, UserMinus, X } from 'lucide-react';
import { useState } from 'react';
import type { FriendInfo, FriendRefInfo, FriendStatus } from '@dub/shared';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/state/room';
import { friendsApi, FriendsApiError } from './api';
import { openChat, refreshFriends, useFriends } from './store';

export const STATUS_LABEL: Record<FriendStatus, string> = {
  online: 'Online',
  inGame: 'In a game',
  offline: 'Offline',
};

export function StatusDot({ status, className }: { status: FriendStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2.5 rounded-full ring-2 ring-ink-900',
        status === 'online' && 'bg-emerald-400',
        status === 'inGame' && 'bg-amber-400',
        status === 'offline' && 'bg-zinc-600',
        className,
      )}
    />
  );
}

/** Runs a friends call, toasts the error, refreshes the lists either way. */
async function act(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  try {
    await fn();
    if (ok) toast(ok, { variant: 'success', durationMs: 2500 });
    return true;
  } catch (e) {
    toast(e instanceof FriendsApiError ? e.message : 'Something went wrong', {
      variant: 'warning',
    });
    return false;
  } finally {
    void refreshFriends();
  }
}

/** The room code you could invite to: you host a private room that is still in the lobby. */
function useInviteCode(): string | null {
  return useRoomStore((s) => {
    const snap = s.snapshot;
    if (!snap || snap.phase !== 'LOBBY' || snap.hostId !== snap.you.playerId) return null;
    if ((snap as { kind?: string }).kind === 'public') return null;
    return snap.code;
  });
}

function FriendRow({ f }: { f: FriendInfo }) {
  const inviteCode = useInviteCode();
  const [menu, setMenu] = useState(false);
  return (
    <li className="flex flex-col gap-2 rounded-2xl bg-ink-850 px-3 py-2.5" data-testid="friend-row">
      <div className="flex items-center gap-3">
        <span className="relative">
          <PlayerAvatar name={f.name} size="sm" dimmed={f.status === 'offline'} />
          <StatusDot status={f.status} className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{f.name}</span>
          <span className="text-xs text-zinc-400">{STATUS_LABEL[f.status]}</span>
        </span>
        {inviteCode && f.status !== 'offline' && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="invite-friend"
            onClick={() =>
              void act(() => friendsApi.invite(f.userId, inviteCode), `Invited ${f.name}`)
            }
          >
            <DoorOpen /> Invite
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Chat with ${f.name}`}
          className="relative"
          onClick={() => void openChat(f.userId)}
        >
          <MessageCircle />
          {f.unread > 0 && (
            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-fuchsia-500 px-1 text-[10px] font-bold leading-4 text-white">
              {f.unread > 9 ? '9+' : f.unread}
            </span>
          )}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="More"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <span className="text-lg leading-none">⋯</span>
        </Button>
      </div>
      {menu && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Remove ${f.name} from your friends?`))
                void act(() => friendsApi.remove(f.userId));
            }}
          >
            <UserMinus /> Remove
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-300"
            onClick={() => {
              if (confirm(`Block ${f.name}? They can't message, invite or add you.`))
                void act(() => friendsApi.block(f.userId), `Blocked ${f.name}`);
            }}
          >
            <Ban /> Block
          </Button>
        </div>
      )}
    </li>
  );
}

function RequestRow({ r, incoming }: { r: FriendRefInfo; incoming: boolean }) {
  return (
    <li
      className="flex items-center gap-3 rounded-2xl bg-ink-850 px-3 py-2"
      data-testid="friend-request"
    >
      <PlayerAvatar name={r.name} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{r.name}</span>
        <span className="text-xs text-zinc-400">
          {incoming ? 'wants to be friends' : 'request sent'}
        </span>
      </span>
      {incoming ? (
        <>
          <Button
            size="icon-sm"
            variant="success"
            aria-label="Accept"
            onClick={() => void act(() => friendsApi.request(r.ref, 'accept'))}
          >
            <Check />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Decline"
            onClick={() => void act(() => friendsApi.request(r.ref, 'decline'))}
          >
            <X />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Block"
            className="text-rose-300"
            onClick={() => {
              if (confirm(`Block ${r.name}?`)) void act(() => friendsApi.request(r.ref, 'block'));
            }}
          >
            <Ban />
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void act(() => friendsApi.request(r.ref, 'cancel'))}
        >
          Cancel
        </Button>
      )}
    </li>
  );
}

/** Requests, friends (with live status) and blocked users. Shared by the home panel and dock. */
export function FriendList({ compact = false }: { compact?: boolean }) {
  const data = useFriends((s) => s.data);
  const [showBlocked, setShowBlocked] = useState(false);
  if (!data) return <p className="text-sm text-zinc-500">Loading friends…</p>;
  const { friends, incoming, outgoing, blocked } = data;
  return (
    <div className="flex flex-col gap-4" data-testid="friend-list">
      {incoming.length > 0 && (
        <ul className="flex flex-col gap-2">
          {incoming.map((r) => (
            <RequestRow key={r.ref} r={r} incoming />
          ))}
        </ul>
      )}
      {friends.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {friends.map((f) => (
            <FriendRow key={f.userId} f={f} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">
          No friends yet. After a game, hit{' '}
          <span className="font-semibold text-zinc-200">Add friend</span> next to someone who has an
          account.
        </p>
      )}
      {!compact && outgoing.length > 0 && (
        <ul className="flex flex-col gap-2">
          {outgoing.map((r) => (
            <RequestRow key={r.ref} r={r} incoming={false} />
          ))}
        </ul>
      )}
      {!compact && blocked.length > 0 && (
        <div className="text-sm">
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowBlocked((v) => !v)}
          >
            {showBlocked ? 'Hide' : 'Show'} blocked ({blocked.length})
          </button>
          {showBlocked && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {blocked.map((b) => (
                <li key={b.ref} className="flex items-center justify-between gap-2 text-zinc-400">
                  <span className="truncate">{b.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => friendsApi.unblock(b.ref))}
                  >
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
