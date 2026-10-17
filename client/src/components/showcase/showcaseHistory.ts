// Remembers, per round, the order in which dubs were shown and what this player voted, so
// the round results can say "Dub #2 was Alice's" and "you gave it 7". Tab-local and
// best effort: after a reload the results simply leave those details out.

export interface SeenItem {
  index: number;
  myVote: number | null;
}

const seen = new Map<string, Map<string, SeenItem>>();

const key = (code: string, round: number) => `${code}:${round}`;

export function recordShowcaseItem(
  code: string,
  round: number,
  submissionId: string,
  item: SeenItem,
): void {
  let m = seen.get(key(code, round));
  if (!m) seen.set(key(code, round), (m = new Map()));
  m.set(submissionId, item);
}

export function seenItem(code: string, round: number, submissionId: string): SeenItem | null {
  return seen.get(key(code, round))?.get(submissionId) ?? null;
}
