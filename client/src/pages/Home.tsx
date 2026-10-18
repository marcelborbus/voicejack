import { NAME_MAX_LENGTH, ROOM_CODE_LENGTH } from '@dub/shared';
import { ArrowRight, Dices, DoorOpen, Mic, PartyPopper, Trophy, Unplug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { unlockAudio } from '@/audio/context';
import { CurlyArrow, Sparkle, Squiggle } from '@/components/doodles';
import { FriendsPanel } from '@/components/friends';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { OnlineCount, RandomGameButton } from '@/components/presence';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { randomSillyName } from '@/lib/avatar';
import { play } from '@/lib/sfx';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ApiRequestError, createRoom, getRoomInfo } from '@/net/api';
import { errorText } from '@/net/errors';
import { normalizeRoomCode, saveName, setToken } from '@/state/storage';
import { usePlayerName } from '@/state/me';
import { RoomOnlyNameHint } from '@/components/RoomOnlyNameHint';

type Tab = 'create' | 'join';

export function Home() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('create');
  const { name, setName, accountName } = usePlayerName();
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
      setError(
        code === 'ROOM_FULL'
          ? 'The server is full right now. Try again in a bit.'
          : errorText(code),
      );
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
        setError(
          info.playerCount >= info.maxPlayers
            ? errorText('ROOM_FULL')
            : errorText('GAME_IN_PROGRESS'),
        );
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
      <section className="relative animate-fade-up">
        <p className="tape mb-5">A party game for 2–8 friends</p>
        <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl lg:text-7xl">
          Hijack the voices of{' '}
          <span className="relative inline-block -rotate-[1.5deg]">
            <span className="text-brand">famous movie clips.</span>
            <Squiggle className="absolute -bottom-3 left-0 text-orange-400/90" />
          </span>
        </h1>
        <Sparkle className="absolute -top-2 right-4 hidden size-9 animate-sway text-sun sm:block lg:right-16" />
        <p className="mt-7 max-w-md text-lg text-zinc-300">
          Everyone gets the same scene and three and a half minutes to redo it with their own voice.
          Then the dubs play back anonymously and the whole room votes.
        </p>
        <ol className="mt-8 grid max-w-lg grid-cols-3 gap-2 sm:gap-3">
          {(
            [
              [Unplug, 'Jack in', 'Send one link', 'text-jack'],
              [Mic, 'Dub', 'Record in layers', 'text-pink-300'],
              [Trophy, 'Vote', 'Rate 0–10', 'text-sun'],
            ] as const
          ).map(([Icon, title, sub, color], i) => (
            <li
              key={title}
              style={{ rotate: `${[-1.5, 1, -0.5][i]}deg` }}
              className="flex items-center gap-2 rounded-2xl border-[1.5px] border-white/10 bg-ink-900 px-2.5 py-2 shadow-[0_4px_0_rgb(0_0_0/0.45)] sm:gap-3 sm:px-3 sm:py-2.5"
            >
              <span className="hidden font-display text-2xl font-extrabold text-zinc-500 sm:inline">{i + 1}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold text-zinc-100">
                  <Icon className={cn('size-4', color)} /> {title}
                </span>
                <span className="hidden text-xs text-zinc-400 sm:block">{sub}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-7 hidden items-center gap-2 font-scribble text-2xl text-zinc-300 lg:flex">
          free, no sign-up, just bring a mic
          <CurlyArrow className="-rotate-12 text-fuchsia-300" />
        </p>
      </section>

      <Card className="animate-fade-up [animation-delay:80ms] lg:rotate-[0.6deg]">
        <CardContent className="flex flex-col gap-6">
          <div role="tablist" className="well grid grid-cols-2 gap-1 rounded-2xl p-1">
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
                  tab === id
                    ? 'bg-ink-700 text-white shadow-[0_3px_0_rgb(0_0_0/0.4)]'
                    : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                <Icon
                  className={cn(
                    'size-4',
                    tab === id && (id === 'create' ? 'text-fuchsia-300' : 'text-orange-300'),
                  )}
                />
                {label}
              </button>
            ))}
          </div>

          <form
            key={tab}
            onSubmit={tab === 'create' ? onCreate : onJoin}
            className="flex animate-fade-in flex-col gap-4"
          >
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
                  className="h-16 text-center font-mono text-3xl font-bold uppercase tracking-[0.4em] placeholder:tracking-[0.4em] placeholder:text-ink-700"
                  maxLength={64}
                  aria-invalid={code.length >= ROOM_CODE_LENGTH && !normalizedCode}
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Your name</Label>
              <div className="flex items-center gap-3">
                <span data-testid="avatar-preview" className="relative">
                  <PlayerAvatar name={trimmed} mystery={!trimmed} size="md" className="size-12" />
                </span>
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="name"
                    data-testid={tab === 'create' ? 'name-input' : 'join-name-input'}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Morgan Freeman"
                    maxLength={NAME_MAX_LENGTH}
                    autoComplete="nickname"
                    autoFocus={tab === 'create'}
                    className="pr-12"
                  />
                  <button
                    type="button"
                    data-testid="name-dice"
                    aria-label="Suggest a silly name"
                    title="Suggest a silly name"
                    onClick={() => {
                      setName(randomSillyName());
                      play('pop');
                    }}
                    className="absolute right-1.5 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-sun active:animate-wiggle"
                  >
                    <Dices className="size-5" />
                  </button>
                </div>
              </div>
              <p className="font-scribble text-lg leading-none text-zinc-400">
                your name picks your face. Roll the dice!
              </p>
              <RoomOnlyNameHint accountName={accountName} />
            </div>
            {error && (
              <p
                role="alert"
                data-testid="home-error"
                className="animate-fade-in rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
              >
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
              {tab === 'create' && <OnlineCount />}
              {!busy && <ArrowRight />}
            </Button>
            <p className="text-center text-xs text-zinc-500">
              {tab === 'create'
                ? "You'll get an invite link to share. Everyone needs a microphone."
                : 'Got a link instead? Just open it.'}
            </p>
          </form>
          <RandomGameButton name={trimmed} />
        </CardContent>
      </Card>
      <FriendsPanel className="lg:col-span-2" />
    </div>
  );
}
