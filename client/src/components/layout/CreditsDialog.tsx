import { Film } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function CreditsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="text-xs text-zinc-400 hover:text-zinc-200"
          data-testid="credits-link"
        >
          <Film className="size-3.5" /> Clip credits &amp; licenses
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clip credits</DialogTitle>
          <DialogDescription>
            Every clip we ship may be freely redistributed. The exact author, source and license of
            each clip is shown next to it during the game.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-sm text-zinc-300">
          <li className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="font-semibold text-zinc-100">Blender Foundation open movies</p>
            <p className="text-zinc-400">
              Big Buck Bunny, Sintel, Tears of Steel, Elephants Dream. ©Blender Foundation,{' '}
              <a
                className="text-fuchsia-300 underline-offset-4 hover:underline"
                href="https://creativecommons.org/licenses/by/3.0/"
                target="_blank"
                rel="noreferrer"
              >
                CC BY
              </a>
              , via blender.org.
            </p>
          </li>
          <li className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="font-semibold text-zinc-100">Public-domain films</p>
            <p className="text-zinc-400">
              Classic films whose copyright has lapsed, via the Internet Archive.
            </p>
          </li>
          <li className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="font-semibold text-zinc-100">Your own clips</p>
            <p className="text-zinc-400">
              Private servers may add their own clips; those stay on that server.
            </p>
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
