import { Link, Outlet } from 'react-router';
import { AccountMenu } from '@/components/account';
import { FriendsOverlay } from '@/components/friends';
import { Logo } from '@/components/Logo';
import { SoundToggle } from '@/components/SoundToggle';
import { Backdrop } from './Backdrop';
import { CreditsDialog } from './CreditsDialog';

/** App frame: logo header, page outlet, attribution footer.  */
export function Shell() {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <Backdrop />
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 pb-2 pt-4 sm:px-6 sm:pt-6">
        <Link
          to="/"
          className="rounded-2xl transition-opacity hover:opacity-90"
          aria-label="Voicejack home"
        >
          <Logo />
        </Link>
        <AccountMenu />
        <SoundToggle />
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 pb-6 pt-2 text-xs text-zinc-500 sm:px-6">
        <span>Made for friends who can't do voices. Do them anyway.</span>
        <CreditsDialog />
      </footer>
      <FriendsOverlay />
    </div>
  );
}
