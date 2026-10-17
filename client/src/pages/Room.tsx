import { NAME_MAX_LENGTH, type Phase, type RoomInfoResponse } from '@dub/shared';
import { ArrowRight, Ban, DoorOpen, Home as HomeIcon, LogOut, Users, WifiOff } from 'lucide-react';
import { useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { unlockAudio } from '@/audio/context';
import { releaseMic } from '@/audio/mic';
import { SoundUnlockOverlay } from '@/audio/SoundUnlockOverlay';
import { InviteButton } from '@/components/InviteButton';
import { LoadingQuip } from '@/components/LoadingQuip';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { play, setSfxSuppressed } from '@/lib/sfx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getRoomInfo } from '@/net/api';
import { errorText } from '@/net/errors';
import { useRoom } from '@/state/room';
import { joinRoom, leaveRoom, releaseRoom } from '@/state/session';
import { getSavedName, getToken, normalizeRoomCode, saveName } from '@/state/storage';
import { Dubbing } from './phases/Dubbing';
import { Final } from './phases/Final';
import { Lobby } from './phases/Lobby';
import { RoundResults } from './phases/RoundResults';
import { Showcase } from './phases/Showcase';
import { VoiceDock, VoiceProvider } from '@/voice/VoiceProvider';

const PHASES: Record<Phase, ComponentType> = {
  LOBBY: Lobby,
  DUBBING: Dubbing,
  SHOWCASE: Showcase,
  ROUND_RESULTS: RoundResults,
  FINAL: Final,
};

/**
 * `/r/:code`. Without a stored token it asks for a name first; then it holds the room session
 * for as long as the page is mounted and switches on the phase.
 */
export function Room() {
  const params = useParams();
  const code = normalizeRoomCode(params.code ?? '');
  const location = useLocation();
  const navName = (location.state as { name?: string } | null)?.name;
  // Name used for the first hello when there is no token. `null` = ask for it.
  const [joinName, setJoinName] = useState<string | null>(() =>
    code && !getToken(code) && navName ? navName : null,
  );
  const [attempt, setAttempt] = useState(0);
  const hasToken = code ? !!getToken(code) : false;
  const canConnect = !!code && (hasToken || joinName !== null);

  useEffect(() => {
    if (!code || !canConnect) return;
    joinRoom(code, { name: joinName ?? undefined });
    return () => releaseRoom();
  }, [code, canConnect, joinName, attempt]);

  const fatal = useRoom((s) => (s.code === code ? s.fatal : null));
  const phase = useRoom((s) => (s.code === code ? (s.snapshot?.phase ?? null) : null));

  // UI sounds: a whoosh on each phase change; silent while dubbing (mics are hot).
  useEffect(() => {
    setSfxSuppressed(phase === 'DUBBING');
    if (phase && phase !== 'DUBBING') play('whoosh');
    return () => setSfxSuppressed(false);
  }, [phase]);

  if (!code) return <Navigate to="/" replace />;

  if (fatal?.code === 'BAD_TOKEN' || (!canConnect && !fatal)) {
    return (
      <NamePrompt
        code={code}
        notice={fatal?.code === 'BAD_TOKEN' ? errorText('BAD_TOKEN') : undefined}
        onSubmit={(name) => {
          setJoinName(name);
          setAttempt((a) => a + 1);
        }}
      />
    );
  }
  if (fatal) return <FatalScreen code={fatal.code} message={fatal.message} />;
  if (!phase) return <Connecting />;

  const PhaseView = PHASES[phase];
  return (
    <div className="flex flex-col gap-6">
      <RoomHeader code={code} />
      <VoiceProvider />
      <SoundUnlockOverlay />
      <div key={phase} className="animate-fade-up">
        <PhaseView />
      </div>
    </div>
  );
}

function RoomHeader({ code }: { code: string }) {
  const navigate = useNavigate();
  const status = useRoom((s) => s.status);
  const round = useRoom((s) => s.snapshot?.round ?? -1);
  const totalRounds = useRoom((s) => s.snapshot?.totalRounds ?? 0);
  const playerCount = useRoom((s) => s.snapshot?.players.length ?? 0);
  const phase = useRoom((s) => s.snapshot?.phase);
  const hostName = useRoom(
    (s) => s.snapshot?.players.find((p) => p.id === s.snapshot?.hostId)?.name,
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-baseline gap-2 rounded-2xl border-[1.5px] border-white/10 bg-ink-900 px-3.5 py-2 shadow-[0_4px_0_rgb(0_0_0/0.45)]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
            Room
          </span>
          <span
            data-testid="room-code"
            className="font-mono text-lg font-bold tracking-[0.2em] text-zinc-100"
          >
            {code}
          </span>
        </div>
        <Badge variant="secondary" className="hidden sm:inline-flex">
          <Users /> {playerCount}
        </Badge>
        {phase !== 'LOBBY' && round >= 0 && (
          <Badge variant="accent" data-testid="round-badge">
            Round {round + 1}/{totalRounds}
          </Badge>
        )}
        {status !== 'open' && (
          <Badge variant="warning" data-testid="conn-status" className="animate-fade-in">
            <WifiOff /> Reconnecting…
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <VoiceDock />
        <InviteButton code={code} hostName={hostName} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Leave room"
              data-testid="leave-room"
              onClick={() => {
                leaveRoom();
                releaseMic();
                navigate('/');
              }}
            >
              <LogOut />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Leave room</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function NamePrompt({
  code,
  notice,
  onSubmit,
}: {
  code: string;
  notice?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(getSavedName);
  const [info, setInfo] = useState<RoomInfoResponse | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getRoomInfo(code)
      .then((r) => alive && setInfo(r))
      .catch((e: { code?: string }) => alive && setInfoError(errorText(e.code ?? 'NETWORK')));
    return () => {
      alive = false;
    };
  }, [code]);

  const trimmed = name.trim();
  const blocked = info && !info.joinable;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    unlockAudio(); // inside the click gesture
    saveName(trimmed);
    onSubmit(trimmed);
  }

  if (infoError) return <FatalScreen code="ROOM_NOT_FOUND" message={infoError} />;

  return (
    <div className="flex flex-1 items-center justify-center">
      <Card className="w-full max-w-md animate-fade-up">
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-14 -rotate-6 items-center justify-center rounded-3xl border-2 border-[#1a1027] bg-brand shadow-[0_4px_0_rgb(0_0_0/0.5)]">
              <DoorOpen className="size-7 text-white" />
            </span>
            <div className="flex flex-col items-center gap-2">
              <p className="font-scribble text-2xl text-zinc-300">psst, you're invited to</p>
              <p className="tape px-4 py-1 font-mono text-2xl tracking-[0.25em]">{code}</p>
            </div>
            {info && (
              <Badge variant={blocked ? 'danger' : 'secondary'}>
                <Users /> {info.playerCount}/{info.maxPlayers} players
                {info.phase !== 'LOBBY' && ' · game running'}
              </Badge>
            )}
          </div>
          {notice && (
            <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{notice}</p>
          )}
          {blocked ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-zinc-300">
                {info.playerCount >= info.maxPlayers
                  ? errorText('ROOM_FULL')
                  : errorText('GAME_IN_PROGRESS')}
              </p>
              <Button asChild variant="secondary">
                <Link to="/">
                  <HomeIcon /> Back home
                </Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="room-name">Your name</Label>
                <div className="flex items-center gap-3">
                  <PlayerAvatar name={trimmed} mystery={!trimmed} />
                  <Input
                    id="room-name"
                    data-testid="room-name-input"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Morgan Freeman"
                    maxLength={NAME_MAX_LENGTH}
                    autoComplete="nickname"
                  />
                </div>
              </div>
              <Button type="submit" size="xl" data-testid="room-join" disabled={!trimmed || !info}>
                {!info ? <Spinner className="text-white" /> : null}
                Join the party <ArrowRight />
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FatalScreen({ code, message }: { code: string; message: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid="fatal-screen"
      data-code={code}
    >
      <Card className="w-full max-w-md animate-fade-up">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="inline-flex size-14 -rotate-6 items-center justify-center rounded-3xl bg-rose-500/15 ring-2 ring-rose-500/40">
            <Ban className="size-7 text-rose-300" />
          </span>
          <h2 className="font-display text-2xl font-bold">
            {code === 'KICKED'
              ? 'You were removed'
              : code === 'ROOM_NOT_FOUND'
                ? 'This scene got cut'
                : "Can't join"}
          </h2>
          <p className="text-zinc-400">{errorText(code, message)}</p>
          <div className="flex gap-2">
            {code === 'VERSION' ? (
              <Button onClick={() => location.reload()}>Reload</Button>
            ) : (
              <Button asChild>
                <Link to="/">
                  <HomeIcon /> Back home
                </Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Connecting() {
  return <LoadingQuip testId="connecting" title="Joining the party…" className="flex-1 py-16" />;
}
