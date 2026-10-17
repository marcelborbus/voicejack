import type { Limits } from '@dub/shared';
import { AlertTriangle, CloudCheck, CloudUpload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAudioContext } from '@/audio/context';
import { Spinner } from '@/components/ui/spinner';
import { Editor } from '@/editor/Editor';
import {
  deleteChunk,
  editorStore,
  patchChunk,
  useEditor,
  type ChunkStatus,
} from '@/editor/editorStore';
import {
  cancelRecording,
  configureRecording,
  onDeadline,
  startRecording,
  stopRecording,
  toggleRecording,
} from '@/editor/recording';
import { restoreFromServer } from '@/editor/restore';
import {
  acquireUploadQueue,
  releaseUploadQueue,
  UploadQueue,
  type UploadState,
} from '@/editor/uploadQueue';
import { toast } from '@/lib/toast';
import { errorText } from '@/net/errors';
import { useRoom, useRoomStore } from '@/state/room';
import { send, setSticky } from '@/state/session';
import { getToken } from '@/state/storage';

const STATUS_OF: Record<UploadState, ChunkStatus> = {
  pending: 'uploading',
  uploading: 'uploading',
  uploaded: 'uploaded',
  failed: 'failed',
};

/** Restore runs once per round per page load (StrictMode runs effects twice). */
const restoredKeys = new Set<string>();

export function Dubbing() {
  const code = useRoom((s) => s.snapshot?.code ?? '');
  const clip = useRoom((s) => s.snapshot?.clip ?? null);
  const round = useRoom((s) => s.snapshot?.round ?? -1);
  const submissionId = useRoom((s) => s.snapshot?.you.submissionId ?? null);

  if (!clip || round < 0 || !code) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-zinc-400">
        <Spinner className="size-8" />
      </div>
    );
  }
  return (
    <DubbingRound
      key={`${code}:${round}:${submissionId}`}
      code={code}
      round={round}
      submissionId={submissionId}
    />
  );
}

function DubbingRound({
  code,
  round,
  submissionId,
}: {
  code: string;
  round: number;
  submissionId: string | null;
}) {
  const clip = useRoom((s) => s.snapshot!.clip!);
  const totalRounds = useRoom((s) => s.snapshot?.totalRounds ?? 0);
  const phaseEndsAt = useRoom((s) => s.snapshot?.phaseEndsAt ?? null);
  const limits = useRoom((s) => s.limits);
  const done = useRoom((s) => {
    const snap = s.snapshot;
    return !!snap?.players.find((p) => p.id === snap.you.playerId)?.dubDone;
  });
  const doneDone = useRoom(
    (s) => s.snapshot?.players.filter((p) => p.connected && p.dubDone).length ?? 0,
  );
  const doneTotal = useRoom((s) => s.snapshot?.players.filter((p) => p.connected).length ?? 0);
  const [expired, setExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const key = `${code}:${round}:${submissionId ?? ''}`;

  const createQueue = useCallback(
    () =>
      new UploadQueue({
        code,
        round,
        deps: {
          fetch: (url, init) => fetch(url, init),
          sendManifest: (r, chunks) => setSticky('manifest', { t: 'manifest', round: r, chunks }),
          getToken: () => getToken(code),
          onState: (id, st) => editorStore.set((s) => patchChunk(s, id, { status: STATUS_OF[st] })),
          onError: (_id, errCode, message) =>
            toast('A take failed to upload', {
              variant: 'error',
              description:
                errCode === 'NETWORK'
                  ? 'Check your connection, then hit retry on the red take.'
                  : errorText(errCode, message),
            }),
        },
      }),
    [code, round],
  );
  // Survives StrictMode's unmount/remount: release only disposes on the next tick, and the
  // effect below re-acquires (cancelling that) before it fires.
  const queue = useMemo(() => acquireUploadQueue(key, createQueue), [key, createQueue]);

  useEffect(() => {
    acquireUploadQueue(key, createQueue);
    configureRecording({ code, round, submissionId, limits, queue });
    return () => {
      cancelRecording();
      configureRecording(null);
      releaseUploadQueue(key, () => setSticky('manifest', null));
    };
  }, [key, code, round, submissionId, limits, queue, createQueue]);

  // Restore own takes after a reload (fresh editor, server has a manifest).
  useEffect(() => {
    if (restoredKeys.has(key) || !submissionId) return;
    restoredKeys.add(key);
    const you = useRoomStore.getState().snapshot?.you;
    if (!you || editorStore.get().chunks.length > 0) return;
    void restoreFromServer({
      code,
      round,
      submissionId,
      manifest: you.manifest,
      uploaded: you.uploaded,
      token: getToken(code),
      ctx: getAudioContext(),
      queue,
    });
  }, [key, code, round, submissionId, queue]);

  const deadline = useCallback(() => {
    setExpired(true);
    void onDeadline();
  }, []);

  const onDone = useCallback(
    async (d: boolean) => {
      if (!d) {
        send({ t: 'dubDone', round, done: false });
        return;
      }
      setSubmitting(true);
      try {
        await stopRecording();
        await queue.whenIdle();
        send({ t: 'dubDone', round, done: true });
      } finally {
        setSubmitting(false);
      }
    },
    [queue, round],
  );

  const onDelete = useCallback(
    (id: string) => {
      editorStore.set((s) => deleteChunk(s, id));
      queue.remove(id);
    },
    [queue],
  );

  const count = useEditor((s) => s.chunks.length);
  const full = count >= limits.maxChunksPerSubmission;

  return (
    <Editor
      clip={clip}
      editorKey={key}
      roundLabel={`Round ${round + 1} of ${totalRounds}`}
      phaseEndsAt={phaseEndsAt}
      done={done}
      doneBusy={submitting}
      doneCount={{ done: doneDone, total: doneTotal }}
      onDone={onDone}
      onRecord={toggleRecording}
      onCancelRecord={cancelRecording}
      onRerecord={(id) => void startRecording(id)}
      onDelete={onDelete}
      onRetry={(id) => queue.retry(id)}
      onDeadline={deadline}
      canRecord={!expired && !full}
      recordHint={
        expired
          ? "Time's up"
          : full
            ? `Limit of ${limits.maxChunksPerSubmission} takes reached`
            : undefined
      }
      status={<UploadStatus />}
      limitsLabel={limitsLabel(count, limits)}
    />
  );
}

function limitsLabel(count: number, limits: Limits): string {
  return `${count}/${limits.maxChunksPerSubmission} takes`;
}

function UploadStatus() {
  const uploading = useEditor((s) => s.chunks.filter((c) => c.status === 'uploading').length);
  const failed = useEditor((s) => s.chunks.filter((c) => c.status === 'failed').length);
  const restoring = useEditor((s) => s.restoring);
  const count = useEditor((s) => s.chunks.length);
  if (restoring)
    return (
      <span
        className="flex items-center gap-1.5 text-zinc-400"
        data-testid="upload-status"
        data-state="restoring"
      >
        <Spinner className="size-3.5" /> Restoring your takes…
      </span>
    );
  if (failed > 0)
    return (
      <span
        className="flex items-center gap-1.5 text-rose-300"
        data-testid="upload-status"
        data-state="failed"
      >
        <AlertTriangle className="size-3.5" /> {failed} not saved
      </span>
    );
  if (uploading > 0)
    return (
      <span
        className="flex items-center gap-1.5 text-zinc-300"
        data-testid="upload-status"
        data-state="uploading"
      >
        <CloudUpload className="size-3.5 animate-pulse" /> Saving…
      </span>
    );
  if (count === 0) return null;
  return (
    <span
      className="flex items-center gap-1.5 text-emerald-300/80"
      data-testid="upload-status"
      data-state="saved"
    >
      <CloudCheck className="size-3.5" /> All saved
    </span>
  );
}
