import { Flag, Send, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { DM_MAX_LENGTH, sanitizeDmBody } from '@dub/shared';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useMe } from '@/state/me';
import { friendsApi, FriendsApiError } from './api';
import { STATUS_LABEL, StatusDot } from './FriendList';
import { closeChat, loadOlder, sendMessage, useFriends } from './store';

/** DM drawer for the friend in `chatWith`. Messages render as plain text only. */
export function ChatDrawer() {
  const chatWith = useFriends((s) => s.chatWith);
  const friend = useFriends((s) => s.data?.friends.find((f) => f.userId === s.chatWith) ?? null);
  const chat = useFriends((s) => (s.chatWith ? s.chats[s.chatWith] : undefined));
  const me = useMe((s) => s.user?.id ?? null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = chat?.messages.at(-1)?.id;

  useEffect(() => {
    setText('');
    setReporting(false);
  }, [chatWith]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, chatWith]);
  useEffect(() => {
    if (!chatWith) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeChat();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatWith]);

  if (!chatWith) return null;
  // Unfriended / blocked while open.
  if (!friend) return null;

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const body = sanitizeDmBody(text);
    if (!body || busy || !chatWith) return;
    setBusy(true);
    try {
      await sendMessage(chatWith, body);
      setText('');
    } catch (err) {
      toast(err instanceof FriendsApiError ? err.message : 'Message not sent', {
        variant: 'warning',
      });
    } finally {
      setBusy(false);
    }
  }

  async function onReport(e: FormEvent) {
    e.preventDefault();
    if (!chatWith || !reason.trim()) return;
    const lastTheirs = [...(chat?.messages ?? [])].reverse().find((m) => m.from === chatWith);
    try {
      await friendsApi.report(chatWith, reason.trim(), lastTheirs?.id);
      toast('Report sent. Thanks.', {
        variant: 'success',
        description: 'You can also block them from the friends list.',
      });
      setReporting(false);
      setReason('');
    } catch (err) {
      toast(err instanceof FriendsApiError ? err.message : 'Report failed', { variant: 'warning' });
    }
  }

  return (
    <aside
      role="dialog"
      aria-label={`Chat with ${friend.name}`}
      data-testid="chat-drawer"
      className="sticker fixed inset-x-0 bottom-0 z-40 flex h-[70dvh] flex-col rounded-t-3xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[32rem] sm:w-96 sm:rounded-3xl"
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className="relative">
          <PlayerAvatar name={friend.name} size="sm" />
          <StatusDot status={friend.status} className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{friend.name}</span>
          <span className="text-xs text-zinc-400">{STATUS_LABEL[friend.status]}</span>
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Report"
          title="Report"
          onClick={() => setReporting((r) => !r)}
        >
          <Flag />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close chat" onClick={closeChat}>
          <X />
        </Button>
      </header>
      {reporting && (
        <form
          onSubmit={onReport}
          className="flex flex-col gap-2 border-b border-white/10 px-4 py-3"
        >
          <label className="text-xs text-zinc-400" htmlFor="dm-report">
            What's wrong? Their latest message is attached for the moderator.
          </label>
          <textarea
            id="dm-report"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className="well min-h-16 rounded-xl px-3 py-2 text-sm"
          />
          <Button size="sm" variant="destructive" type="submit" disabled={!reason.trim()}>
            Send report
          </Button>
        </form>
      )}
      <div ref={listRef} className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-3">
        {chat?.more && (
          <Button
            size="sm"
            variant="ghost"
            className="self-center"
            disabled={chat.loading}
            onClick={() => void loadOlder(chatWith)}
          >
            Older messages
          </Button>
        )}
        {chat && !chat.loading && chat.messages.length === 0 && (
          <p className="m-auto text-sm text-zinc-500">Say hi! Messages are kept for 90 days.</p>
        )}
        {chat?.messages.map((m) => (
          <p
            key={m.id}
            title={new Date(m.at).toLocaleString()}
            className={cn(
              'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm',
              m.from === me
                ? 'self-end bg-fuchsia-500/25 text-zinc-50'
                : 'self-start bg-ink-850 text-zinc-100',
            )}
          >
            {m.body}
          </p>
        ))}
      </div>
      <form onSubmit={onSend} className="flex items-end gap-2 border-t border-white/10 p-3">
        <textarea
          aria-label="Message"
          data-testid="dm-input"
          value={text}
          rows={1}
          maxLength={DM_MAX_LENGTH}
          placeholder="Message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className="well max-h-28 min-h-10 flex-1 resize-none rounded-xl px-3 py-2 text-sm"
        />
        <Button
          size="icon"
          type="submit"
          aria-label="Send"
          disabled={busy || !sanitizeDmBody(text)}
        >
          <Send />
        </Button>
      </form>
    </aside>
  );
}
