import { Bot, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  NORMAL_SETTINGS,
  DUBBING_SECONDS_RANGE,
  MAX_BOTS,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
  type AdminLibrary,
} from '@dub/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { unlockAudio } from '@/audio/context';
import { prefetchMic } from '@/audio/mic';
import { toast } from '@/lib/toast';
import { preloadPhase } from '@/pages/phases/lazy';
import { useMe } from '@/state/me';
import { setToken } from '@/state/storage';
import { adminApi } from './api';

const FIELD = 'flex flex-col gap-1 text-sm font-semibold';
/** v1.2 #47: quick picks; the field takes any value from 5 s (quick runs) up. */
const PRESETS = [30, 90, NORMAL_SETTINGS.dubbingSeconds] as const;
const SELECT =
  'h-12 rounded-2xl border-[1.5px] border-white/12 bg-ink-950/70 px-3 text-base text-zinc-50';

/**
 * v1.2 #46: "Start test game": a private room with you as host and 1–7 server bots that send
 * snippets of the official library. Works in prod (no DEV_BOTS); never counts in analytics/Elo.
 */
export function TestGameCard({ libraries }: { libraries: AdminLibrary[] }) {
  const navigate = useNavigate();
  const myName = useMe((s) => s.user?.displayName ?? '');
  const [bots, setBots] = useState(3);
  const [libraryId, setLibraryId] = useState('');
  const [rounds, setRounds] = useState(1);
  const [secs, setSecs] = useState<number>(NORMAL_SETTINGS.dubbingSeconds);
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const usable = libraries.filter((l) => !l.disabled && l.clipCount > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // #53: inside the click: unlock audio and open the mic (if already allowed) while the room
    // is created, so the mic check is done by the time the lobby shows.
    void unlockAudio();
    prefetchMic();
    void preloadPhase('DUBBING').catch(() => undefined); // auto start: the editor comes next
    try {
      const r = await adminApi.testRoom({
        bots,
        rounds,
        autoStart,
        dubbingSeconds: secs,
        ...(libraryId ? { libraryId } : {}),
        ...(myName ? { name: myName } : {}),
      });
      setToken(r.code, r.token);
      navigate(`/r/${r.code}`);
    } catch (err) {
      toast('Could not start a test game', {
        description: (err as Error).message,
        variant: 'error',
      });
      setBusy(false);
    }
  };

  return (
    <Card data-testid="test-game-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl sm:text-xl">
          <Bot className="size-5 text-jack" /> Start test game
        </CardTitle>
        <p className="text-sm text-zinc-400">
          A private room with you as host and bots that send random snippets of the official
          library. Not counted in analytics or Elo. Right after a deploy or library change the bots
          may beep instead of talking for a few minutes while their voices are cut from the clips.
        </p>
      </CardHeader>
      <CardContent>
        <form
          className="grid items-start gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
          onSubmit={submit}
        >
          <label className={FIELD}>
            Bots
            <Input
              type="number"
              min={1}
              max={MAX_BOTS}
              value={bots}
              onChange={(e) => setBots(Number(e.target.value))}
              data-testid="test-game-bots"
            />
          </label>
          <label className={FIELD}>
            Library
            <select
              className={SELECT}
              value={libraryId}
              onChange={(e) => setLibraryId(e.target.value)}
              data-testid="test-game-library"
            >
              <option value="">Default</option>
              {usable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.clipCount})
                </option>
              ))}
            </select>
          </label>
          <label className={FIELD}>
            Rounds
            <Input
              type="number"
              min={ROUNDS_RANGE.min}
              max={ROUNDS_RANGE.max}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              data-testid="test-game-rounds"
            />
          </label>
          <div className={FIELD}>
            <label htmlFor="test-game-seconds">Dubbing time (s)</label>
            <Input
              id="test-game-seconds"
              type="number"
              min={SHORT_DUBBING_MIN_SECONDS}
              max={DUBBING_SECONDS_RANGE.max}
              value={secs}
              onChange={(e) => setSecs(Number(e.target.value))}
              data-testid="test-game-seconds"
            />
            <div className="flex gap-1" role="group" aria-label="Dubbing time presets">
              {PRESETS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={secs === p ? 'secondary' : 'ghost'}
                  aria-pressed={secs === p}
                  onClick={() => setSecs(p)}
                  data-testid={`test-game-seconds-${p}`}
                  className="h-7 flex-1 px-2 text-xs"
                >
                  {p} s
                </Button>
              ))}
            </div>
          </div>
          <label
            className="flex flex-wrap items-center gap-2 text-sm font-semibold sm:order-last sm:col-span-5"
            data-testid="test-game-autostart-label"
          >
            <input
              type="checkbox"
              className="size-4 accent-fuchsia-500"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              data-testid="test-game-autostart"
            />
            Start right away
            <span className="font-normal text-zinc-400">
              (no Ready/Start clicks: the game begins once your mic is checked, or after 3 s)
            </span>
          </label>
          <Button
            type="submit"
            className="self-start sm:mt-6"
            disabled={busy}
            data-testid="test-game-start"
          >
            {busy ? <Spinner className="text-white" /> : <Play />} Start
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
