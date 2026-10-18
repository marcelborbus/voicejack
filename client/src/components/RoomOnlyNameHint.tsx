/** Under a name field: a registered user's different name is for this game only (#41). */
export function RoomOnlyNameHint({ accountName }: { accountName: string | null }) {
  if (!accountName) return null;
  return (
    <p className="text-xs text-zinc-400" data-testid="room-only-name-hint">
      Just for this game. Your account name stays{' '}
      <span className="font-semibold text-zinc-200">{accountName}</span> (change it in the account
      menu).
    </p>
  );
}
