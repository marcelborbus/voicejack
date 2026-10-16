import { Check, Copy, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function inviteUrl(code: string): string {
  return `${location.origin}/r/${code}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts (plain http on a LAN IP).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Copies the invite link `/r/CODE`. */
export function InviteButton({
  code,
  className,
  variant = 'secondary',
  size = 'sm',
  label = 'Copy invite link',
  testId = 'invite-copy',
}: {
  code: string;
  className?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  label?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size={size}
      className={cn('min-w-0', className)}
      data-testid={testId}
      data-invite-url={inviteUrl(code)}
      onClick={async () => {
        if (await copyText(inviteUrl(code))) {
          setCopied(true);
          toast('Invite link copied', { variant: 'success', description: 'Send it to your friends.', durationMs: 2500 });
        } else {
          toast('Could not copy', { variant: 'warning', description: inviteUrl(code) });
        }
      }}
    >
      {copied ? <Check className="text-emerald-300" /> : <Copy />}
      <span className="truncate">{copied ? 'Copied!' : label}</span>
    </Button>
  );
}

/** Read-only invite link field with a copy button. */
export function InviteLinkField({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-zinc-950/60 p-1.5 pl-3', className)}>
      <Link2 className="size-4 shrink-0 text-fuchsia-300" />
      <span data-testid="invite-link" className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-300">
        {inviteUrl(code).replace(/^https?:\/\//, '')}
      </span>
      <InviteButton code={code} label="Copy" variant="default" testId="invite-field-copy" />
    </div>
  );
}
