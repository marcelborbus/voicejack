import type { ClipInfo, ShowcaseItem } from '@dub/shared';
import { Clapperboard, EyeOff, Sparkles, Users, VenetianMask } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ClipAttribution } from '@/components/showcase/ClipAttribution';
import { recordShowcaseItem } from '@/components/showcase/showcaseHistory';
import { useShowcasePlayback, type LoadState } from '@/components/showcase/useShowcasePlayback';
import { useServerNow } from '@/components/showcase/useServerNow';
import { VotePanel } from '@/components/showcase/VotePanel';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useRoom, useSnapshot } from '@/state/room';

export function Showcase() {
  const snap = useSnapshot();
  const item = snap?.showcase ?? null;
  // V14: every dub has its own clip; the <video> switches source per item while LOADING.
  const clip = item?.clip ?? null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const { load } = useShowcasePlayback(videoRef, clip, item);
  const myVote = snap?.you.vote ?? null;

  // Remember the show order (and our vote) for the round results.
  useEffect(() => {
    if (snap && item)
      recordShowcaseItem(snap.code, snap.round, item.submissionId, {
        index: item.index,
        myVote: snap.you.isOwnItem ? null : myVote,
      });
  }, [snap, item, myVote]);

  if (!snap || !clip) return null;

  return (
    <div className="flex flex-col gap-5" data-testid="showcase">
      <ShowcaseHeader item={item} clip={clip} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col gap-4 p-3 sm:p-4">
            <div
              className="relative overflow-hidden rounded-[1.25rem] border-2 border-[#1a1027] bg-black"
              style={{ aspectRatio: `${clip.width} / ${clip.height}` }}
            >
              <video
                ref={videoRef}
                src={clip.url}
                poster={clip.posterUrl}
                muted
                playsInline
                preload="auto"
                disablePictureInPicture
                className="absolute inset-0 size-full object-contain"
                data-testid="showcase-video"
              />
              {item && <VideoOverlay item={item} load={load} />}
              {item && (
                <div className="pointer-events-none absolute left-3 top-3 flex gap-2">
                  {snap.you.isOwnItem ? (
                    <Badge className="shadow-lg">Your dub</Badge>
                  ) : (
                    <span className="inline-flex items-center gap-2 rounded-2xl border-2 border-[#1a1027] bg-ink-900/90 py-1 pl-1 pr-3 text-xs font-bold text-zinc-100 shadow-[0_3px_0_rgb(0_0_0/0.5)]">
                      <PlayerAvatar name="?" mystery size="xs" className="border-0 shadow-none" />
                      <VenetianMask className="size-3.5 text-sun" /> Mystery dubber
                    </span>
                  )}
                </div>
              )}
            </div>
            <ClipProgress
              videoRef={videoRef}
              durationMs={clip.durationMs}
              active={item?.status === 'PLAYING'}
            />
            <ClipAttribution clip={clip} className="px-1" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex h-full flex-col gap-6">
            {item ? (
              <>
                <VotePanel key={item.submissionId} item={item} />
                <VoterCount key={`count-${item.submissionId}`} item={item} />
              </>
            ) : (
              <p className="text-zinc-400">Wrapping up…</p>
            )}
            <p className="mt-auto flex items-start gap-2 text-xs text-zinc-500">
              <EyeOff className="mt-0.5 size-3.5 shrink-0" />
              Dubs are anonymous: authors are revealed with the round results. You can't rate your
              own dub.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function statusText(item: ShowcaseItem | null, now: number): string {
  if (!item) return 'Done';
  if (item.status === 'LOADING') return 'Loading';
  if (item.status === 'LOCKED') return 'Locked';
  if (item.startAt !== null && now < item.startAt) return 'Starting';
  return 'Now playing';
}

function ShowcaseHeader({ item, clip }: { item: ShowcaseItem | null; clip: ClipInfo }) {
  const now = useServerNow(200, item?.status === 'PLAYING');
  const text = statusText(item, now);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="tape max-w-full">
          <Clapperboard className="size-3.5 shrink-0" />{' '}
          <span className="truncate">Showcase · {clip.title}</span>
        </p>
        <h2 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
          {item ? (
            <>
              Dub <span className="text-brand">{item.index + 1}</span>
              <span className="text-zinc-500"> of {item.total}</span>
            </>
          ) : (
            'That was all of them'
          )}
        </h2>
        {item && (
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {Array.from({ length: item.total }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-500',
                  i < item.index && 'w-6 bg-fuchsia-400/60',
                  i === item.index && 'w-10 bg-brand',
                  i > item.index && 'w-6 bg-zinc-800',
                )}
              />
            ))}
          </div>
        )}
      </div>
      <span
        data-testid="showcase-status"
        data-status={item?.status ?? 'DONE'}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold',
          text === 'Now playing' && 'border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100',
          text === 'Starting' && 'border-amber-400/30 bg-amber-400/10 text-amber-200',
          text === 'Loading' && 'border-white/10 bg-white/[0.03] text-zinc-300',
          (text === 'Locked' || text === 'Done') &&
            'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
        )}
      >
        {text === 'Now playing' && (
          <span className="relative flex size-2.5">
            {/* #50: stepped blink, not `animate-ping` (a per-frame repaint over the playing clip). */}
            <span className="relative inline-flex size-2.5 animate-blink rounded-full bg-fuchsia-400" />
          </span>
        )}
        {text === 'Loading' && <Spinner className="size-4" />}
        {text}
      </span>
    </div>
  );
}

function VideoOverlay({ item, load }: { item: ShowcaseItem; load: LoadState }) {
  const now = useServerNow(100, item.status === 'PLAYING');
  const countdown =
    item.status === 'PLAYING' && item.startAt !== null && now < item.startAt
      ? Math.ceil((item.startAt - now) / 1000)
      : null;
  const last = item.index + 1 >= item.total;

  let content: ReactNode = null;
  if (item.status === 'LOADING') {
    content = (
      <>
        <Spinner className="size-9" />
        <p className="font-display text-xl font-bold">
          {load === 'ready' ? 'Waiting for everyone…' : `Loading dub ${item.index + 1}…`}
        </p>
        {load === 'failed' && (
          <p className="text-sm text-amber-300">Couldn't load everything; playing what we have.</p>
        )}
      </>
    );
  } else if (countdown !== null) {
    content = (
      <>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Get ready</p>
        <span
          key={countdown}
          className="animate-pop font-display text-7xl font-extrabold text-brand"
        >
          {countdown}
        </span>
      </>
    );
  } else if (item.status === 'LOCKED') {
    content = (
      <>
        <Sparkles className="size-9 text-fuchsia-300" />
        <p className="font-display text-2xl font-bold">
          {last ? 'Results coming up…' : 'Next dub coming up…'}
        </p>
      </>
    );
  }
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/70 text-center transition-opacity duration-300',
        // #50: no backdrop blur while hidden: it sat over the playing clip at opacity 0.
        content ? 'opacity-100 backdrop-blur-sm' : 'pointer-events-none opacity-0',
      )}
    >
      {content}
    </div>
  );
}

function ClipProgress({
  videoRef,
  durationMs,
  active,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  durationMs: number;
  active: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState('0:00');
  useEffect(() => {
    let raf = 0;
    let lastS = -1;
    const tick = () => {
      const v = videoRef.current;
      const t = v ? v.currentTime * 1000 : 0;
      const f = Math.max(0, Math.min(1, t / durationMs));
      if (barRef.current) barRef.current.style.transform = `scaleX(${f})`;
      const s = Math.floor(t / 1000);
      if (s !== lastS) {
        lastS = s;
        setLabel(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, durationMs, active]);
  const total = Math.round(durationMs / 1000);
  return (
    <div className="flex items-center gap-3 px-1">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div
          ref={barRef}
          className="absolute inset-0 origin-left bg-brand"
          style={{ transform: 'scaleX(0)' }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-zinc-500">
        {label} / {Math.floor(total / 60)}:{String(total % 60).padStart(2, '0')}
      </span>
    </div>
  );
}

function VoterCount({ item }: { item: ShowcaseItem }) {
  const players = useRoom((s) => s.snapshot?.players.length ?? 0);
  const { votesCast, votersExpected } = item;
  return (
    <div className="flex flex-col gap-2" data-testid="vote-count">
      <p className="flex items-center gap-2 text-sm text-zinc-400">
        <Users className="size-4" />
        <span>
          <span className="font-semibold tabular-nums text-zinc-200">{votesCast}</span>
          <span className="tabular-nums">/{votersExpected}</span> scored this dub
        </span>
      </p>
      <div className="flex gap-1.5">
        {Array.from({ length: Math.max(votersExpected, Math.min(votesCast, players)) }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-2 flex-1 rounded-full transition-colors duration-300',
              i < votesCast ? 'bg-emerald-400' : 'bg-zinc-800',
            )}
          />
        ))}
      </div>
    </div>
  );
}
