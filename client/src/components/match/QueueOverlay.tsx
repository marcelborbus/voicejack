import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePresenceCounts } from '@/net/presence';
import { leaveQueue, useQueue } from './queueStore';

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Finding players… N looking", elapsed time, Cancel (V08). Open while queued. */
export function QueueOverlay() {
  const status = useQueue((s) => s.status);
  const since = useQueue((s) => s.since);
  const size = useQueue((s) => s.size);
  const ranked = useQueue((s) => s.mode === 'ranked');
  const counts = usePresenceCounts();
  const [now, setNow] = useState(() => Date.now());
  const open = status !== 'idle';
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [open]);
  const looking = Math.max(size, counts?.lookingForGame ?? 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && leaveQueue()}>
      <DialogContent data-testid="queue-overlay" className="max-w-sm">
        <DialogHeader className="items-center text-center">
          <Loader2 className="size-10 animate-spin text-brand" aria-hidden />
          <DialogTitle>{ranked ? 'Finding a ranked match…' : 'Finding players…'}</DialogTitle>
          <DialogDescription>
            <span data-testid="queue-looking" className="tabular-nums">
              {looking} looking
            </span>
            {' · '}
            <span data-testid="queue-elapsed" className="tabular-nums">
              {mmss(since ? now - since : 0)}
            </span>
          </DialogDescription>
        </DialogHeader>
        <p className="text-center text-sm text-zinc-400">
          {ranked
            ? 'Ranked looks for players near your rating first and widens the search the longer you wait.'
            : 'Games start with 3–6 players.'}{' '}
          Voice chat with strangers is off until you turn it on.
        </p>
        <Button variant="secondary" data-testid="queue-cancel" onClick={leaveQueue}>
          <X /> Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
