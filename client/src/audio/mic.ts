import { create } from 'zustand';
import { setSticky } from '@/state/session';
import { getAudioContext, unlockAudio } from './context';
import { MicOkDetector, rms, SILENCE_DB, toDb } from './levels';

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

export type MicStatus =
  | 'idle' // not requested yet
  | 'requesting' // permission prompt open
  | 'live' // stream acquired
  | 'denied' // permission refused
  | 'unavailable' // no device / insecure context / other error
  | 'lost'; // track ended (unplugged, revoked)

export interface MicState {
  status: MicStatus;
  /** Permission granted and signal detected (latched until the mic is lost). */
  micOk: boolean;
  /** 0..1 towards detection, for the "say something" progress. */
  progress: number;
  error: string | null;
  deviceLabel: string | null;
  /** #53: live, but nothing heard for 5 s (muted / dead mic). Clears on the first sound. */
  silent: boolean;
}

export const useMic = create<MicState>(() => ({
  status: 'idle',
  micOk: false,
  progress: 0,
  error: null,
  deviceLabel: null,
  silent: false,
}));

/** #53: level polling until micOk (fast, so ~120 ms of signal is seen at once), then metering. */
const DETECT_TICK_MS = 25;
const METER_TICK_MS = 50;

let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let frame: Float32Array<ArrayBuffer> | null = null;
let meterTimer: ReturnType<typeof setInterval> | null = null;
let levelDb = SILENCE_DB;
let pending: Promise<MediaStream | null> | null = null;
const detector = new MicOkDetector();

/** The one mic stream (shared by voice chat and the recorder), or null. */
export function getMicStream(): MediaStream | null {
  return stream;
}

/** Latest input level in dBFS (cheap; meters poll it per animation frame). */
export function getMicLevelDb(): number {
  return levelDb;
}

function reportMicOk(ok: boolean) {
  if (useMic.getState().micOk !== ok) useMic.setState({ micOk: ok });
  setSticky('mic', { t: 'micStatus', ok });
}

/**
 * Ask for the mic (once; later calls return the same stream). Call from a click handler
 * together with `unlockAudio()` so the analyser actually runs.
 */
export function acquireMic(): Promise<MediaStream | null> {
  if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live'))
    return Promise.resolve(stream);
  if (pending) return pending;
  if (!navigator.mediaDevices?.getUserMedia) {
    useMic.setState({
      status: 'unavailable',
      error: window.isSecureContext
        ? 'This browser cannot record audio.'
        : 'Microphone needs HTTPS (or localhost).',
    });
    return Promise.resolve(null);
  }
  useMic.setState({ status: 'requesting', error: null });
  pending = navigator.mediaDevices
    .getUserMedia(MIC_CONSTRAINTS)
    .then((s) => {
      attach(s);
      return s;
    })
    .catch((e: unknown) => {
      const name = (e as { name?: string })?.name;
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      useMic.setState({
        status: denied ? 'denied' : 'unavailable',
        error: denied
          ? 'Microphone access was blocked. Allow it in the address bar, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone found. Plug one in and try again.'
            : 'Could not open the microphone. Is another app using it?',
      });
      reportMicOk(false);
      return null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

function attach(s: MediaStream) {
  stream = s;
  detector.reset();
  const track = s.getAudioTracks()[0];
  useMic.setState({
    status: 'live',
    error: null,
    deviceLabel: track?.label || null,
    progress: 0,
    silent: false,
  });
  track?.addEventListener('ended', () => {
    if (stream !== s) return;
    detach();
    useMic.setState({ status: 'lost', error: 'The microphone was disconnected.', progress: 0 });
    reportMicOk(false);
  });

  const ctx = getAudioContext();
  source = ctx.createMediaStreamSource(s);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  frame = new Float32Array(analyser.fftSize);

  setTick(DETECT_TICK_MS);
}

function setTick(ms: number) {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = setInterval(tick, ms);
}

function tick() {
  if (!analyser || !frame) return;
  // A suspended context feeds the analyser zeros: that is not a dead mic, just no gesture yet.
  if (analyser.context.state !== 'running') return;
  analyser.getFloatTimeDomainData(frame);
  levelDb = toDb(rms(frame));
  const wasOk = detector.ok;
  const now = performance.now();
  const ok = detector.push(now, levelDb);
  if (!wasOk) {
    const progress = detector.progress();
    if (Math.abs(progress - useMic.getState().progress) > 0.05 || ok) useMic.setState({ progress });
    const silent = detector.dead(now);
    if (silent !== useMic.getState().silent) {
      useMic.setState({ silent });
      if (silent) reportMicOk(false); // a real failure: the server (and #53 auto start) knows
    }
  }
  if (ok && !wasOk) {
    useMic.setState({ silent: false });
    reportMicOk(true);
    setTick(METER_TICK_MS);
  }
}

/**
 * #53: open the mic as early as possible (room route, admin "Start test game" click) when the
 * permission is already granted, so the check is done by the time the lobby shows. Never
 * prompts. Resumes the audio context if the page has had a gesture.
 */
export function prefetchMic(): void {
  if (useMic.getState().status !== 'idle' || !navigator.permissions?.query) return;
  navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((p) => {
      if (p.state !== 'granted' || useMic.getState().status !== 'idle') return;
      if (navigator.userActivation?.hasBeenActive ?? true) void unlockAudio();
      void acquireMic();
    })
    .catch(() => undefined);
}

function detach() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  source?.disconnect();
  source = null;
  analyser = null;
  frame = null;
  levelDb = SILENCE_DB;
  stream = null;
  detector.reset();
}

/** Stop the mic entirely (e.g. on leaving the room). */
export function releaseMic(): void {
  const s = stream;
  detach();
  s?.getTracks().forEach((t) => t.stop());
  useMic.setState({ status: 'idle', micOk: false, progress: 0, error: null, silent: false });
  setSticky('mic', null);
}
