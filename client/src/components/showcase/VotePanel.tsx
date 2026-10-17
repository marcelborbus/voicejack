import { VOTE_MAX, VOTE_MIN, type ShowcaseItem } from '@dub/shared';
import { Check, Heart, Lock, Mic2, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { play } from '@/lib/sfx';
import { useRoom, useYou } from '@/state/room';
import { send } from '@/state/session';
import { useServerNow } from './useServerNow';

const DEBOUNCE_MS = 150;
const PICKS = Array.from({ length: VOTE_MAX - VOTE_MIN + 1 }, (_, i) => VOTE_MIN + i);

export function scoreLabel(score: number | null): string {
  if (score === null) return 'Drag to rate';
  if (score <= 1) return 'Ouch';
  if (score <= 3) return 'Not quite';
  if (score <= 5) return 'Decent';
  if (score <= 7) return 'Good stuff';
  if (score <= 9) return 'Brilliant';
  return 'Legendary';
}

/**
 * The 0–10 rating for the dub on screen. Starts untouched (no vote = not counted), sends
 * debounced while dragging and at once on release, shows the server's ack, and locks with a
 * little stamp when voting closes. On the player's own dub it is replaced by a notice.
 */
export function VotePanel({ item }: { item: ShowcaseItem }) {
  const you = useYou();
  const ackScore = useRoom((s) =>
    s.lastVoteAck?.submissionId === item.submissionId ? s.lastVoteAck.score : null,
  );
  const serverVote = you?.vote ?? null;
  const [draft, setDraft] = useState<number | null>(serverVote);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<number | null>(serverVote);
  const now = useServerNow(100, item.status === 'PLAYING');

  const pastLock = item.lockAt !== null && now >= item.lockAt;
  const locked = item.status === 'LOCKED' || (item.status === 'PLAYING' && pastLock);
  const own = !!you?.isOwnItem;
  const canVote = item.status === 'PLAYING' && !own && !locked;
  const confirmed = ackScore ?? serverVote;
  const pending = draft !== null && draft !== confirmed;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A reconnect can bring the server's view of our vote; adopt it if we haven't touched it.
  useEffect(() => {
    if (draft === null && serverVote !== null) setDraft(serverVote);
  }, [serverVote, draft]);

  function flush(score: number) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!canVote || lastSent.current === score) return;
    lastSent.current = score;
    send({ t: 'vote', submissionId: item.submissionId, score });
  }

  function change(score: number, immediate: boolean) {
    if (!canVote) return;
    if (score !== draft) play('tick', score);
    setDraft(score);
    if (immediate) return flush(score);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(score), DEBOUNCE_MS);
  }

  if (own) {
    return (
      <div
        data-testid="own-item-notice"
        className="flex animate-pop flex-col items-center gap-3 rounded-3xl border border-fuchsia-400/25 bg-fuchsia-500/[0.07] px-5 py-8 text-center"
      >
        <span className="inline-flex size-14 animate-float items-center justify-center rounded-3xl border-2 border-[#1a1027] bg-brand shadow-[0_4px_0_rgb(0_0_0/0.5)]">
          <Mic2 className="size-7 text-white" />
        </span>
        <p className="font-display text-2xl font-bold">This one's yours!</p>
        <p className="max-w-xs text-sm text-zinc-400">
          Sit back and keep a straight face. Nobody knows it's you until the results.
        </p>
      </div>
    );
  }

  // Once locked, show what the server actually counted.
  const shown = locked ? confirmed : draft;
  const hue = shown === null ? 0 : shown / VOTE_MAX;

  return (
    <div className="flex flex-col gap-5" data-testid="vote-panel" data-locked={locked}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Your score
          </p>
          <p className="mt-1 text-sm text-zinc-400">{scoreLabel(shown)}</p>
        </div>
        <div className="relative">
          <span
            data-testid="vote-value"
            key={shown ?? 'none'}
            className={cn(
              'block animate-jiggle font-display text-6xl font-extrabold tabular-nums leading-none',
              shown === null ? 'text-zinc-600' : 'text-brand',
            )}
            style={shown === null ? undefined : { filter: `saturate(${0.6 + hue * 0.8})` }}
          >
            {shown ?? '–'}
          </span>
          {locked && confirmed !== null && (
            <span className="absolute right-full top-2 mr-3 -rotate-12 animate-pop rounded-lg border-2 border-emerald-400 bg-ink-950/90 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300 shadow-lg shadow-emerald-500/20">
              Locked
            </span>
          )}
        </div>
      </div>

      <div className={cn('relative', locked && 'pointer-events-none')}>
        <Slider
          data-testid="vote-slider"
          aria-label="Your score from 0 to 10"
          min={VOTE_MIN}
          max={VOTE_MAX}
          step={1}
          value={[shown ?? 5]}
          disabled={!canVote}
          onValueChange={([v]) => v !== undefined && change(v, false)}
          onValueCommit={([v]) => v !== undefined && change(v, true)}
          className={cn(shown === null && '[&_[role=slider]]:opacity-60 [&_.bg-brand]:opacity-0')}
        />
        <div className="mt-2 grid grid-cols-11 gap-1">
          {PICKS.map((n) => (
            <button
              key={n}
              type="button"
              data-testid={`vote-pick-${n}`}
              disabled={!canVote}
              onClick={() => change(n, true)}
              className={cn(
                'h-8 rounded-lg text-xs font-bold tabular-nums transition-colors',
                'disabled:cursor-default disabled:opacity-40',
                shown === n
                  ? 'bg-fuchsia-500/25 text-fuchsia-100 ring-1 ring-fuchsia-400/50'
                  : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200',
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <VoteFooter
        status={item.status}
        locked={locked}
        confirmed={confirmed}
        pending={pending}
        hasDraft={draft !== null}
      />
    </div>
  );
}

function VoteFooter({
  status,
  locked,
  confirmed,
  pending,
  hasDraft,
}: {
  status: ShowcaseItem['status'];
  locked: boolean;
  confirmed: number | null;
  pending: boolean;
  hasDraft: boolean;
}) {
  if (locked) {
    return confirmed !== null ? (
      <div
        data-testid="vote-locked"
        className="flex animate-pop items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-400/[0.08] px-4 py-3"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-emerald-400 text-emerald-950 shadow-lg shadow-emerald-500/30">
          <Lock className="size-4" strokeWidth={2.75} />
        </span>
        <div className="min-w-0">
          <p className="font-display text-lg font-bold leading-tight text-emerald-200">
            Locked in: {confirmed}
          </p>
          <p className="text-xs text-emerald-300/70">Thanks! Your score is counted.</p>
        </div>
      </div>
    ) : (
      <div
        data-testid="vote-locked"
        className="flex animate-pop items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-zinc-800 text-zinc-400">
          <Lock className="size-4" />
        </span>
        <p className="text-sm text-zinc-400">Voting closed. No score from you this time.</p>
      </div>
    );
  }
  if (status === 'LOADING') {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Star className="size-4" /> Voting opens when the dub starts.
      </p>
    );
  }
  return (
    <p className="flex min-h-6 items-center gap-2 text-sm" data-testid="vote-ack">
      {confirmed !== null && !pending ? (
        <span
          key={confirmed}
          className="flex animate-fade-in items-center gap-1.5 text-emerald-300"
        >
          <Check className="size-4" strokeWidth={3} /> Saved: {confirmed}. You can change it until
          the dub ends.
        </span>
      ) : hasDraft ? (
        <span className="text-zinc-400">Sending…</span>
      ) : (
        <span className="flex items-center gap-1.5 text-zinc-500">
          <Heart className="size-4" /> No score yet: if you skip, you simply don't count.
        </span>
      )}
    </p>
  );
}
