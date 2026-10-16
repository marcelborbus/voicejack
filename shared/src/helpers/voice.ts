import type { Phase, ShowcaseStatus } from '../protocol/common.js';

/**
 * Voice chat is on everywhere except DUBBING, where each player works alone.
 * It stays on while showcase clips play, so friends can react while voting.
 * `showcaseStatus` is accepted for callers but currently does not affect the result.
 */
export function voiceAllowed(phase: Phase, _showcaseStatus?: ShowcaseStatus | null): boolean {
  return phase !== 'DUBBING';
}
