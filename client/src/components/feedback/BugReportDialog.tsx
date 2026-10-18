import { FEEDBACK_COMMENT_MAX } from '@dub/shared';
import { Bug } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { recentErrorHashes, routeName, sendFeedback } from '@/lib/analytics';
import { toast } from '@/lib/toast';
import { useRoomStore } from '@/state/room';

/** Footer "Report a bug" (V15): a short description + recent error hashes and the route name. */
export function BugReportDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { pathname } = useLocation();
  const route = routeName(pathname);
  const phase = useRoomStore((s) => (route === 'room' ? s.snapshot?.phase : undefined));
  const errors = open ? recentErrorHashes() : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setText('');
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="text-xs text-zinc-400 hover:text-zinc-200"
          data-testid="footer-bug"
        >
          <Bug className="size-3.5" /> Report a bug
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="bug-dialog">
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            What went wrong? This is sent anonymously, without your name, account or room.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            sendFeedback({ kind: 'bug', comment: text, phase });
            setOpen(false);
            setText('');
            toast('Thanks for the report!', { variant: 'success', durationMs: 2500 });
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, FEEDBACK_COMMENT_MAX))}
            maxLength={FEEDBACK_COMMENT_MAX}
            rows={4}
            required
            placeholder="e.g. The video froze in the showcase after the second dub."
            aria-label="Bug description"
            data-testid="bug-text"
            className="w-full resize-none rounded-2xl border-[1.5px] border-white/12 bg-ink-950/70 p-3 text-sm text-zinc-50 placeholder:text-zinc-500 focus-visible:border-fuchsia-400/70 focus-visible:outline-none"
          />
          <p className="text-xs text-zinc-500">
            {text.length}/{FEEDBACK_COMMENT_MAX} · Attached automatically: page “{route}”
            {phase ? `, phase ${phase}` : ''}, app version and{' '}
            {errors.length
              ? `${errors.length} recent error code${errors.length === 1 ? '' : 's'} (${errors.join(', ')})`
              : 'no recent errors'}
            .
          </p>
          <Button type="submit" disabled={!text.trim()} data-testid="bug-send">
            Send report
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
