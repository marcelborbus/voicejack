import { Check, Search, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FRIEND_SEARCH_MIN, type FriendSearchResult } from '@dub/shared';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { friendsApi, FriendsApiError } from './api';
import { refreshFriends } from './store';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-10` → `Oct 2026`. */
const joinedLabel = (ym: string): string => {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`.trim();
};

function ResultRow({ r, onDone }: { r: FriendSearchResult; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <li
      className="flex items-center gap-3 rounded-2xl bg-ink-850 px-3 py-2"
      data-testid="friend-search-result"
    >
      <PlayerAvatar name={r.avatarSeed} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{r.name}</span>
        <span className="text-xs text-zinc-400">
          <span className="font-mono">#{r.tag}</span> · joined {joinedLabel(r.joined)}
        </span>
      </span>
      {r.relation === 'friend' ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
          <Check className="size-3.5" /> Friends
        </span>
      ) : r.relation === 'outgoing' ? (
        <span className="text-xs text-zinc-500">Requested</span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-testid="friend-search-add"
          onClick={async () => {
            setBusy(true);
            try {
              const res = await friendsApi.addByRef(r.ref);
              toast(
                res.result === 'accepted' ? "You're friends now" : `Request sent to ${r.name}`,
                {
                  variant: 'success',
                  durationMs: 2500,
                },
              );
            } catch (e) {
              toast(e instanceof FriendsApiError ? e.message : 'Could not send the request', {
                variant: 'warning',
              });
            } finally {
              setBusy(false);
              onDone();
              void refreshFriends();
            }
          }}
        >
          <UserPlus /> {r.relation === 'incoming' ? 'Accept' : 'Add'}
        </Button>
      )}
    </li>
  );
}

/** v1.2 #44: find registered players by name (≥ 3 characters, debounced, server-limited). */
export function FriendSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FriendSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const query = q.trim();

  useEffect(() => {
    if ([...query].length < FRIEND_SEARCH_MIN) {
      setResults(null);
      setError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      friendsApi
        .search(query)
        .then((r) => {
          if (!live) return;
          setResults(r.results);
          setError(null);
        })
        .catch((e) => {
          if (!live) return;
          setResults(null);
          setError(e instanceof FriendsApiError ? e.message : 'Search failed');
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, tick]);

  return (
    <div className="flex flex-col gap-2" data-testid="friend-search">
      <label className="relative block">
        <span className="sr-only">Find players by name</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find players by name"
          maxLength={40}
          className="h-10 pl-10 text-sm"
          data-testid="friend-search-input"
        />
      </label>
      {error && <p className="text-xs text-amber-300">{error}</p>}
      {results &&
        (results.length === 0 ? (
          <p className="text-xs text-zinc-500">Nobody found. People can hide from search.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <ResultRow key={r.ref} r={r} onDone={() => setTick((n) => n + 1)} />
            ))}
          </ul>
        ))}
    </div>
  );
}
