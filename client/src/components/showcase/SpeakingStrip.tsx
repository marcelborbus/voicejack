import type { PlayerId, PlayerPublic } from '@dub/shared';
import { useEffect, useRef } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { cn } from '@/lib/utils';
import { useRoom } from '@/state/room';
import { useVoice, type VoiceState } from '@/voice/voiceStore';

const EMPTY: PlayerPublic[] = [];

/** Whether `id` is speaking right now (self: own mic level, others and bots: the meter). */
export function isSpeaking(v: VoiceState, id: PlayerId, selfId: PlayerId | undefined): boolean {
  return id === selfId ? v.selfSpeaking : !!v.speaking[id];
}

/**
 * #51: who is talking while you vote. A compact strip of every player in the room (bots too),
 * so it says nothing about who made the dub on screen. The speaking state is written straight
 * to `data-speaking` on each chip from a store subscription: no React render per meter tick,
 * and the indicator itself is CSS (a ring plus three bars).
 */
export function SpeakingStrip({ className }: { className?: string }) {
  const players = useRoom((s) => s.snapshot?.players ?? EMPTY);
  const selfId = useRoom((s) => s.snapshot?.you.playerId);
  const active = useVoice((s) => s.active);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = players.filter((p) => p.connected);

  useEffect(() => {
    const apply = (v: VoiceState) => {
      const ul = listRef.current;
      if (!ul) return;
      for (const li of ul.children) {
        const el = li as HTMLElement;
        const id = el.dataset.playerId;
        if (!id) continue;
        const on = String(isSpeaking(v, id, selfId));
        if (el.dataset.speaking !== on) el.dataset.speaking = on;
      }
    };
    apply(useVoice.getState());
    return useVoice.subscribe(apply);
  }, [selfId, shown.length, players]);

  if (!active || shown.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="speaking-strip">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">In voice</p>
      <ul ref={listRef} className="flex flex-wrap gap-1.5">
        {shown.map((p) => (
          <li
            key={p.id}
            data-testid="speaking-strip-player"
            data-player-id={p.id}
            data-speaking="false"
            data-bot={p.isBot ? 'true' : undefined}
            title={p.id === selfId ? `${p.name} (you)` : p.name}
            className={cn(
              'speaking-chip group inline-flex max-w-[9rem] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] py-0.5 pl-0.5 pr-2 text-xs text-zinc-300',
            )}
          >
            <PlayerAvatar name={p.name} size="xs" className="shadow-none" />
            <span className="truncate">{p.id === selfId ? 'You' : p.name}</span>
            <span className="speaking-bars inline-flex h-3 items-end gap-[2px]" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
