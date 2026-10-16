import type { Phase, ShowcaseStatus } from '../protocol/common.js';

/** Voice chat is on in LOBBY, ROUND_RESULTS, FINAL, and in SHOWCASE while LOADING or LOCKED. */
export function voiceAllowed(phase: Phase, showcaseStatus?: ShowcaseStatus | null): boolean {
  switch (phase) {
    case 'LOBBY':
    case 'ROUND_RESULTS':
    case 'FINAL':
      return true;
    case 'DUBBING':
      return false;
    case 'SHOWCASE':
      return showcaseStatus !== 'PLAYING';
  }
}
