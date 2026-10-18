import { FEEDBACK_COMMENT_MAX, MOOD_EMOJI } from '@dub/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { sendFeedback } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const MOODS = [
  { mood: 1, label: 'Loved it' },
  { mood: 2, label: 'Good' },
  { mood: 3, label: 'Meh' },
  { mood: 4, label: 'Not great' },
] as const;

/** A mood is sent this long after the tap unless a comment is sent first (or on leaving). */
export const MOOD_SEND_DELAY_MS = 20_000;

/** Games already rated in this tab (memory only: no storage for analytics). */
const answered = new Set<string>();

/**
 * Final screen (V15): one-tap "how was it?" row with an optional ≤ 200-char comment. Shown once
 * per game (`gameKey`), above V11's support card. Stored anonymously (no user / room link).
 */
export function MoodPrompt({ gameKey, className }: { gameKey: string; className?: string }) {
  const [hidden] = useState(() => answered.has(gameKey));
  const [mood, setMood] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const pending = useRef<{ mood: number; comment: string } | null>(null);

  const flush = () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    sendFeedback({ kind: 'mood', mood: p.mood, comment: p.comment, phase: 'FINAL' });
  };

  // Leaving the Final screen (or the timeout) sends the tapped mood without a comment.
  useEffect(() => {
    if (mood === null || sent) return;
    const t = setTimeout(() => {
      flush();
      setSent(true);
    }, MOOD_SEND_DELAY_MS);
    return () => clearTimeout(t);
  }, [mood, sent]);
  useEffect(() => () => flush(), []);

  if (hidden) return null;

  const pick = (m: number) => {
    answered.add(gameKey);
    setMood(m);
    pending.current = { mood: m, comment: '' };
  };
  const submit = () => {
    if (pending.current) pending.current.comment = comment;
    flush();
    setSent(true);
  };

  return (
    <Card className={cn('animate-fade-up', className)} data-testid="mood-prompt">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {sent ? (
          <p className="text-sm text-zinc-300" data-testid="mood-thanks">
            Thanks! That helps make the next game better.
          </p>
        ) : (
          <>
            <p className="shrink-0 text-sm font-semibold text-zinc-200">How was that game?</p>
            <div className="flex gap-1.5" role="group" aria-label="Rate this game">
              {MOODS.map((m) => (
                <button
                  key={m.mood}
                  type="button"
                  aria-label={m.label}
                  aria-pressed={mood === m.mood}
                  title={m.label}
                  onClick={() => pick(m.mood)}
                  data-testid={`mood-${m.mood}`}
                  className={cn(
                    'grid size-11 place-items-center rounded-2xl text-2xl transition-transform',
                    'hover:scale-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-fuchsia-500/30',
                    mood === m.mood ? 'bg-fuchsia-400/20 ring-2 ring-fuchsia-400/60' : 'bg-ink-850',
                    mood !== null && mood !== m.mood && 'opacity-50',
                  )}
                >
                  <span aria-hidden>{MOOD_EMOJI[m.mood]}</span>
                </button>
              ))}
            </div>
            {mood !== null && (
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, FEEDBACK_COMMENT_MAX))}
                  maxLength={FEEDBACK_COMMENT_MAX}
                  placeholder="Anything to add? (optional, anonymous)"
                  aria-label="Optional comment"
                  data-testid="mood-comment"
                  className="h-10 min-w-0 flex-1 rounded-xl border border-white/12 bg-ink-950/70 px-3 text-sm text-zinc-50 placeholder:text-zinc-500 focus-visible:border-fuchsia-400/70 focus-visible:outline-none"
                />
                <Button size="sm" type="submit" data-testid="mood-send">
                  Send
                </Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
