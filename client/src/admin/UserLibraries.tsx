import {
  libraryPaths,
  type AdminClip,
  type AdminClipReport,
  type AdminUserLibrary,
} from '@dub/shared';
import { Ban, Check, EyeOff, Eye, Flag, Library } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { adminApi } from './api';
import { ClipCard, ConfirmDialog } from './AdminPage';

const fail = (title: string) => (e: unknown) =>
  toast(title, { description: (e as Error).message, variant: 'error' });

/** Private clips are not served to admins on /clips; preview through /api/admin instead. */
function withAdminUrls(c: AdminClip): AdminClip {
  return {
    ...c,
    url: c.url ? libraryPaths.adminClipFile(c.id, 'video') : null,
    posterUrl: c.posterUrl ? libraryPaths.adminClipFile(c.id, 'poster') : null,
  };
}

/**
 * Admin "User libraries" (V06): every private library with its owner and clips, open clip
 * reports. Actions: disable/delete clip, disable library, ban the owner from uploading.
 */
export function UserLibraries() {
  const [libraries, setLibraries] = useState<AdminUserLibrary[] | null>(null);
  const [reports, setReports] = useState<AdminClipReport[]>([]);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    run: () => Promise<void>;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await adminApi.userLibraries();
      setLibraries(r.libraries);
      setReports(r.reports);
    } catch (e) {
      fail('Could not load user libraries')(e);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (!libraries) return <Spinner />;
  const open = reports.filter((r) => r.resolvedAt === null);
  return (
    <div className="flex flex-col gap-6" data-testid="admin-user-libraries">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl sm:text-xl">
            <Flag className="size-5" /> Clip reports
            {open.length > 0 && <Badge variant="danger">{open.length} open</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {reports.length === 0 && <p className="text-sm text-zinc-400">No reports.</p>}
          {reports.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/[0.06] px-3 py-2 text-sm"
            >
              <span className="font-semibold">{r.clipTitle ?? `deleted clip ${r.clipId}`}</span>
              <span className="text-zinc-400">
                by {r.reporterName} · room {r.roomCode ?? '?'} ·{' '}
                {new Date(r.createdAt).toLocaleString()}
              </span>
              <span className="w-full text-zinc-300">“{r.reason}”</span>
              {r.resolvedAt === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    adminApi.resolveReport(r.id).then(refresh, fail('Could not resolve'))
                  }
                >
                  <Check /> Resolve
                </Button>
              ) : (
                <Badge variant="outline">resolved</Badge>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {libraries.length === 0 && <p className="text-zinc-400">No user libraries yet.</p>}
      {libraries.map((l) => (
        <Card key={l.id} data-testid="admin-user-library">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-xl sm:text-xl">
                <Library className="size-5 text-zinc-400" />
                {l.name}
                {l.disabled && <Badge variant="danger">disabled</Badge>}
              </CardTitle>
              <p className="mt-1 text-sm text-zinc-400">
                {l.owner
                  ? `${l.owner.displayName || 'no name'} · ${l.owner.email ?? 'deleted account'}`
                  : 'owner gone'}
                {' · '}
                {l.clipCount} playable · {l.totalClips} total
                {l.owner?.uploadBanned && ' · banned from uploading'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  adminApi
                    .setLibraryDisabled(l.id, !l.disabled)
                    .then(refresh, fail('Could not change the library'))
                }
              >
                {l.disabled ? <Eye /> : <EyeOff />} {l.disabled ? 'Enable' : 'Disable'} library
              </Button>
              {l.owner && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-300"
                  onClick={() =>
                    adminApi
                      .setUploadBan(l.owner!.id, !l.owner!.uploadBanned)
                      .then(refresh, fail('Could not change the ban'))
                  }
                >
                  <Ban /> {l.owner.uploadBanned ? 'Lift upload ban' : 'Ban from uploading'}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {l.clips.length === 0 ? (
              <p className="text-sm text-zinc-400">No clips.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {l.clips.map((c) => (
                  <ClipCard
                    key={c.id}
                    clip={withAdminUrls(c)}
                    onToggle={(enabled) =>
                      adminApi
                        .updateClip(c.id, { enabled })
                        .then(refresh, fail('Could not update clip'))
                    }
                    onDelete={() =>
                      setConfirm({
                        title: `Delete “${c.title}”?`,
                        body: 'Takedown: the clip and its files are removed. It cannot be undone.',
                        run: () => adminApi.deleteClip(c.id).then(refresh),
                      })
                    }
                  >
                    <p className="text-xs text-zinc-500">
                      {c.rightsConfirmedAt
                        ? `rights confirmed ${new Date(c.rightsConfirmedAt).toLocaleDateString()}`
                        : 'no rights confirmation'}
                    </p>
                  </ClipCard>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
