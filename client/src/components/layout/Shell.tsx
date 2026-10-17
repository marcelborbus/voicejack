import { Link, Outlet, useLocation } from 'react-router';
import { AccountMenu } from '@/components/account';
import { FriendsOverlay } from '@/components/friends';
import { Logo } from '@/components/Logo';
import { SoundToggle } from '@/components/SoundToggle';
import { HomeSupport, SupportLink } from '@/components/support';
import { Backdrop } from './Backdrop';
import { CreditsDialog } from './CreditsDialog';

/** App frame: logo header, page outlet, attribution footer.  */
export function Shell() {
  const isHome = useLocation().pathname === '/';
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
      <footer className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pb-6 pt-2 text-xs text-zinc-500 sm:px-6">
        {isHome && <HomeSupport />}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span>Made for friends who can't do voices. Do them anyway.</span>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SupportLink />
            <CreditsDialog />
          </nav>
        </div>
      </footer>
      <FriendsOverlay />
    </div>
  );
}
