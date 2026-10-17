import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  DirectMessage,
  FriendInfo,
  FriendsResponse,
  RoomCode,
  RoomRelation,
} from '@dub/shared';
import { play } from '@/lib/sfx';
import { presence } from '@/net/presence';
import { useMe } from '@/state/me';
import { friendsApi } from './api';

export interface PendingInvite {
  from: string;
  fromName: string;
  code: RoomCode;
  at: number;
}

export interface Chat {
  messages: DirectMessage[];
  more: boolean;
  loading: boolean;
}

interface FriendsState {
  data: FriendsResponse | null;
  invites: PendingInvite[];
  /** Friend whose chat drawer is open. */
  chatWith: string | null;
  chats: Record<string, Chat>;
  room: { code: RoomCode | null; players: Record<string, RoomRelation> };
}

const empty = (): FriendsState => ({
  data: null,
  invites: [],
  chatWith: null,
  chats: {},
  room: { code: null, players: {} },
});

export const useFriends = create<FriendsState>(empty);

const myId = () => useMe.getState().user?.id ?? null;
const registered = () => useMe.getState().user?.kind === 'registered';

function patchFriend(userId: string, fn: (f: FriendInfo) => FriendInfo): void {
  useFriends.setState((s) =>
    s.data
      ? {
          data: {
            ...s.data,
            friends: s.data.friends.map((f) => (f.userId === userId ? fn(f) : f)),
          },
        }
      : {},
  );
}

let refreshing: Promise<void> | null = null;
/** Reloads the friend lists (and the open room's relations). Never throws. */
export function refreshFriends(): Promise<void> {
  if (!registered()) return Promise.resolve();
  refreshing ??= friendsApi
    .list()
    .then((data) => {
      // A chat that is open stays read.
      const open = useFriends.getState().chatWith;
      if (open)
        data.friends = data.friends.map((f) => (f.userId === open ? { ...f, unread: 0 } : f));
      useFriends.setState({ data });
    })
    .catch(() => {})
    .finally(() => (refreshing = null));
  const code = useFriends.getState().room.code;
  if (code) void loadRoomRelations(code);
  return refreshing;
}

export async function loadRoomRelations(code: RoomCode): Promise<void> {
  if (!registered()) return;
  try {
    const { players } = await friendsApi.roomRelations(code);
    useFriends.setState({ room: { code, players } });
  } catch {
    useFriends.setState({ room: { code, players: {} } });
  }
}

function addMessage(other: string, m: DirectMessage): void {
  useFriends.setState((s) => {
    const chat = s.chats[other];
    if (!chat || chat.messages.some((x) => x.id === m.id)) return {};
    return { chats: { ...s.chats, [other]: { ...chat, messages: [...chat.messages, m] } } };
  });
}

let wired = false;
/** Subscribes to the presence pushes once per tab. */
function wire(): void {
  if (wired) return;
  wired = true;
  presence.on('friends', () => void refreshFriends());
  presence.on('friendStatus', (m) => patchFriend(m.userId, (f) => ({ ...f, status: m.status })));
  presence.on('dm', ({ message }) => {
    const me = myId();
    if (!me) return;
    const other = message.from === me ? message.to : message.from;
    addMessage(other, message);
    if (message.from === me) return;
    if (useFriends.getState().chatWith === other) {
      void friendsApi.read(other).catch(() => {});
    } else {
      patchFriend(other, (f) => ({ ...f, unread: f.unread + 1 }));
      play('pop');
    }
  });
  presence.on('invite', (m) => {
    if (!registered()) return;
    useFriends.setState((s) => ({
      invites: [
        ...s.invites.filter((i) => !(i.from === m.from && i.code === m.code)).slice(-2),
        { from: m.from, fromName: m.fromName, code: m.code, at: Date.now() },
      ],
    }));
    play('pop');
  });
}

/** Mounted once (Shell): loads friends for registered users and resets on sign-out. */
export function useFriendsBoot(): void {
  const user = useMe((s) => s.user);
  const id = user?.kind === 'registered' ? user.id : null;
  useEffect(() => {
    useFriends.setState(empty());
    if (!id) return;
    wire();
    void refreshFriends();
  }, [id]);
}

export function useIsRegistered(): boolean {
  return useMe((s) => s.user?.kind === 'registered');
}

export function useUnreadTotal(): number {
  return useFriends((s) => s.data?.friends.reduce((n, f) => n + f.unread, 0) ?? 0);
}

// ---------------------------------------------------------------- chat

export async function openChat(userId: string): Promise<void> {
  useFriends.setState((s) => ({
    chatWith: userId,
    chats: {
      ...s.chats,
      [userId]: s.chats[userId] ?? { messages: [], more: false, loading: true },
    },
  }));
  patchFriend(userId, (f) => ({ ...f, unread: 0 }));
  try {
    const r = await friendsApi.messages(userId);
    useFriends.setState((s) => {
      const known = s.chats[userId]?.messages ?? [];
      const ids = new Set(r.messages.map((m) => m.id));
      const merged = [
        ...r.messages,
        ...known.filter((m) => !ids.has(m.id) && m.id > (r.messages.at(-1)?.id ?? 0)),
      ];
      return {
        chats: { ...s.chats, [userId]: { messages: merged, more: r.more, loading: false } },
      };
    });
  } catch {
    useFriends.setState((s) => ({
      chats: {
        ...s.chats,
        [userId]: { messages: s.chats[userId]?.messages ?? [], more: false, loading: false },
      },
    }));
  }
}

export function closeChat(): void {
  useFriends.setState({ chatWith: null });
}

export async function loadOlder(userId: string): Promise<void> {
  const chat = useFriends.getState().chats[userId];
  const first = chat?.messages[0];
  if (!chat || !first || chat.loading) return;
  useFriends.setState((s) => ({ chats: { ...s.chats, [userId]: { ...chat, loading: true } } }));
  try {
    const r = await friendsApi.messages(userId, first.id);
    useFriends.setState((s) => {
      const cur = s.chats[userId] ?? chat;
      return {
        chats: {
          ...s.chats,
          [userId]: { messages: [...r.messages, ...cur.messages], more: r.more, loading: false },
        },
      };
    });
  } catch {
    useFriends.setState((s) => ({ chats: { ...s.chats, [userId]: { ...chat, loading: false } } }));
  }
}

export async function sendMessage(userId: string, body: string): Promise<void> {
  const { message } = await friendsApi.send(userId, body);
  addMessage(userId, message);
}

export function dismissInvite(inv: PendingInvite): void {
  useFriends.setState((s) => ({ invites: s.invites.filter((i) => i !== inv) }));
}
