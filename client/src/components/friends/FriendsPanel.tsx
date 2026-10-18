import { Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FriendList } from './FriendList';
import { FriendSearch } from './FriendSearch';
import { useFriends, useIsRegistered, useUnreadTotal } from './store';

/** Home page friends panel (registered users only): requests, live status, chat. */
export function FriendsPanel({ className }: { className?: string }) {
  const registered = useIsRegistered();
  const online = useFriends(
    (s) => s.data?.friends.filter((f) => f.status !== 'offline').length ?? 0,
  );
  const unread = useUnreadTotal();
  if (!registered) return null;
  return (
    <Card className={className} data-testid="friends-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5 text-jack" /> Friends
          <span className="text-sm font-semibold text-zinc-400">{online} online</span>
          {unread > 0 && (
            <span className="ml-auto rounded-full bg-fuchsia-500 px-2 text-xs font-bold leading-5 text-white">
              {unread} new
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FriendSearch />
        <FriendList />
      </CardContent>
    </Card>
  );
}
