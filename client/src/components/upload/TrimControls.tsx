import { Scissors } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  markEnd,
  markStart,
  TRIM_MAX,
  trimError,
  trimLength,
  withDuration,
  type TrimFields,
} from '@/lib/trim';

const small = 'h-10 rounded-xl text-sm';
const labelCls = 'text-xs font-semibold uppercase tracking-[0.12em] text-zinc-400';

/**
 * Clip upload trim (#42), shared by "My clips" and the admin upload: a local preview of the
 * chosen file with "Start here" / "End here", and Start / End fields in seconds. The parent
 * keeps the fields (`lib/trim.ts` turns them into the `ss`/`t` upload params).
 */
export function TrimControls({
  file,
  value,
  onChange,
  disabled,
  testId,
}: {
  file: File | null;
  value: TrimFields;
  onChange: (f: TrimFields) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  useEffect(() => {
    setDuration(null);
    setNote(null);
  }, [file]);

  const error = trimError(value);
  const length = trimLength(value);
  const apply = (u: { fields: TrimFields; note: string | null }) => {
    onChange(u.fields);
    setNote(u.note);
  };
  const now = () => video.current?.currentTime ?? 0;

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {preview && (
        <div className="flex flex-col gap-2">
          <video
            ref={video}
            src={preview}
            controls
            muted
            playsInline
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) {
                setDuration(d);
                onChange(withDuration(value, d));
              }
            }}
            className="max-h-64 w-full rounded-xl bg-black object-contain"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              data-testid="trim-mark-start"
              onClick={() => apply(markStart(value, now(), duration ?? undefined))}
            >
              <Scissors /> Start here
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              data-testid="trim-mark-end"
              onClick={() => apply(markEnd(value, now()))}
            >
              <Scissors /> End here
            </Button>
            {note && (
              <span className="text-xs text-amber-200" data-testid="trim-note" role="status">
                {note}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Start (s)</span>
          <Input
            className={small}
            inputMode="decimal"
            value={value.start}
            disabled={disabled}
            data-testid="trim-start"
            aria-invalid={!!error}
            onChange={(e) => {
              setNote(null);
              onChange({ ...value, start: e.target.value });
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>End (s)</span>
          <Input
            className={small}
            inputMode="decimal"
            value={value.end}
            placeholder={`start + ${TRIM_MAX}`}
            disabled={disabled}
            data-testid="trim-end"
            aria-invalid={!!error}
            onChange={(e) => {
              setNote(null);
              onChange({ ...value, end: e.target.value });
            }}
          />
        </label>
        <p className="col-span-2 self-end pb-2.5 text-sm text-zinc-400 sm:col-span-1">
          Length{' '}
          <span className="font-mono text-zinc-200" data-testid="trim-length">
            {length === null ? `≤ ${TRIM_MAX}` : length.toFixed(1)} s
          </span>
          {duration !== null && <span> of {duration.toFixed(1)} s</span>}
        </p>
      </div>
      {error && (
        <p className="text-xs text-rose-300" role="alert" data-testid="trim-error">
          {error}
        </p>
      )}
    </div>
  );
}
