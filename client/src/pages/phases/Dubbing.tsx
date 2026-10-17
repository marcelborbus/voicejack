import { Spinner } from '@/components/ui/spinner';
import { Editor } from '@/editor/Editor';
import { useRoom } from '@/state/room';
import { send } from '@/state/session';

export function Dubbing() {
  const code = useRoom((s) => s.snapshot?.code ?? '');
  const clip = useRoom((s) => s.snapshot?.clip ?? null);
  const round = useRoom((s) => s.snapshot?.round ?? -1);
  const totalRounds = useRoom((s) => s.snapshot?.totalRounds ?? 0);
  const phaseEndsAt = useRoom((s) => s.snapshot?.phaseEndsAt ?? null);
  const submissionId = useRoom((s) => s.snapshot?.you.submissionId ?? null);
  const done = useRoom((s) => {
    const snap = s.snapshot;
    return !!snap?.players.find((p) => p.id === snap.you.playerId)?.dubDone;
  });
  const doneDone = useRoom((s) => s.snapshot?.players.filter((p) => p.connected && p.dubDone).length ?? 0);
  const doneTotal = useRoom((s) => s.snapshot?.players.filter((p) => p.connected).length ?? 0);

  if (!clip || round < 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-zinc-400">
        <Spinner className="size-8" />
      </div>
    );
  }

  return (
    <Editor
      key={`${code}:${round}`}
      clip={clip}
      editorKey={`${code}:${round}:${submissionId ?? ''}`}
      roundLabel={`Round ${round + 1} of ${totalRounds}`}
      phaseEndsAt={phaseEndsAt}
      done={done}
      doneCount={{ done: doneDone, total: doneTotal }}
      onDone={(d) => send({ t: 'dubDone', round, done: d })}
    />
  );
}
