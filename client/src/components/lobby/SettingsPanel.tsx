import {
  DUBBING_SECONDS_RANGE,
  formatClock,
  NORMAL_SETTINGS,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
  type GameSettings,
} from '@dub/shared';
import { Clapperboard, Clock3, Repeat, Settings2, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LibraryPicker } from '@/components/lobby/LibraryPicker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useRoom } from '@/state/room';
import { send } from '@/state/session';

function update(settings: Partial<GameSettings>) {
  send({ t: 'updateSettings', settings });
}

export function SettingsPanel({
  settings,
  availableTags,
  clipCount,
  isHost,
}: {
  settings: GameSettings;
  availableTags: string[];
  clipCount: number;
  isHost: boolean;
}) {
  const extended = settings.mode === 'extended';
  // V14: every player dubs a different clip, so the library needs one clip per player.
  const players = useRoom((s) => s.snapshot?.players.length ?? 0);
  return (
    <Card data-testid="settings-panel">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-xl sm:text-xl">
          <Settings2 className="size-5 text-orange-300" /> Game settings
        </CardTitle>
        {isHost ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-zinc-300">
            Extended
            <Switch
              data-testid="mode-switch"
              checked={extended}
              onCheckedChange={(on) =>
                update(
                  on
                    ? {
                        mode: 'extended',
                        rounds: settings.rounds,
                        dubbingSeconds: settings.dubbingSeconds,
                        tags: settings.tags,
                      }
                    : { mode: 'normal' },
                )
              }
            />
          </label>
        ) : (
          <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-zinc-400">
            {extended ? 'Extended' : 'Normal'} mode
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <LibraryPicker libraryId={settings.libraryId} isHost={isHost} clipCount={clipCount} />
        <div className="grid grid-cols-3 gap-2">
          <Stat
            icon={Repeat}
            label="Rounds"
            value={String(settings.rounds)}
            testId="setting-rounds"
          />
          <Stat
            icon={Clock3}
            label="Dub time"
            value={formatClock(settings.dubbingSeconds * 1000)}
            testId="setting-time"
          />
          <Stat
            icon={Clapperboard}
            label="Clips"
            value={String(clipCount)}
            testId="setting-clips"
            warn={clipCount < players}
          />
        </div>

        {isHost && extended && (
          <ExtendedControls settings={settings} availableTags={availableTags} />
        )}
        {!isHost && extended && settings.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {settings.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-fuchsia-500/15 px-2.5 py-1 text-xs font-semibold text-fuchsia-200"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {!extended && (
          <p className="text-sm text-zinc-500">
            {NORMAL_SETTINGS.rounds} rounds, {formatClock(NORMAL_SETTINGS.dubbingSeconds * 1000)} to
            dub each clip.
            {isHost && ' Switch to Extended to tune rounds, time and clip tags.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  testId,
  warn,
}: {
  icon: typeof Repeat;
  label: string;
  value: string;
  testId: string;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-0.5 rounded-2xl border border-white/[0.06] bg-zinc-950/40 px-2 py-3',
        warn && 'border-amber-400/30 bg-amber-400/[0.06]',
      )}
    >
      <Icon className={cn('size-4', warn ? 'text-amber-300' : 'text-zinc-500')} />
      <span className="font-display text-2xl font-bold tabular-nums" data-testid={testId}>
        {value}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
    </div>
  );
}

function ExtendedControls({
  settings,
  availableTags,
}: {
  settings: GameSettings;
  availableTags: string[];
}) {
  // Local values while dragging; sent on commit.
  const [rounds, setRounds] = useState(settings.rounds);
  const [secs, setSecs] = useState(settings.dubbingSeconds);
  const [secsText, setSecsText] = useState(String(settings.dubbingSeconds));
  useEffect(() => setRounds(settings.rounds), [settings.rounds]);
  useEffect(() => {
    setSecs(settings.dubbingSeconds);
    setSecsText(String(settings.dubbingSeconds));
  }, [settings.dubbingSeconds]);

  const commitSecsText = () => {
    const n = Math.round(Number(secsText));
    if (!Number.isFinite(n) || n === settings.dubbingSeconds) {
      setSecsText(String(settings.dubbingSeconds));
      return;
    }
    const clamped = Math.min(DUBBING_SECONDS_RANGE.max, Math.max(SHORT_DUBBING_MIN_SECONDS, n));
    setSecsText(String(clamped));
    update({ dubbingSeconds: clamped });
  };

  const toggleTag = (tag: string) => {
    const tags = settings.tags.includes(tag)
      ? settings.tags.filter((t) => t !== tag)
      : [...settings.tags, tag];
    update({ tags });
  };

  return (
    <div className="flex animate-fade-in flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Rounds</Label>
          <span className="font-mono text-sm font-semibold text-zinc-200">{rounds}</span>
        </div>
        <Slider
          data-testid="rounds-slider"
          min={ROUNDS_RANGE.min}
          max={ROUNDS_RANGE.max}
          step={ROUNDS_RANGE.step}
          value={[rounds]}
          onValueChange={([v]) => setRounds(v!)}
          onValueCommit={([v]) => v !== settings.rounds && update({ rounds: v! })}
          aria-label="Rounds"
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="dub-secs">Dubbing time</Label>
          <div className="flex items-center gap-1.5">
            <input
              id="dub-secs"
              data-testid="dubbing-seconds-input"
              inputMode="numeric"
              value={secsText}
              onChange={(e) => setSecsText(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitSecsText}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              className="h-8 w-16 rounded-lg border border-white/10 bg-zinc-950/60 px-2 text-right font-mono text-sm text-zinc-100 focus-visible:border-fuchsia-400/70 focus-visible:outline-none"
              aria-label="Dubbing time in seconds"
            />
            <span className="text-xs text-zinc-500">s · {formatClock(secs * 1000)}</span>
          </div>
        </div>
        <Slider
          data-testid="dubbing-slider"
          min={DUBBING_SECONDS_RANGE.min}
          max={DUBBING_SECONDS_RANGE.max}
          step={DUBBING_SECONDS_RANGE.step}
          value={[Math.max(DUBBING_SECONDS_RANGE.min, secs)]}
          onValueChange={([v]) => {
            setSecs(v!);
            setSecsText(String(v));
          }}
          onValueCommit={([v]) => v !== settings.dubbingSeconds && update({ dubbingSeconds: v! })}
          aria-label="Dubbing time"
        />
      </div>

      {availableTags.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="flex items-center gap-1.5">
            <Tags className="size-3.5" /> Clip tags
            <span className="font-normal normal-case tracking-normal text-zinc-500">
              {settings.tags.length === 0 ? '· all clips' : `· ${settings.tags.length} selected`}
            </span>
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {availableTags.map((tag) => {
              const on = settings.tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={on}
                  data-testid={`tag-${tag}`}
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-semibold transition-all active:scale-95',
                    on
                      ? 'border-transparent bg-brand text-white shadow-md shadow-fuchsia-500/25'
                      : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/25',
                  )}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
