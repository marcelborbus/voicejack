import { useEffect, useState, type FormEvent } from 'react';
import { LogIn, LogOut, Trash2 } from 'lucide-react';
import { NAME_MAX_LENGTH } from '@dub/shared';
import { PlayerAvatar } from '@/components/PlayerAvatar';
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
import { Separator } from '@/components/ui/separator';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { loadMe, useMe } from '@/state/me';
import { deleteAccount, logout, rename } from './api';
import { SignInDialog } from './SignInDialog';

/** Shows a toast for `?login=ok|invalid` (the verify redirect) and strips the param. */
export function useLoginResult(): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const res = url.searchParams.get('login');
    if (!res) return;
    url.searchParams.delete('login');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    if (res === 'ok') {
      void loadMe(true);
      toast("You're signed in", { variant: 'success' });
    } else {
      toast('That sign-in link expired or was already used', {
        description: 'Request a new one.',
        variant: 'warning',
      });
    }
  }, []);
}

/** Header account control (V04): "Sign in" for guests, the account dialog when registered. */
export function AccountMenu({ className }: { className?: string }) {
  useLoginResult();
  const user = useMe((s) => s.user);
  if (!user) return null;
  if (user.kind === 'guest') {
    return (
      <div className={cn('ml-auto', className)}>
        <SignInDialog
          trigger={
            <Button variant="outline" size="sm" data-testid="signin-button">
              <LogIn /> Sign in
            </Button>
          }
        />
      </div>
    );
  }
  return <AccountDialog className={cn('ml-auto', className)} />;
}

function AccountDialog({ className }: { className?: string }) {
  const user = useMe((s) => s.user)!;
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(user.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const label = user.displayName || 'Account';

  useEffect(() => {
    if (open) setName(user.displayName ?? '');
  }, [open, user.displayName]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, { variant: 'success' });
      return true;
    } catch {
      toast('Something went wrong', { description: 'Try again in a moment.', variant: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onRename = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === user.displayName) return;
    await run(() => rename(n), 'Name saved');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('max-w-[12rem] gap-2 px-2', className)}
            data-testid="account-button"
          >
            <PlayerAvatar name={user.displayName || '?'} size="xs" />
            <span className="truncate">{label}</span>
          </Button>
        </DialogTrigger>
        <DialogContent data-testid="account-dialog">
          <DialogHeader>
            <DialogTitle>Your account</DialogTitle>
            <DialogDescription>
              Signed in as <span className="font-semibold text-zinc-100">{user.email}</span>
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-2" onSubmit={onRename}>
            <Label htmlFor="account-name">Display name</Label>
            <div className="flex gap-2">
              <Input
                id="account-name"
                value={name}
                maxLength={NAME_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
              <Button
                type="submit"
                variant="secondary"
                className="h-12"
                disabled={busy || !name.trim() || name.trim() === user.displayName}
              >
                Save
              </Button>
            </div>
          </form>
          <Separator className="my-5" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (await run(logout, 'Signed out')) setOpen(false);
              }}
            >
              <LogOut /> Sign out
            </Button>
            <Button
              variant="ghost"
              className="text-rose-400 hover:text-rose-300"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 /> Delete account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent data-testid="delete-account-dialog">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              Your email, name and rating are removed and you are signed out everywhere. This
              can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (await run(deleteAccount, 'Account deleted')) {
                  setConfirmDelete(false);
                  setOpen(false);
                }
              }}
            >
              Delete account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
