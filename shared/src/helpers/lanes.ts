export interface Interval {
  id: string;
  startMs: number;
  durationMs: number;
}

/**
 * Greedy interval partitioning: chunks sorted by start (then id) go to the lowest lane whose
 * last chunk has ended. Touching intervals (end == start) share a lane. Returns id → lane (0-based).
 */
export function layoutLanes(chunks: readonly Interval[]): Map<string, number> {
  const sorted = chunks
    .slice()
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const laneEnds: number[] = [];
  const out = new Map<string, number>();
  for (const c of sorted) {
    let lane = laneEnds.findIndex((end) => end <= c.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = c.startMs + c.durationMs;
    out.set(c.id, lane);
  }
  return out;
}

/** Number of lanes `layoutLanes` needs (0 for no chunks). */
export function laneCount(lanes: Map<string, number>): number {
  let max = -1;
  for (const l of lanes.values()) max = Math.max(max, l);
  return max + 1;
}
