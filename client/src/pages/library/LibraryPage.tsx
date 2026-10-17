import {
  LIBRARY_CLIP_MAX_SECONDS,
  USER_UPLOAD_MAX_BYTES,
  type AdminClip,
  type AdminLibrary,
  type UserQuota,
} from '@dub/shared';
import { FolderPlus, Library, LogIn, Pencil, Scissors, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ClipCard, ClipDialog, ConfirmDialog, Field, LibraryDialog } from '@/admin/AdminPage';
import { SignInDialog } from '@/components/account/SignInDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useMe } from '@/state/me';
import { myApi, uploadMyClip } from './api';

const fail = (title: string) => (e: unknown) =>
  toast(title, { description: (e as Error).message, variant: 'error' });

const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;

/**
 * "My clips" (V06, `/library`): a registered user's private clip libraries. They can be picked
 * in the lobby of private rooms the user hosts.
 */
export default function LibraryPage() {
  const user = useMe((s) => s.user);
  const status = useMe((s) => s.status);
  useEffect(() => {
    document.title = 'My clips · Voicejack';
  }, []);

  if (!user) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        {status === 'error' ? (
          <p className="text-zinc-400">Could not load your account.</p>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  if (user.kind !== 'registered') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <Card className="max-w-md">
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <Library className="size-10 text-fuchsia-300" />
            <p className="font-display text-xl font-bold">Your own clips</p>
            <p className="text-sm text-zinc-400">
              Sign in to upload your own clips and play them in private rooms you host.
            </p>
            <SignInDialog
              trigger={
                <Button>
                  <LogIn /> Sign in
                </Button>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }
  return <MyLibraries />;
}

function MyLibraries() {
  const [libraries, setLibraries] = useState<AdminLibrary[] | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await myApi.libraries();
      setLibraries(r.libraries);
      setQuota(r.quota);
      setSelectedId((cur) =>
        cur && r.libraries.some((l) => l.id === cur) ? cur : (r.libraries[0]?.id ?? null),
      );
    } catch (e) {
      fail('Could not load your libraries')(e);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (!libraries || !quota) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const selected = libraries.find((l) => l.id === selectedId) ?? null;
  const full = quota.libraries >= quota.maxLibraries;
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6"
      data-testid="my-library-page"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">My clips</h1>
          <p className="text-sm text-zinc-400">
            Private libraries you can pick in the lobby of rooms you host.{' '}
            <Link to="/" className="underline hover:text-zinc-200">
              Back home
            </Link>
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={full} data-testid="my-new-library">
          <FolderPlus /> New library
        </Button>
      </header>

      <QuotaBar quota={quota} />

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <nav className="flex flex-col gap-2" aria-label="Your libraries">
          {libraries.length === 0 && (
            <p className="text-sm text-zinc-400">
              No libraries yet. Create one to start uploading.
            </p>
          )}
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
                {l.disabled && (
                  <Badge variant="danger" className="ml-auto">
                    disabled
                  </Badge>
                )}
              </span>
              <span className="text-xs text-zinc-500">
                {l.clipCount} playable · {l.totalClips} total
              </span>
            </button>
          ))}
        </nav>
        {selected && (
          <LibraryView key={selected.id} library={selected} quota={quota} onChanged={refresh} />
        )}
      </div>

      <LibraryDialog
        open={creating}
        onOpenChange={setCreating}
        title="New library"
        hint="Only you can pick it, in private rooms you host."
        onSubmit={async (body) => {
          const { library } = await myApi.createLibrary(body);
          await refresh();
          setSelectedId(library.id);
        }}
      />
    </div>
  );
}

function QuotaBar({ quota }: { quota: UserQuota }) {
  const items = [
    ['Libraries', `${quota.libraries} / ${quota.maxLibraries}`],
    ['Clips', `${quota.clips} / ${quota.maxClips}`],
    ['Storage', `${mb(quota.bytes)} / ${mb(quota.maxBytes)}`],
    ['Uploads today', `${quota.uploadsToday} / ${quota.maxUploadsPerDay}`],
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 text-xs">
        {items.map(([k, v]) => (
          <span key={k} className="rounded-full border border-white/10 px-3 py-1 text-zinc-300">
            {k}: <span className="font-mono">{v}</span>
          </span>
        ))}
      </div>
      <Progress value={Math.min(100, (quota.bytes / quota.maxBytes) * 100)} className="h-1.5" />
      {quota.uploadBanned && (
        <p className="text-sm text-rose-300">
          Uploading is disabled for your account. Your libraries stay playable.
        </p>
      )}
    </div>
  );
}

function LibraryView({
  library,
  quota,
  onChanged,
}: {
  library: AdminLibrary;
  quota: UserQuota;
  onChanged: () => Promise<void>;
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
      setClips(await myApi.clips(library.id));
    } catch (e) {
      fail('Could not load clips')(e);
    }
  }, [library.id]);
  useEffect(() => void refresh(), [refresh]);

  const processing = clips?.some((c) => c.status === 'processing') ?? false;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void refresh().then(onChanged), 2000);
    return () => clearInterval(t);
  }, [processing, refresh, onChanged]);

  const changed = async () => {
    await Promise.all([refresh(), onChanged()]);
  };

  const blocked =
    quota.uploadBanned ||
    library.disabled ||
    quota.clips >= quota.maxClips ||
    quota.bytes >= quota.maxBytes ||
    quota.uploadsToday >= quota.maxUploadsPerDay;

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-2xl sm:text-2xl">
              {library.name}
              {library.disabled && <Badge variant="danger">disabled by an admin</Badge>}
            </CardTitle>
            {library.description && (
              <p className="mt-1 text-sm text-zinc-400">{library.description}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-300"
              onClick={() =>
                setConfirm({
                  title: `Delete “${library.name}”?`,
                  body: `This removes the library and its ${library.totalClips} clip(s). It cannot be undone.`,
                  run: () => myApi.deleteLibrary(library.id).then(onChanged),
                })
              }
            >
              <Trash2 /> Delete
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {blocked ? (
            <p className="text-sm text-zinc-400">
              {library.disabled
                ? 'This library was disabled by an admin.'
                : quota.uploadBanned
                  ? 'Uploading is disabled for your account.'
                  : 'You reached an upload limit (see above).'}
            </p>
          ) : (
            <UploadForm libraryId={library.id} onUploaded={changed} />
          )}
        </CardContent>
      </Card>

      {clips === null ? (
        <Spinner />
      ) : clips.length === 0 ? (
        <p className="text-sm text-zinc-400">No clips yet. Upload one above.</p>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="my-clips"
        >
          {clips.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              onToggle={(enabled) =>
                myApi.updateClip(c.id, { enabled }).then(changed, fail('Could not update clip'))
              }
              onEdit={() => setEditClip(c)}
              onDelete={() =>
                setConfirm({
                  title: `Delete “${c.title}”?`,
                  body: 'The clip and its files are removed. It cannot be undone.',
                  run: () => myApi.deleteClip(c.id).then(changed),
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
        hint="Only you can pick it, in private rooms you host."
        initial={library}
        onSubmit={async (body) => {
          await myApi.updateLibrary(library.id, body);
          await onChanged();
        }}
      />
      <ClipDialog
        clip={editClip}
        onClose={() => setEditClip(null)}
        onSaved={changed}
        save={myApi.updateClip}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}

const small = 'h-10 rounded-xl text-sm';
const round1 = (n: number) => String(Math.round(n * 10) / 10);

/** File + local preview to set the trim window, title/tags, rights checkbox, upload progress. */
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
  const [rights, setRights] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const tooBig = !!file && file.size > USER_UPLOAD_MAX_BYTES;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !rights || tooBig) return;
    setProgress(0);
    const job = uploadMyClip(
      libraryId,
      file,
      { title: title.trim() || file.name, ss, t, tags, author, source, rights: '1' },
      setProgress,
    );
    abortRef.current = job.abort;
    try {
      await job.promise;
      toast('Uploaded, preparing your clip…', { variant: 'success' });
      setFile(null);
      setTitle('');
      setSs('0');
      setT(String(LIBRARY_CLIP_MAX_SECONDS));
      setRights(false);
      if (fileInput.current) fileInput.current.value = '';
      await onUploaded();
    } catch (err) {
      fail('Upload failed')(err);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const markStart = () => {
    const v = video.current;
    if (v) setSs(round1(v.currentTime));
  };
  const markEnd = () => {
    const v = video.current;
    if (!v) return;
    const len = v.currentTime - Number(ss || 0);
    if (len >= 1) setT(round1(Math.min(len, LIBRARY_CLIP_MAX_SECONDS)));
  };

  const busy = progress !== null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="my-upload">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Video file (≤ ${mb(USER_UPLOAD_MAX_BYTES)})`}>
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
          {tooBig && <span className="text-xs text-rose-300">That file is too large.</span>}
        </Field>
        <Field label="Title">
          <Input
            className={small}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </Field>
      </div>
      {preview && (
        <div className="flex flex-col gap-2">
          <video
            ref={video}
            src={preview}
            controls
            muted
            playsInline
            className="max-h-64 w-full rounded-xl bg-black object-contain"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={markStart}>
              <Scissors /> Start here
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={markEnd}>
              <Scissors /> End here
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
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
        <Field label="Credit (author, optional)">
          <Input className={small} value={author} onChange={(e) => setAuthor(e.target.value)} />
        </Field>
        <Field label="Source (optional)">
          <Input className={small} value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] p-3 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={rights}
          onChange={(e) => setRights(e.target.checked)}
          className="mt-1 size-4 accent-fuchsia-400"
          data-testid="my-upload-rights"
        />
        <span>
          I made this clip or have the rights to share it with the people I play with. I understand
          that clips can be reported by players and removed on request (notice and takedown), and
          that uploading can be disabled for accounts that break this.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!file || busy || !rights || tooBig}>
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
