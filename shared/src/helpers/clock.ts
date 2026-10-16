/** One ping/pong exchange: client send time `c0`, client receive time `c1`, server time `s`. */
export interface ClockSample {
  c0: number;
  c1: number;
  s: number;
}

export interface ClockEstimate {
  /** Add to a client timestamp to get server time: `server ≈ client + offset`. */
  offset: number;
  rtt: number;
}

/** NTP-style estimate from the minimum-RTT sample: `offset = s - (c0 + c1) / 2`. */
export function clockOffset(samples: readonly ClockSample[]): ClockEstimate | null {
  let best: ClockSample | null = null;
  for (const x of samples) {
    if (x.c1 < x.c0) continue;
    if (!best || x.c1 - x.c0 < best.c1 - best.c0) best = x;
  }
  if (!best) return null;
  return { offset: best.s - (best.c0 + best.c1) / 2, rtt: best.c1 - best.c0 };
}
