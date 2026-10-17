import { useState, type FormEvent, type ReactNode } from 'react';
import { MailCheck } from 'lucide-react';
import { EMAIL_MAX_LENGTH } from '@dub/shared';
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
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { AccountError, requestLoginLink } from './api';

/**
 * Email → magic link. No passwords: the mail's link opens a confirm page on the server, which
 * signs this browser in and comes back to `/?login=ok` (handled by `useLoginResult`).
 */
export function SignInDialog({
  trigger,
  title = 'Sign in',
  description = 'Keep your name and rating across devices. We email you a one-time link; no password.',
}: {
  trigger: ReactNode;
  title?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setState('form');
      setError(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setState('sending');
    try {
      await requestLoginLink(email.trim());
      setState('sent');
    } catch (err) {
      setState('form');
      setError(
        err instanceof AccountError && err.status === 429
          ? 'Too many links requested. Try again in a few minutes.'
          : err instanceof AccountError && err.status === 400
            ? "That doesn't look like an email address."
            : 'Could not send the link. Try again.',
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="signin-dialog">
        {state === 'sent' ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <MailCheck className="size-12 text-fuchsia-300" aria-hidden />
            <DialogTitle>Check your inbox</DialogTitle>
            <DialogDescription>
              We sent a sign-in link to <span className="font-semibold text-zinc-100">{email}</span>
              . It works once and expires in 15 minutes. Nothing there? Check spam.
            </DialogDescription>
            <Button variant="ghost" size="sm" onClick={() => setState('form')}>
              Use a different address
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  maxLength={EMAIL_MAX_LENGTH}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  autoFocus
                />
                {error && (
                  <p role="alert" className="text-sm text-rose-400">
                    {error}
                  </p>
                )}
              </div>
              <Button type="submit" disabled={state === 'sending' || !email.trim()}>
                {state === 'sending' && <Spinner />} Email me a link
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
