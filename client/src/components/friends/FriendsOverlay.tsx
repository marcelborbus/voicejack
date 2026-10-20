import { DoorOpen, Users, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { FriendList } from './FriendList';
import {
  dismissInvite,
  useFriends,
  useFriendsBoot,
  useIsRegistered,
  useUnreadTotal,
  type PendingInvite,
} from './store';

const INVITE_TTL_MS = 3 * 60_000;

// #53: the chat drawer is its own chunk, fetched when a chat opens.
const ChatDrawer = lazy(() => import('./ChatDrawer').then((m) => ({ default: m.ChatDrawer })));

function InviteCard({ inv }: { inv: PendingInvite }) {
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => dismissInvite(inv), INVITE_TTL_MS);
    return () => clearTimeout(t);
  }, [inv]);
  return (
    <div
      role="alert"
      data-testid="friend-invite"
      className="sticker flex animate-fade-up items-center gap-3 rounded-2xl p-3"
    >
      <DoorOpen className="size-6 shrink-0 text-jack" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">{inv.fromName}</span> invites you to their room
      </p>
      <Button
        size="sm"
        data-testid="invite-join"
        onClick={() => {
          dismissInvite(inv);
          navigate(`/r/${inv.code}`);
        }}
      >
        Join
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => dismissInvite(inv)}
      >
        <X />
      </Button>
    </div>
  );
}

/** Friends button for pages other than home (where the panel lives), e.g. to invite from the lobby. */
function FriendsDock() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadTotal();
  const incoming = useFriends((s) => s.data?.incoming.length ?? 0);
  const chatOpen = useFriends((s) => !!s.chatWith);
  if (chatOpen) return null;
  return (
    <div className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
      {open && (
        <div className="sticker max-h-[60dvh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-3xl p-4">
          <FriendList compact />
        </div>
      )}
      <Button
        variant="secondary"
        className="relative rounded-full shadow-lg"
        aria-expanded={open}
        data-testid="friends-dock"
        onClick={() => setOpen((o) => !o)}
      >
        <Users /> Friends
        {unread + incoming > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-fuchsia-500 px-1.5 text-xs font-bold leading-5 text-white">
            {unread + incoming}
          </span>
        )}
      </Button>
    </div>
  );
}

/** Global V10 layer (mounted in Shell): invite cards, DM drawer, friends dock. */
export function FriendsOverlay() {
  useFriendsBoot();
  const registered = useIsRegistered();
  const invites = useFriends((s) => s.invites);
  const { pathname } = useLocation();
  // Mounted from the first opened chat on (keeps its close animation afterwards).
  const chatWith = useFriends((s) => s.chatWith);
  const [chatOpen, setChatOpen] = useState(false);
  if (chatWith && !chatOpen) setChatOpen(true);
  if (!registered) return null;
  return (
    <>
      {invites.length > 0 && (
        <div className="fixed inset-x-4 top-4 z-50 flex flex-col gap-2 sm:left-auto sm:w-96">
          {invites.map((inv) => (
            <InviteCard key={`${inv.from}:${inv.code}:${inv.at}`} inv={inv} />
          ))}
        </div>
      )}
      {chatOpen && (
        <Suspense>
          <ChatDrawer />
        </Suspense>
      )}
      {pathname !== '/' && <FriendsDock />}
    </>
  );
}
