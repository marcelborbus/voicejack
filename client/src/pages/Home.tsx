import { NAME_MAX_LENGTH, ROOM_CODE_LENGTH } from '@dub/shared';
import { ArrowRight, DoorOpen, Mic, PartyPopper, Sparkles, Trophy, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { unlockAudio } from '@/audio/context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ApiRequestError, createRoom, getRoomInfo } from '@/net/api';
import { errorText } from '@/net/errors';
import { getSavedName, normalizeRoomCode, saveName, setToken } from '@/state/storage';

type Tab = 'create' | 'join';

export function Home() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('create');
  const [name, setName] = useState(getSavedName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const normalizedCode = normalizeRoomCode(code);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    unlockAudio(); // inside the click gesture
    setBusy(true);
    setError(null);
    try {
      const res = await createRoom(trimmed);
      saveName(trimmed);
      setToken(res.code, res.token);
      navigate(`/r/${res.code}`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'NETWORK';
      setError(code === 'ROOM_FULL' ? 'The server is full right now. Try again in a bit.' : errorText(code));
    } finally {
      setBusy(false);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || !normalizedCode || busy) return;
    unlockAudio();
    setBusy(true);
    setError(null);
    try {
      const info = await getRoomInfo(normalizedCode);
      if (!info.joinable) {
        setError(info.playerCount >= info.maxPlayers ? errorText('ROOM_FULL') : errorText('GAME_IN_PROGRESS'));
        return;
      }
      saveName(trimmed);
      navigate(`/r/${normalizedCode}`, { state: { name: trimmed } });
    } catch (err) {
      const c = err instanceof ApiRequestError ? err.code : 'NETWORK';
      setError(errorText(c));
      if (c === 'NETWORK') toast(errorText(c), { variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid flex-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
      <section className="animate-fade-up">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold text-zinc-300">
          <Sparkles className="size-3.5 text-orange-300" /> A party game for 2–8 friends
        </p>
        <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl lg:text-7xl">
          Everyone dubs
          <br />
          <span className="text-brand">the same scene.</span>
        </h1>
        <p className="mt-5 max-w-md text-lg text-zinc-400">
          One famous clip, three and a half minutes, your voice only. Then the dubs play back anonymously and
          everyone votes.
        </p>
        <ul className="mt-8 grid max-w-md gap-3 text-sm text-zinc-300 sm:grid-cols-3">
          <li className="flex items-center gap-2">
            <Users className="size-4 text-fuchsia-300" /> Voice lobby
          </li>
          <li className="flex items-center gap-2">
            <Mic className="size-4 text-pink-300" /> Record in layers
          </li>
          <li className="flex items-center gap-2">
            <Trophy className="size-4 text-orange-300" /> Vote 0–10
          </li>
        </ul>
      </section>

      <Card className="animate-fade-up [animation-delay:80ms]">
        <CardContent className="flex flex-col gap-6">
          <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl border border-white/[0.06] bg-zinc-950/60 p-1">
            {(
              [
                ['create', 'Start a party', PartyPopper],
                ['join', 'Join with code', DoorOpen],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                data-testid={`tab-${id}`}
                onClick={() => {
                  setTab(id);
                  setError(null);
                }}
                className={cn(
                  'flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all',
                  tab === id ? 'bg-zinc-800 text-white shadow-md shadow-black/30' : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                <Icon className={cn('size-4', tab === id && (id === 'create' ? 'text-fuchsia-300' : 'text-orange-300'))} />
                {label}
              </button>
            ))}
          </div>

          <form key={tab} onSubmit={tab === 'create' ? onCreate : onJoin} className="flex animate-fade-in flex-col gap-4">
            {tab === 'join' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="code">Room code</Label>
                <Input
                  id="code"
                  data-testid="join-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ABC123"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  autoFocus
                  className="h-16 text-center font-mono text-3xl font-bold uppercase tracking-[0.4em] placeholder:tracking-[0.4em] placeholder:text-zinc-700"
                  maxLength={64}
                  aria-invalid={code.length >= ROOM_CODE_LENGTH && !normalizedCode}
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                data-testid={tab === 'create' ? 'name-input' : 'join-name-input'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Morgan Freeman"
                maxLength={NAME_MAX_LENGTH}
                autoComplete="nickname"
                autoFocus={tab === 'create'}
              />
            </div>
            {error && (
              <p role="alert" data-testid="home-error" className="animate-fade-in rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                {error}
              </p>
            )}
            <Button
              type="submit"
              size="xl"
              data-testid={tab === 'create' ? 'create-room' : 'join-room'}
              disabled={!trimmed || busy || (tab === 'join' && !normalizedCode)}
              className="mt-1"
            >
              {busy ? <Spinner className="text-white" /> : null}
              {tab === 'create' ? 'Create room' : 'Join room'}
              {!busy && <ArrowRight />}
            </Button>
            <p className="text-center text-xs text-zinc-500">
              {tab === 'create'
                ? "You'll get an invite link to share. Everyone needs a microphone."
                : 'Got a link instead? Just open it.'}
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
