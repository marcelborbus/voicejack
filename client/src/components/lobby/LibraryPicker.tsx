import { libraryPaths, type LibrariesResponse, type LibrarySummary } from '@dub/shared';
import { Library } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import * as SelectPrimitive from '@radix-ui/react-select';
import { send } from '@/state/session';

/**
 * Clip library choice in the lobby (V05). Lists the official libraries and (V06) the host's own
 * private ones, grouped "Official" / "My libraries"; shown only when there is more than one.
 * The host picks, everyone else sees the name (a private library of the host is not in their
 * list: "Host's clips"). The clip count of the picked library is the lobby's "Clips" stat.
 */
export function LibraryPicker({
  libraryId,
  isHost,
  clipCount,
}: {
  libraryId: string | undefined;
  isHost: boolean;
  clipCount: number;
}) {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  useEffect(() => {
    let live = true;
    fetch(libraryPaths.libraries())
      .then((r) => (r.ok ? (r.json() as Promise<LibrariesResponse>) : { libraries: [] }))
      .then((r) => live && setLibraries(r.libraries))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [libraryId, clipCount]);

  const known = libraries.find((l) => l.id === libraryId);
  if (!isHost && libraryId && !known && libraries.length > 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-zinc-400" data-testid="library-name">
        <Library className="size-3.5" /> Host&apos;s own clips
      </p>
    );
  }
  if (libraries.length < 2) return null;
  const current = known ?? libraries.find((l) => l.isDefault);
  if (!isHost) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-zinc-400" data-testid="library-name">
        <Library className="size-3.5" /> {current?.name ?? 'Clips'}
      </p>
    );
  }
  const official = libraries.filter((l) => l.visibility === 'official');
  const mine = libraries.filter((l) => l.visibility === 'private');
  const item = (l: LibrarySummary) => (
    <SelectItem key={l.id} value={l.id}>
      {l.name} · {l.clipCount} clips
    </SelectItem>
  );
  const groupLabel =
    'px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500';
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="library-select" className="flex items-center gap-1.5">
        <Library className="size-3.5" /> Clip library
      </Label>
      <Select
        value={current?.id}
        onValueChange={(id) =>
          id !== libraryId && send({ t: 'updateSettings', settings: { libraryId: id } })
        }
      >
        <SelectTrigger id="library-select" data-testid="library-select" className="h-10 text-sm">
          <SelectValue placeholder="Pick a library" />
        </SelectTrigger>
        <SelectContent>
          {mine.length === 0 ? (
            official.map(item)
          ) : (
            <>
              <SelectGroup>
                <SelectPrimitive.Label className={groupLabel}>Official</SelectPrimitive.Label>
                {official.map(item)}
              </SelectGroup>
              <SelectGroup>
                <SelectPrimitive.Label className={groupLabel}>My libraries</SelectPrimitive.Label>
                {mine.map(item)}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
