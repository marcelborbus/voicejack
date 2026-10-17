import type { ClipInfo } from '@dub/shared';
import { Flag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { myApi, officialLibraries } from './api';

/** Library id of a library clip URL (`/clips/<libraryId>/<file>`), null for built-in URLs. */
function libraryOf(url: string): string | null {
  const m = /^\/clips\/([^/]+)\/[^/]+$/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * V06 "Report clip": shown next to the credit line of clips from a host's private library
 * (anything that is not an official library). Sends the report to the admin.
 */
export function ReportClipButton({ clip }: { clip: ClipInfo }) {
  const lib = libraryOf(clip.url);
  const [isPrivate, setPrivate] = useState(false);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!lib) return;
    let live = true;
    void officialLibraries().then((list) => {
      if (live) setPrivate(!list.some((l) => l.id === lib));
    });
    return () => {
      live = false;
    };
  }, [lib]);

  if (!lib || !isPrivate) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 shrink-0 px-2 text-xs text-zinc-500 hover:text-rose-300"
          disabled={sent}
          data-testid="report-clip"
        >
          <Flag className="size-3" /> {sent ? 'Reported' : 'Report clip'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report “{clip.title}”</DialogTitle>
          <DialogDescription>
            This clip was uploaded by the host. Tell us what is wrong with it (for example: it
            infringes your rights, or it is offensive). The site owner reviews every report.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const r = reason.trim();
            if (!r) return;
            setBusy(true);
            myApi
              .reportClip(clip.id, r)
              .then(
                () => {
                  setSent(true);
                  setOpen(false);
                  toast('Thanks, the clip was reported', { variant: 'success' });
                },
                (err: Error) =>
                  toast('Could not report the clip', {
                    description: err.message,
                    variant: 'error',
                  }),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="What is wrong with this clip?"
            required
          />
          <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
            <Flag /> Send report
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
