import type { Phase, PlayerId, PlayerPublic, RoomSnapshot, RtcSignal } from '@dub/shared';
import { getAudioContext, isAudioRunning, onAudioStateChange } from '@/audio/context';
import { rms, toDb } from '@/audio/levels';
import { getMicLevelDb, getMicStream, useMic } from '@/audio/mic';
import { useRoomStore } from '@/state/room';
import { onServerMessage, send } from '@/state/session';
import { Peer } from './Peer';
import {
  desiredPeers,
  diffPeers,
  hostMutedIds,
  isPolite,
  peerVolume,
  remoteMuted,
  voiceGate,
  type VoiceGate,
} from './voicePolicy';
import { useVoice, type PeerState } from './voiceStore';

const SPEAKING_DB = -48;

interface Remote {
  peer: Peer;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  frame: Float32Array<ArrayBuffer> | null;
}

/**
 * Full-mesh voice chat for the current room. Follows the roster (one Peer per other connected
 * player), relays signaling via `{t:'rtc'}`, and gates audio by phase.
 *
 * Echo safeguard: voice sends a *clone* of the mic track, so disabling it never silences the
 * recorder (which uses the original track), and gating is applied synchronously inside the
 * store subscription, i.e. in the same tick the DUBBING snapshot arrives.
 */
export class VoiceMesh {
  private remotes = new Map<PlayerId, Remote>();
  private voiceTrack: MediaStreamTrack | null = null;
  private sourceTrack: MediaStreamTrack | null = null;
  private gate: VoiceGate = { send: false, play: false };
  private unsubs: (() => void)[] = [];
  private meterTimer: ReturnType<typeof setInterval>;
  private selfId: PlayerId | null = null;
  private publicRoom = false;
  private wanted = new Set<PlayerId>();
  /** #43: players the host muted for everyone (self included: then we send nothing). */
  private hostMuted = new Set<PlayerId>();

  constructor(private readonly container: HTMLElement) {
    useVoice.setState({ active: true, peers: {}, speaking: {}, selfSpeaking: false });
    this.unsubs.push(
      useRoomStore.subscribe((s) => this.syncFrom(s.snapshot)),
      useVoice.subscribe((s, prev) => {
        if (
          s.selfMuted !== prev.selfMuted ||
          s.peerMuted !== prev.peerMuted ||
          s.peerVolume !== prev.peerVolume
        )
          this.applyGate();
      }),
      useMic.subscribe((s, prev) => {
        if (s.status !== prev.status) this.refreshTrack();
      }),
      onServerMessage('rtc', (m) => void this.onSignal(m.from, m.data)),
      onAudioStateChange((st) => st === 'running' && this.retryPlayback()),
    );
    this.meterTimer = setInterval(() => this.meter(), 100);
    this.refreshTrack();
    this.syncFrom(useRoomStore.getState().snapshot);
  }

  private syncFrom(s: RoomSnapshot | null): void {
    this.publicRoom = !!s?.public;
    this.sync(s?.you.playerId ?? null, s?.players ?? [], s?.phase ?? null);
  }

  private sync(
    selfId: PlayerId | null,
    players: readonly PlayerPublic[],
    phase: Phase | null,
  ): void {
    // Gate first: when DUBBING arrives, audio is cut before anything else happens.
    this.hostMuted = hostMutedIds(players);
    if (selfId) this.selfId = selfId;
    const selfHostMuted = !!selfId && this.hostMuted.has(selfId);
    this.gate = voiceGate(phase, useVoice.getState().selfMuted, selfHostMuted);
    this.applyGate();
    if (!selfId) return;
    this.wanted = desiredPeers(players, selfId, this.publicRoom);
    const { open, close } = diffPeers(this.remotes.keys(), players, selfId, this.publicRoom);
    for (const id of close) this.closePeer(id);
    for (const id of open) this.openPeer(id);
  }

  private applyGate(): void {
    const v = useVoice.getState();
    const selfHostMuted = !!this.selfId && this.hostMuted.has(this.selfId);
    this.gate = { ...this.gate, send: this.gate.play && !v.selfMuted && !selfHostMuted };
    if (this.voiceTrack) this.voiceTrack.enabled = this.gate.send;
    for (const [id, r] of this.remotes) {
      r.audio.muted = remoteMuted(this.gate, !!v.peerMuted[id], this.hostMuted.has(id));
      r.audio.volume = peerVolume(v.peerVolume[id]);
    }
    if (v.allowed !== this.gate.play) useVoice.setState({ allowed: this.gate.play });
  }

  /** (Re)clone the mic track for voice and hand it to every peer. */
  private refreshTrack(): void {
    const src = getMicStream()?.getAudioTracks()[0] ?? null;
    if (src === this.sourceTrack && (!src || src.readyState === 'live')) return;
    this.voiceTrack?.stop();
    this.sourceTrack = src;
    this.voiceTrack = src && src.readyState === 'live' ? src.clone() : null;
    if (this.voiceTrack) this.voiceTrack.enabled = this.gate.send;
    for (const r of this.remotes.values()) r.peer.setTrack(this.voiceTrack);
  }

  private openPeer(id: PlayerId): Remote {
    const existing = this.remotes.get(id);
    if (existing) return existing;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peer = id;
    const v = useVoice.getState();
    audio.muted = remoteMuted(this.gate, !!v.peerMuted[id], this.hostMuted.has(id));
    audio.volume = peerVolume(v.peerVolume[id]);
    this.container.appendChild(audio);
    const iceServers = useRoomStore.getState().iceServers as RTCIceServer[];
    const remote: Remote = { audio, analyser: null, source: null, frame: null } as Remote;
    remote.peer = new Peer(id, isPolite(this.selfId ?? '', id), iceServers, this.voiceTrack, {
      signal: (data) => send({ t: 'rtc', to: id, data }),
      onState: (st) => this.setPeerState(id, st),
      onStream: (stream) => this.attachStream(remote, stream),
    });
    this.remotes.set(id, remote);
    return remote;
  }

  private closePeer(id: PlayerId): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.peer.close();
    r.source?.disconnect();
    r.audio.srcObject = null;
    r.audio.remove();
    this.remotes.delete(id);
    useVoice.setState((s) => {
      const peers = { ...s.peers };
      const speaking = { ...s.speaking };
      delete peers[id];
      delete speaking[id];
      return { peers, speaking };
    });
  }

  private setPeerState(id: PlayerId, st: PeerState): void {
    if (!this.remotes.has(id) || useVoice.getState().peers[id] === st) return;
    useVoice.setState((s) => ({ peers: { ...s.peers, [id]: st } }));
  }

  private attachStream(r: Remote, stream: MediaStream): void {
    if (r.audio.srcObject !== stream) {
      r.audio.srcObject = stream;
      this.play(r.audio);
    }
    try {
      r.source?.disconnect();
      const ctx = getAudioContext();
      r.source = ctx.createMediaStreamSource(stream);
      r.analyser = ctx.createAnalyser();
      r.analyser.fftSize = 512;
      r.frame = new Float32Array(r.analyser.fftSize);
      r.source.connect(r.analyser); // analysis only, never to destination
    } catch {
      r.analyser = null;
    }
  }

  private play(audio: HTMLAudioElement): void {
    void audio.play().catch(() => {
      /* autoplay blocked: retried when the AudioContext gets unlocked */
    });
  }

  private retryPlayback(): void {
    for (const r of this.remotes.values())
      if (r.audio.srcObject && r.audio.paused) this.play(r.audio);
  }

  private async onSignal(from: PlayerId, data: RtcSignal): Promise<void> {
    if (!this.selfId || from === this.selfId) return;
    // Public rooms (V13): never answer a peer we have not both opted in with. The server only
    // relays between opted-in players and pushes the snapshot first, so this never drops a
    // wanted offer.
    if (this.publicRoom && !this.wanted.has(from)) return;
    // A signal can beat the roster update; open lazily (the next diff keeps it if wanted).
    const isOffer = data.kind === 'description' && data.description.type === 'offer';
    let r = this.remotes.get(from);
    if (r && isOffer && r.peer.dead) {
      this.closePeer(from);
      r = undefined;
    }
    r ??= this.openPeer(from);
    const ok = await r.peer.handleSignal(data);
    if (!ok && isOffer && this.remotes.get(from) === r) {
      // The remote restarted with a fresh connection: start over with its offer.
      this.closePeer(from);
      await this.openPeer(from).peer.handleSignal(data);
    }
  }

  private meter(): void {
    const v = useVoice.getState();
    const speaking: Record<PlayerId, boolean> = {};
    let changed = false;
    for (const [id, r] of this.remotes) {
      let on = false;
      if (r.analyser && r.frame && isAudioRunning() && this.gate.play) {
        r.analyser.getFloatTimeDomainData(r.frame);
        on = toDb(rms(r.frame)) > SPEAKING_DB;
      }
      speaking[id] = on;
      if (!!v.speaking[id] !== on) changed = true;
    }
    const self = this.gate.send && getMicLevelDb() > SPEAKING_DB;
    if (changed || self !== v.selfSpeaking) useVoice.setState({ speaking, selfSpeaking: self });
  }

  dispose(): void {
    clearInterval(this.meterTimer);
    for (const u of this.unsubs) u();
    for (const id of [...this.remotes.keys()]) this.closePeer(id);
    this.voiceTrack?.stop();
    this.voiceTrack = null;
    useVoice.setState({
      active: false,
      peers: {},
      speaking: {},
      selfSpeaking: false,
      allowed: false,
    });
  }
}
