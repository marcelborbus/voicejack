import { Check, Copy, Link2, QrCode, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { play } from '@/lib/sfx';
import { canNativeShare, copyText, inviteMessage, inviteUrl } from '@/lib/share';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export { inviteUrl };

function useFlag(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

/**
 * Copies an invite: the fun message (with the link) when `hostName` is given, otherwise the
 * bare link `/r/CODE`.
 */
export function InviteButton({
  code,
  hostName,
  className,
  variant = 'secondary',
  size = 'sm',
  label = 'Copy invite',
  testId = 'invite-copy',
  linkOnly = false,
}: {
  code: string;
  hostName?: string;
  className?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  label?: string;
  testId?: string;
  linkOnly?: boolean;
}) {
  const [copied, flag] = useFlag();
  const url = inviteUrl(code);
  return (
    <Button
      variant={variant}
      size={size}
      className={cn('min-w-0', className)}
      data-testid={testId}
      data-invite-url={url}
      onClick={async () => {
        const text = linkOnly ? url : inviteMessage(hostName, url);
        if (await copyText(text)) {
          flag();
          play('pop');
          toast(linkOnly ? 'Invite link copied' : 'Invite copied', {
            variant: 'success',
            description: 'Paste it in the group chat.',
            durationMs: 2500,
          });
        } else {
          toast('Could not copy', { variant: 'warning', description: url });
        }
      }}
    >
      {copied ? <Check className="text-emerald-300" /> : <Copy />}
      <span className="truncate">{copied ? 'Copied!' : label}</span>
    </Button>
  );
}

/** Read-only invite link field with a copy-link button. */
export function InviteLinkField({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('well flex min-w-0 items-center gap-2 rounded-2xl p-1.5 pl-3', className)}>
      <Link2 className="size-4 shrink-0 text-jack" />
      <span
        data-testid="invite-link"
        className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-300"
      >
        {inviteUrl(code).replace(/^https?:\/\//, '')}
      </span>
      <InviteButton
        code={code}
        label="Copy"
        variant="default"
        testId="invite-field-copy"
        linkOnly
      />
    </div>
  );
}

/** QR code for phones on the same couch (rendered locally by `uqr`, no network). */
export function InviteQr({ code }: { code: string }) {
  const url = inviteUrl(code);
  // #53: the QR encoder is its own chunk, loaded when the dialog opens (or on hover).
  const [svg, setSvg] = useState<string | null>(null);
  const load = () => {
    void import('uqr').then(({ renderSVG }) =>
      setSvg(renderSVG(url, { border: 2, whiteColor: '#ffffff', blackColor: '#170f28' })),
    );
  };
  useEffect(() => setSvg(null), [url]);
  return (
    <Dialog onOpenChange={(open) => open && load()}>
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          data-testid="invite-qr"
          aria-label="Show QR code"
          onPointerEnter={() => void import('uqr')}
        >
          <QrCode /> QR
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm" data-testid="invite-qr-dialog">
        <DialogHeader>
          <DialogTitle>Scan to join</DialogTitle>
          <DialogDescription>
            Point a phone camera at the code to jump into room {code}.
          </DialogDescription>
        </DialogHeader>
        <div
          role="img"
          aria-label={`QR code for ${url}`}
          className="mx-auto mb-1 aspect-square w-full max-w-64 overflow-hidden rounded-2xl border-2 border-[#1a1027] bg-white p-2 shadow-[0_5px_0_rgb(0_0_0/0.45)] [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg ?? '' }}
        />
        <p className="truncate text-center font-mono text-sm text-zinc-300">
          {url.replace(/^https?:\/\//, '')}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Lobby invite block: preview of the message, the link, Copy invite / Share / QR. */
export function InviteCard({ code, hostName }: { code: string; hostName?: string }) {
  const url = inviteUrl(code);
  const message = inviteMessage(hostName, url);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative ml-1 mr-6 self-start">
        <p
          data-testid="invite-message"
          className="rounded-2xl rounded-bl-md border-[1.5px] border-white/10 bg-ink-800 px-3.5 py-2.5 text-sm text-zinc-200 shadow-[0_3px_0_rgb(0_0_0/0.4)]"
        >
          {message.replace(url, '')}
          <span className="break-all text-jack">{url.replace(/^https?:\/\//, '')}</span>
        </p>
        <span className="absolute -top-6 right-0 translate-x-3 font-scribble text-lg text-zinc-400">
          what your friends get
        </span>
      </div>
      <InviteLinkField code={code} />
      <div className="flex flex-wrap gap-2">
        <InviteButton
          code={code}
          hostName={hostName}
          variant="default"
          testId="invite-message-copy"
          label="Copy invite"
        />
        {canNativeShare() && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="invite-share"
            onClick={() => {
              navigator
                .share({ title: 'Voicejack', text: message.replace(url, '').trim(), url })
                .catch(() => {});
            }}
          >
            <Share2 /> Share
          </Button>
        )}
        <InviteQr code={code} />
      </div>
    </div>
  );
}
