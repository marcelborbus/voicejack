import type { PlayerPublic } from '@dub/shared';
import { Flag, Headphones, HeadphoneOff, Mic, MicOff, ShieldAlert, UserX } from 'lucide-react';
import { useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useSnapshot } from '@/state/room';
import { send } from '@/state/session';
import { toggleSelfMute, useVoice } from '@/voice/voiceStore';
import { setListenAll, usePublicListen, usePublicVoiceDefaults } from './publicVoice';

const REASONS = ['Hate speech or slurs', 'Harassment', 'Sexual content', 'Spam or trolling'];

/**
 * Public rooms (V08): voice is off until you opt in ("tap to talk" / "tap to listen"), plus
 * report and vote-kick for the other players. Rendered above the phase view in every phase.
 */
export function PublicRoomBar() {
  usePublicVoiceDefaults();
  const selfMuted = useVoice((s) => s.selfMuted);
  const listen = usePublicListen((s) => s.on);
  const allowed = useVoice((s) => s.allowed);
  const [open, setOpen] = useState(false);
  const voiceOff = selfMuted && !listen;

  return (
    <Card data-testid="public-room-bar">
      <CardContent className="flex flex-wrap items-center gap-2 py-3">
        <span
          className={cn(
            'mr-auto text-sm font-semibold',
            voiceOff ? 'text-amber-200' : 'text-emerald-300',
          )}
          data-testid="public-voice-state"
        >
          {voiceOff
            ? 'Voice is off: tap to talk / tap to listen'
            : !allowed
              ? 'Voice pauses while you dub'
              : `Voice: ${selfMuted ? 'mic off' : 'talking'} · ${listen ? 'listening' : 'not listening'}`}
        </span>
        <Button
          size="sm"
          variant={selfMuted ? 'secondary' : 'success'}
          aria-pressed={!selfMuted}
          data-testid="public-talk"
          onClick={toggleSelfMute}
        >
          {selfMuted ? <MicOff /> : <Mic />} {selfMuted ? 'Tap to talk' : 'Talking'}
        </Button>
        <Button
          size="sm"
          variant={listen ? 'success' : 'secondary'}
          aria-pressed={listen}
          data-testid="public-listen"
          onClick={() => setListenAll(!listen)}
        >
          {listen ? <Headphones /> : <HeadphoneOff />} {listen ? 'Listening' : 'Tap to listen'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="public-moderation"
          onClick={() => setOpen(true)}
        >
          <ShieldAlert /> Report / kick
        </Button>
      </CardContent>
      <ModerationDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function ModerationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const snap = useSnapshot();
  const [reporting, setReporting] = useState<PlayerPublic | null>(null);
  if (!snap?.public) return null;
  const pub = snap.public;
  const others = snap.players.filter((p) => p.id !== snap.you.playerId && !p.isBot);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="moderation-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Players</DialogTitle>
          <DialogDescription>
            A majority of the other players ({pub.kickNeeded} vote{pub.kickNeeded === 1 ? '' : 's'})
            removes someone from this game. Reports go to the moderators.
          </DialogDescription>
        </DialogHeader>
        {reporting ? (
          <ReportForm player={reporting} onDone={() => setReporting(null)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {others.length === 0 && <li className="text-sm text-zinc-400">Nobody else here.</li>}
            {others.map((p) => {
              const voted = pub.youKickVoted.includes(p.id);
              const reported = pub.youReported.includes(p.id);
              const votes = pub.kickVotes[p.id] ?? 0;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-2xl border border-white/10 p-2"
                  data-testid="moderation-row"
                  data-player-id={p.id}
                >
                  <PlayerAvatar name={p.name} seed={p.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                  <Button
                    size="sm"
                    variant={voted ? 'destructive' : 'secondary'}
                    aria-pressed={voted}
                    data-testid="vote-kick"
                    onClick={() => send({ t: 'voteKick', playerId: p.id, kick: !voted })}
                  >
                    <UserX /> {voted ? 'Voted' : 'Kick'}
                    {votes > 0 && (
                      <span className="tabular-nums">
                        {votes}/{pub.kickNeeded}
                      </span>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reported}
                    data-testid="report"
                    onClick={() => setReporting(p)}
                  >
                    <Flag /> {reported ? 'Reported' : 'Report'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportForm({ player, onDone }: { player: PlayerPublic; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const text = reason.trim();
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="report-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text) return;
        if (send({ t: 'report', playerId: player.id, reason: text.slice(0, 500) })) {
          toast('Report sent', { variant: 'success', description: 'Thanks for keeping it fun.' });
        }
        onDone();
      }}
    >
      <p className="text-sm">
        Report <b>{player.name}</b> for:
      </p>
      <div className="flex flex-wrap gap-2">
        {REASONS.map((r) => (
          <Button
            key={r}
            type="button"
            size="sm"
            variant={reason === r ? 'default' : 'secondary'}
            onClick={() => setReason(r)}
          >
            {r}
          </Button>
        ))}
      </div>
      <Input
        value={reason}
        maxLength={500}
        placeholder="Or describe what happened"
        data-testid="report-reason"
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Back
        </Button>
        <Button type="submit" variant="destructive" disabled={!text} data-testid="report-send">
          <Flag /> Send report
        </Button>
      </div>
    </form>
  );
}
