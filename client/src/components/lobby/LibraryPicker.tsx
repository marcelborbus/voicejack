import { libraryPaths, type LibrariesResponse, type LibrarySummary } from '@dub/shared';
import { Library } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { send } from '@/state/session';

/**
 * Clip library choice in the lobby (V05). Lists the official libraries; shown only when there is
 * more than one. The host picks, everyone else sees the name. The clip count of the picked
 * library is the lobby's "Clips" stat (snapshot `clipCount`).
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

  if (libraries.length < 2) return null;
  const current = libraries.find((l) => l.id === libraryId) ?? libraries.find((l) => l.isDefault);
  if (!isHost) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-zinc-400" data-testid="library-name">
        <Library className="size-3.5" /> {current?.name ?? 'Clips'}
      </p>
    );
  }
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
          {libraries.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name} · {l.clipCount} clips
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
