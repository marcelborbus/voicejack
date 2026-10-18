import {
  LIBRARY_CLIP_MAX_SECONDS,
  formatClock,
  type AdminClip,
  type AdminLibrary,
  type AdminMeResponse,
  type UpdateClipBody,
} from '@dub/shared';
import {
  BarChart3,
  Film,
  FolderPlus,
  Library,
  Pencil,
  ShieldAlert,
  Star,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AdminError, adminApi, uploadClip } from './api';
import { UserLibraries } from './UserLibraries';

/** Admin page (V05): official clip libraries. Gated by Authelia at nginx + server re-check. */
export default function AdminPage() {
  const [me, setMe] = useState<AdminMeResponse | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<AdminLibrary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'official' | 'users'>('official');

  const refreshLibraries = useCallback(async () => {
    try {
      const list = await adminApi.libraries();
      setLibraries(list);
      setSelectedId((cur) => (cur && list.some((l) => l.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (e) {
      toast('Could not load libraries', { description: (e as Error).message, variant: 'error' });
    }
  }, []);

  useEffect(() => {
    document.title = 'Admin · Voicejack';
    adminApi
      .me()
      .then((m) => {
        setMe(m);
        void refreshLibraries();
      })
      .catch((e: Error) =>
        setDenied(e instanceof AdminError && e.status === 403 ? 'Admins only.' : e.message),
      );
  }, [refreshLibraries]);

  if (denied) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ShieldAlert className="size-10 text-rose-300" />
            <p className="font-display text-xl font-bold">No access</p>
            <p className="text-sm text-zinc-400">{denied}</p>
          </CardContent>
        </Card>
      </Centered>
    );
  }
  if (!me) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  const selected = libraries.find((l) => l.id === selectedId) ?? null;
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6"
      data-testid="admin-page"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Clip libraries</h1>
          <p className="text-sm text-zinc-400">
            Signed in as {me.user}
            {me.dev && ' (ADMIN_DEV)'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" asChild>
            <Link to="/admin/analytics" data-testid="admin-analytics-link">
              <BarChart3 /> Analytics
            </Link>
          </Button>
          <Button
            size="sm"
            variant={view === 'official' ? 'secondary' : 'ghost'}
            onClick={() => setView('official')}
          >
            Official
          </Button>
          <Button
            size="sm"
            variant={view === 'users' ? 'secondary' : 'ghost'}
            onClick={() => setView('users')}
            data-testid="admin-user-libraries-tab"
          >
            <Users /> User libraries
          </Button>
          {view === 'official' && (
            <Button onClick={() => setCreating(true)} data-testid="admin-new-library">
              <FolderPlus /> New library
            </Button>
          )}
        </div>
      </header>

      {view === 'users' ? (
        <UserLibraries />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <nav className="flex flex-col gap-2" aria-label="Libraries">
            {libraries.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelectedId(l.id)}
                aria-current={l.id === selectedId}
                className={cn(
                  'flex flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition-colors',
                  l.id === selectedId
                    ? 'border-fuchsia-400/40 bg-fuchsia-400/[0.07]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15',
                )}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <Library className="size-4 text-zinc-400" />
                  <span className="truncate">{l.name}</span>
                  {l.isDefault && (
                    <Badge variant="accent" className="ml-auto">
                      default
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-zinc-500">
                  {l.clipCount} playable · {l.totalClips} total
                </span>
              </button>
            ))}
          </nav>

          {selected ? (
            <LibraryView
              key={selected.id}
              library={selected}
              onLibrariesChanged={refreshLibraries}
            />
          ) : (
            <p className="text-zinc-400">No libraries yet.</p>
          )}
        </div>
      )}

      <LibraryDialog
        open={creating}
        onOpenChange={setCreating}
        title="New library"
        onSubmit={async (body) => {
          const { library } = await adminApi.createLibrary(body);
          await refreshLibraries();
          setSelectedId(library.id);
        }}
      />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[50vh] items-center justify-center px-4">{children}</div>;
}

function fail(title: string) {
  return (e: unknown) => toast(title, { description: (e as Error).message, variant: 'error' });
}

function LibraryView({
  library,
  onLibrariesChanged,
}: {
  library: AdminLibrary;
  onLibrariesChanged: () => Promise<void>;
}) {
  const [clips, setClips] = useState<AdminClip[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [editClip, setEditClip] = useState<AdminClip | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    run: () => Promise<void>;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setClips(await adminApi.clips(library.id));
    } catch (e) {
      fail('Could not load clips')(e);
    }
  }, [library.id]);

  useEffect(() => void refresh(), [refresh]);

  // Poll while something is being normalized.
  const processing = clips?.some((c) => c.status === 'processing') ?? false;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => {
      void refresh().then(onLibrariesChanged);
    }, 2000);
    return () => clearInterval(t);
  }, [processing, refresh, onLibrariesChanged]);

  const changed = async () => {
    await Promise.all([refresh(), onLibrariesChanged()]);
  };

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-2xl sm:text-2xl">
              {library.name}
              {library.isDefault && <Badge variant="accent">default</Badge>}
              {library.builtin && <Badge variant="outline">built-in</Badge>}
            </CardTitle>
            {library.description && (
              <p className="mt-1 text-sm text-zinc-400">{library.description}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            {!library.isDefault && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  adminApi
                    .setDefault(library.id)
                    .then(onLibrariesChanged)
                    .then(() => toast(`${library.name} is now the default`, { variant: 'success' }))
                    .catch(fail('Could not change the default'))
                }
              >
                <Star /> Make default
              </Button>
            )}
            {!library.isDefault && !library.builtin && (
              <Button
                size="sm"
                variant="ghost"
                className="text-rose-300"
                onClick={() =>
                  setConfirm({
                    title: `Delete “${library.name}”?`,
                    body: `This removes the library and its ${library.totalClips} clip(s) with their files. It cannot be undone.`,
                    run: () => adminApi.deleteLibrary(library.id).then(onLibrariesChanged),
                  })
                }
              >
                <Trash2 /> Delete
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <UploadForm libraryId={library.id} onUploaded={changed} />
        </CardContent>
      </Card>

      {clips === null ? (
        <Spinner />
      ) : clips.length === 0 ? (
        <p className="text-sm text-zinc-400">No clips yet. Upload one above.</p>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="admin-clips"
        >
          {clips.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              onToggle={(enabled) =>
                adminApi.updateClip(c.id, { enabled }).then(changed, fail('Could not update clip'))
              }
              onEdit={() => setEditClip(c)}
              onDelete={() =>
                setConfirm({
                  title: `Delete “${c.title}”?`,
                  body: 'The clip and its files are removed. It cannot be undone.',
                  run: () => adminApi.deleteClip(c.id).then(changed),
                })
              }
            />
          ))}
        </div>
      )}

      <LibraryDialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit library"
        initial={library}
        onSubmit={async (body) => {
          await adminApi.updateLibrary(library.id, body);
          await onLibrariesChanged();
        }}
      />
      <ClipDialog clip={editClip} onClose={() => setEditClip(null)} onSaved={changed} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}

export function ClipCard({
  clip,
  onToggle,
  onEdit,
  onDelete,
  children,
}: {
  clip: AdminClip;
  onToggle: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete: () => void;
  /** Extra lines under the attribution (V06: uploader, rights). */
  children?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden p-0" data-testid="admin-clip">
      <div className="relative aspect-video bg-zinc-950/60">
        {clip.posterUrl ? (
          <img
            src={clip.posterUrl}
            alt=""
            loading="lazy"
            className={cn('size-full object-cover', !clip.enabled && 'opacity-40 grayscale')}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-zinc-600">
            {clip.status === 'processing' ? <Spinner /> : <Film className="size-8" />}
          </div>
        )}
        <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-xs">
          {formatClock(clip.durationMs)}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate font-semibold" title={clip.title}>
            {clip.url ? (
              <a href={clip.url} target="_blank" rel="noreferrer" className="hover:underline">
                {clip.title}
              </a>
            ) : (
              clip.title
            )}
          </p>
          <Switch
            checked={clip.enabled}
            onCheckedChange={onToggle}
            aria-label={clip.enabled ? 'Disable clip' : 'Enable clip'}
            disabled={clip.status !== 'ready'}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {clip.status === 'processing' && <Badge variant="warning">processing</Badge>}
          {clip.status === 'failed' && <Badge variant="danger">failed</Badge>}
          {clip.status === 'ready' && !clip.playable && (
            <Badge variant="outline">not playable</Badge>
          )}
          {clip.builtin && <Badge variant="outline">built-in</Badge>}
          {clip.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </div>
        {clip.error && <p className="text-xs text-rose-300">{clip.error}</p>}
        <p className="truncate text-xs text-zinc-500" title={clip.attribution.author}>
          {[clip.attribution.author, clip.attribution.license].filter(Boolean).join(' · ') ||
            'no attribution'}
          {clip.width > 0 && ` · ${clip.width}×${clip.height}`}
          {clip.bytes > 0 && ` · ${(clip.bytes / 1e6).toFixed(1)} MB`}
        </p>
        {children}
        <div className="flex gap-2">
          {onEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={onEdit}
              disabled={clip.status === 'processing'}
            >
              <Pencil /> Edit
            </Button>
          )}
          {!clip.builtin && (
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-300"
              onClick={onDelete}
              disabled={clip.status === 'processing'}
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const small = 'h-10 rounded-xl text-sm';

function UploadForm({
  libraryId,
  onUploaded,
}: {
  libraryId: string;
  onUploaded: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [ss, setSs] = useState('0');
  const [t, setT] = useState(String(LIBRARY_CLIP_MAX_SECONDS));
  const [tags, setTags] = useState('');
  const [author, setAuthor] = useState('');
  const [source, setSource] = useState('');
  const [license, setLicense] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setProgress(0);
    const job = uploadClip(
      libraryId,
      file,
      { title: title.trim() || file.name, ss, t, tags, author, source, license },
      setProgress,
    );
    abortRef.current = job.abort;
    try {
      await job.promise;
      toast('Uploaded, normalizing…', { variant: 'success' });
      setFile(null);
      setTitle('');
      if (fileInput.current) fileInput.current.value = '';
      await onUploaded();
    } catch (err) {
      fail('Upload failed')(err);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const busy = progress !== null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="admin-upload">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <Field label="Video file (≤ 200 MB)">
          <input
            ref={fileInput}
            type="file"
            accept="video/*,.mkv"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
            }}
            className="text-sm text-zinc-300 file:mr-3 file:rounded-xl file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-zinc-100"
          />
        </Field>
        <Field label="Title">
          <Input
            className={small}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </Field>
        <Field label="Start (s)">
          <Input
            className={small}
            inputMode="decimal"
            value={ss}
            onChange={(e) => setSs(e.target.value)}
          />
        </Field>
        <Field label={`Length (s, ≤ ${LIBRARY_CLIP_MAX_SECONDS})`}>
          <Input
            className={small}
            inputMode="decimal"
            value={t}
            onChange={(e) => setT(e.target.value)}
          />
        </Field>
        <Field label="Tags (comma separated)">
          <Input className={small} value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="License">
          <Input
            className={small}
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            placeholder="CC BY 4.0"
          />
        </Field>
        <Field label="Author">
          <Input className={small} value={author} onChange={(e) => setAuthor(e.target.value)} />
        </Field>
        <Field label="Source URL">
          <Input className={small} value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!file || busy}>
          <Upload /> Upload
        </Button>
        {busy && (
          <>
            <Progress value={Math.round(progress * 100)} className="h-2 w-48" />
            <span className="font-mono text-xs text-zinc-400">{Math.round(progress * 100)}%</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel upload"
              onClick={() => abortRef.current?.()}
            >
              <X />
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

export function LibraryDialog({
  open,
  onOpenChange,
  title,
  hint = 'Official libraries can be picked by every host.',
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hint?: string;
  initial?: AdminLibrary;
  onSubmit: (body: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
    }
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            onSubmit({ name: name.trim(), description: description.trim() })
              .then(() => onOpenChange(false), fail('Could not save the library'))
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </Field>
          <Button type="submit" disabled={busy || !name.trim()}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClipDialog({
  clip,
  onClose,
  onSaved,
  save = adminApi.updateClip,
}: {
  clip: AdminClip | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** V06: the /library page saves through /api/my. */
  save?: (id: string, body: UpdateClipBody) => Promise<unknown>;
}) {
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [author, setAuthor] = useState('');
  const [source, setSource] = useState('');
  const [license, setLicense] = useState('');
  const [licenseUrl, setLicenseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!clip) return;
    setTitle(clip.title);
    setTags(clip.tags.join(', '));
    setAuthor(clip.attribution.author);
    setSource(clip.attribution.source);
    setLicense(clip.attribution.license);
    setLicenseUrl(clip.attribution.licenseUrl ?? '');
  }, [clip]);
  return (
    <Dialog open={!!clip} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit clip</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!clip) return;
            setBusy(true);
            save(clip.id, {
              title: title.trim(),
              tags: tags
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
              attribution: {
                author: author.trim(),
                source: source.trim(),
                license: license.trim(),
                ...(licenseUrl.trim() ? { licenseUrl: licenseUrl.trim() } : {}),
              },
            })
              .then(onSaved)
              .then(onClose, fail('Could not save the clip'))
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Title">
            <Input
              className={small}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <Field label="Tags (comma separated)">
            <Input className={small} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field label="Author">
            <Input className={small} value={author} onChange={(e) => setAuthor(e.target.value)} />
          </Field>
          <Field label="Source">
            <Input className={small} value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="License">
              <Input
                className={small}
                value={license}
                onChange={(e) => setLicense(e.target.value)}
              />
            </Field>
            <Field label="License URL">
              <Input
                className={small}
                value={licenseUrl}
                onChange={(e) => setLicenseUrl(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy || !title.trim()} className="mt-2">
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: { title: string; body: string; run: () => Promise<void> } | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          <DialogDescription>{state?.body}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="admin-confirm"
            onClick={() => {
              if (!state) return;
              setBusy(true);
              state
                .run()
                .then(onClose, fail('Delete failed'))
                .finally(() => setBusy(false));
            }}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
