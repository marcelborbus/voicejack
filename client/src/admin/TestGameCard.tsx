import { Bot, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
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
import { toast } from '@/lib/toast';
import { useMe } from '@/state/me';
import { setToken } from '@/state/storage';
import { adminApi } from './api';

const FIELD = 'flex flex-col gap-1 text-sm font-semibold';
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
  const [secs, setSecs] = useState(20);
  const [busy, setBusy] = useState(false);
  const usable = libraries.filter((l) => !l.disabled && l.clipCount > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await adminApi.testRoom({
        bots,
        rounds,
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
          library. Not counted in analytics or Elo. The first start after a deploy or library change
          can take a little while: the bot voices are cut from the clips then.
        </p>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]" onSubmit={submit}>
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
          <label className={FIELD}>
            Dubbing time (s)
            <Input
              type="number"
              min={SHORT_DUBBING_MIN_SECONDS}
              max={DUBBING_SECONDS_RANGE.max}
              value={secs}
              onChange={(e) => setSecs(Number(e.target.value))}
              data-testid="test-game-seconds"
            />
          </label>
          <Button type="submit" className="self-end" disabled={busy} data-testid="test-game-start">
            {busy ? <Spinner className="text-white" /> : <Play />} Start
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
