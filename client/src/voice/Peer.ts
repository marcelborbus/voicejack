import type { PlayerId, RtcSignal } from '@dub/shared';

export interface PeerCallbacks {
  signal(data: RtcSignal): void;
  onState(state: 'connecting' | 'connected' | 'failed'): void;
  onStream(stream: MediaStream): void;
}

/**
 * One WebRTC audio link using the "perfect negotiation" pattern. Only the impolite side
 * creates the audio transceiver and offers; the polite side answers on that transceiver.
 * Glare (both offering after a restart) is resolved by the polite side rolling back.
 */
export class Peer {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private track: MediaStreamTrack | null;
  private restarted = false;
  private closed = false;

  constructor(
    readonly id: PlayerId,
    readonly polite: boolean,
    iceServers: RTCIceServer[],
    localTrack: MediaStreamTrack | null,
    private readonly cb: PeerCallbacks,
  ) {
    this.track = localTrack;
    this.pc = new RTCPeerConnection({ iceServers });
    const pc = this.pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription();
      } catch (e) {
        console.warn('[voice] negotiation failed', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      this.cb.signal({ kind: 'candidate', candidate: candidate ? candidate.toJSON() : null });
    };
    pc.ontrack = (ev) => {
      this.cb.onStream(ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const s = pc.connectionState;
      if (s === 'connected') this.cb.onState('connected');
      else if (s === 'failed') {
        if (!this.polite && !this.restarted) {
          this.restarted = true;
          pc.restartIce();
          this.cb.onState('connecting');
        } else this.cb.onState('failed');
      } else if (s === 'new' || s === 'connecting') this.cb.onState('connecting');
    };
    this.cb.onState('connecting');

    if (!polite) pc.addTransceiver('audio', { direction: 'sendrecv'});
    this.applyTrack();
  }

  /** Swap the outgoing track (mic acquired / re-acquired). No renegotiation needed. */
  setTrack(track: MediaStreamTrack | null): void {
    this.track = track;
    this.applyTrack();
  }

  private applyTrack(): void {
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver.track.kind !== 'audio' || t.currentDirection === 'stopped') continue;
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
      if (t.sender.track !== this.track) void t.sender.replaceTrack(this.track).catch(() => undefined);
    }
  }

  private sendDescription(): void {
    const d = this.pc.localDescription;
    if (!d) return;
    this.cb.signal({ kind: 'description', description: { type: d.type as 'offer' | 'answer' | 'rollback', sdp: d.sdp } });
  }

  /** Returns false if the signal could not be applied (e.g. the remote restarted). */
  async handleSignal(data: RtcSignal): Promise<boolean> {
    if (this.closed) return false;
    const pc = this.pc;
    try {
      if (data.kind === 'description') {
        const desc = data.description;
        const offerCollision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return true;
        await pc.setRemoteDescription(desc as RTCSessionDescriptionInit);
        if (desc.type === 'offer') {
          this.applyTrack(); // polite side: send on the offered transceiver
          await pc.setLocalDescription();
          this.sendDescription();
        }
      } else {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn('[voice] signal handling failed', e);
      return false;
    }
    return true;
  }

  get dead(): boolean {
    return this.closed || this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed';
  }

  close(): void {
    this.closed = true;
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
