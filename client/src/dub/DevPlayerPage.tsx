import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getAudioContext, unlockAudio } from '@/audio/context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DubPlayer, type DubChunk, type DubPlayerEvent } from './DubPlayer';

/**
 * Dev-only (`/dev/player`): the test clip plus two synthetic chunks, to check sync by ear and
 * by the watchdog log. Chunk A beeps (1200 Hz) on every whole clip second, which should land
 * exactly on the clip's own 880 Hz second beeps; it also has a 137 ms leading offset to skip.
 * Chunk B (overlapping, lane 2) is a 440 Hz blip on every half second.
 */
export function makeBeepChunk(
  ctx: BaseAudioContext,
  opts: { id: string; startMs: number; durationMs: number; offsetMs: number; freq: number; everyMs: number; phaseMs?: number },
): DubChunk {
  const sr = ctx.sampleRate;
  const total = (opts.offsetMs + opts.durationMs) / 1000;
  const buf = ctx.createBuffer(1, Math.ceil(total * sr), sr);
  const data = buf.getChannelData(0);
  const blip = 0.06;
  // Leading "latency" junk: low noise, which must never be heard.
  for (let i = 0; i < Math.round((opts.offsetMs / 1000) * sr); i++) data[i] = (Math.random() - 0.5) * 0.3;
  for (let t = opts.phaseMs ?? 0; t < opts.durationMs; t += opts.everyMs) {
    const s0 = Math.round(((opts.offsetMs + t) / 1000) * sr);
    for (let i = 0; i < blip * sr && s0 + i < data.length; i++) {
      const env = Math.min(1, i / 48, (blip * sr - i) / 48);
      data[s0 + i] = 0.5 * env * Math.sin((2 * Math.PI * opts.freq * i) / sr);
    }
  }
  return { id: opts.id, startMs: opts.startMs, offsetMs: opts.offsetMs, durationMs: opts.durationMs, buffer: buf };
}

const SPEEDS = [0.5, 1, 1.5, 2];

export default function DevPlayerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<DubPlayer | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState({ resyncs: 0, schedules: 0, driftMs: 0, t: 0, paused: true, rate: 1 });
  const resyncTimes = useRef<number[]>([]);
  const clip = new URLSearchParams(location.search).get('clip') ?? '/clips/dev-a.webm';

  useEffect(() => {
    const video = videoRef.current!;
    const ctx = getAudioContext();
    const counts = { resyncs: 0, schedules: 0 };
    const onEvent = (e: DubPlayerEvent) => {
      if (e.type === 'resync') {
        counts.resyncs++;
        resyncTimes.current.push(performance.now());
      }
      if (e.type === 'schedule') counts.schedules++;
      const line = `${(performance.now() / 1000).toFixed(2)} ${JSON.stringify(e)}`;
      console.debug('[dub]', line);
      setLog((l) => [line, ...l].slice(0, 30));
    };
    const player = new DubPlayer({ video, ctx, onEvent });
    player.setChunks([
      makeBeepChunk(ctx, { id: 'A', startMs: 1000, durationMs: 6000, offsetMs: 137, freq: 1200, everyMs: 1000 }),
      makeBeepChunk(ctx, { id: 'B', startMs: 3500, durationMs: 5000, offsetMs: 0, freq: 440, everyMs: 1000, phaseMs: 0 }),
    ]);
    playerRef.current = player;
    (window as unknown as { __dubDev: unknown }).__dubDev = { player, video, counts, resyncTimes: resyncTimes.current };
    const iv = setInterval(() => {
      const a = player.audioMediaTimeMs();
      setStats({
        ...counts,
        driftMs: a === null ? 0 : video.currentTime * 1000 - a,
        t: video.currentTime,
        paused: video.paused,
        rate: video.playbackRate,
      });
    }, 100);
    return () => {
      clearInterval(iv);
      player.dispose();
    };
  }, []);

  const v = () => videoRef.current!;
  const recentResyncs = resyncTimes.current.filter((t) => performance.now() - t < 5000).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-testid="dev-player">
      <h1 className="font-display text-3xl font-bold">DubPlayer dev page</h1>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <video ref={videoRef} src={clip} className="w-full rounded-2xl bg-black" playsInline preload="auto" />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                void unlockAudio();
                if (v().paused) void v().play();
                else v().pause();
              }}
            >
              {stats.paused ? <Play /> : <Pause />} {stats.paused ? 'Play' : 'Pause'}
            </Button>
            <Button variant="secondary" onClick={() => (v().currentTime = Math.max(0, v().currentTime - 5))}>
              -5 s
            </Button>
            <Button variant="secondary" onClick={() => (v().currentTime += 5)}>
              +5 s
            </Button>
            <Button variant="ghost" size="icon" onClick={() => (v().currentTime = 0)} aria-label="Restart">
              <RotateCcw />
            </Button>
            {SPEEDS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={stats.rate === s ? 'default' : 'outline'}
                onClick={() => (v().playbackRate = s)}
              >
                {s}×
              </Button>
            ))}
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              ref audio
              <input type="checkbox" defaultChecked onChange={(e) => (v().muted = !e.target.checked)} />
            </label>
          </div>
          <input
            type="range"
            min={0}
            max={12}
            step={0.01}
            value={stats.t}
            onChange={(e) => (v().currentTime = Number(e.target.value))}
          />
          <div className="grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-4" data-testid="dev-stats">
            <Stat label="t" value={stats.t.toFixed(2)} />
            <Stat label="drift ms" value={stats.driftMs.toFixed(1)} warn={Math.abs(stats.driftMs) > 30} />
            <Stat label="resyncs" value={String(stats.resyncs)} />
            <Stat label="resyncs/5s" value={String(recentResyncs)} warn={recentResyncs >= 1} />
          </div>
          <pre className="max-h-64 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] text-zinc-400">
            {log.join('\n')}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={cn('rounded-xl bg-white/[0.04] px-3 py-2', warn && 'text-amber-300')}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      {value}
    </div>
  );
}
