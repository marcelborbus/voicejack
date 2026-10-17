/**
 * "Mugs": deterministic doodle faces generated from a seed (the player's name).
 * Pure string output, so the same face works inline (React) and on a canvas (share card).
 * No user text ever ends up in the SVG: every part is a fixed snippet picked by the seed.
 */

const INK = '#1a1027';
const Sw = (w: number) =>
  `stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const S = Sw(2.6);

export const AVATAR_BG = [
  '#ff5fa2',
  '#ff8a3d',
  '#ffd23f',
  '#2de2e6',
  '#8b6cff',
  '#a3e635',
  '#ff4d6d',
  '#38bdf8',
  '#f472b6',
  '#34d399',
] as const;

const SKIN = ['#fff1de', '#ffd6b0', '#e9b48a', '#b9805a', '#7d5236', '#c9f2ff'] as const;

// Head shapes; each also tells where the top of the head is (for hats).
const HEADS: { svg: (fill: string) => string; top: number }[] = [
  { svg: (f) => `<circle cx="32" cy="37" r="18" fill="${f}" ${S}/>`, top: 19 },
  {
    svg: (f) => `<rect x="14.5" y="19.5" width="35" height="35" rx="13" fill="${f}" ${S}/>`,
    top: 19.5,
  },
  { svg: (f) => `<ellipse cx="32" cy="38" rx="16.5" ry="19.5" fill="${f}" ${S}/>`, top: 18.5 },
];

const EYES: string[] = [
  // dots
  `<circle cx="25.5" cy="35" r="2.6" fill="${INK}"/><circle cx="38.5" cy="35" r="2.6" fill="${INK}"/>`,
  // happy arcs
  `<path d="M22.5 36 q3 -4.5 6 0 M35.5 36 q3 -4.5 6 0" fill="none" ${S}/>`,
  // wink
  `<circle cx="25.5" cy="35" r="2.6" fill="${INK}"/><path d="M35.5 35.5 h6" fill="none" ${S}/>`,
  // googly
  `<circle cx="25" cy="34" r="5" fill="#fff" ${S}/><circle cx="39" cy="34" r="5" fill="#fff" ${S}/><circle cx="26.3" cy="35.2" r="2.1" fill="${INK}"/><circle cx="37.6" cy="32.8" r="2.1" fill="${INK}"/>`,
  // sleepy
  `<path d="M22 35 q3.5 3 7 0 M35 35 q3.5 3 7 0" fill="none" ${S}/>`,
  // dizzy
  `<path d="M23 32.5 l5 5 M28 32.5 l-5 5 M36 32.5 l5 5 M41 32.5 l-5 5" fill="none" ${S}/>`,
  // surprised
  `<circle cx="25.5" cy="34.5" r="3.6" fill="#fff" ${S}/><circle cx="38.5" cy="34.5" r="3.6" fill="#fff" ${S}/><circle cx="25.5" cy="34.5" r="1.3" fill="${INK}"/><circle cx="38.5" cy="34.5" r="1.3" fill="${INK}"/>`,
];

const MOUTHS: string[] = [
  // smile
  `<path d="M26 44 q6 6 12 0" fill="none" ${S}/>`,
  // singing "O"
  `<ellipse cx="32" cy="46" rx="3.6" ry="4.4" fill="${INK}"/><ellipse cx="32" cy="48" rx="2.2" ry="1.6" fill="#ff6b8a"/>`,
  // big grin
  `<path d="M24.5 43 h15 q-1.5 8.5 -7.5 8.5 q-6 0 -7.5 -8.5z" fill="${INK}" ${S}/><path d="M26.5 44.2 h11 v2.2 h-11z" fill="#fff"/>`,
  // tongue out
  `<path d="M26 44 q6 5 12 0" fill="none" ${S}/><path d="M30 46.2 q2 5 4 0" fill="#ff6b8a" ${S}/>`,
  // flat
  `<path d="M27 46 h10" fill="none" ${S}/>`,
  // wavy
  `<path d="M24.5 46 q1.9 -3 3.8 0 t3.8 0 t3.8 0 t3.8 0" fill="none" ${S}/>`,
  // smirk
  `<path d="M27 46.5 q6 2 10.5 -3" fill="none" ${S}/>`,
];

type Acc = (top: number) => string;
const ACCESSORIES: Acc[] = [
  () => '',
  // headphones (jack cyan cups)
  (t) =>
    `<path d="M13 38 q0 -${(40 - t + 3).toFixed(1)} 19 -${(40 - t + 3).toFixed(1)} q19 0 19 ${(40 - t + 3).toFixed(1)}" fill="none" ${Sw(3.4)}/><rect x="9" y="33" width="8" height="12" rx="3.5" fill="#2de2e6" ${S}/><rect x="47" y="33" width="8" height="12" rx="3.5" fill="#2de2e6" ${S}/>`,
  // beanie
  (t) =>
    `<path d="M15.5 ${t + 6} q0 -14 16.5 -14 q16.5 0 16.5 14z" fill="#ff4d6d" ${S}/><path d="M14 ${t + 6} h36" ${Sw(4)}/><circle cx="32" cy="${t - 9}" r="3.4" fill="#fff" ${S}/>`,
  // cap
  (t) =>
    `<path d="M16 ${t + 6} q0 -13 16 -13 q16 0 16 13z" fill="#38bdf8" ${S}/><path d="M38 ${t + 5} q10 -1 15 3" fill="none" ${Sw(3.4)}/>`,
  // round glasses (sit on the eyes)
  () =>
    `<circle cx="25.5" cy="35" r="6" fill="#ffffff33" ${S}/><circle cx="38.5" cy="35" r="6" fill="#ffffff33" ${S}/><path d="M31.5 35 h1" ${S}/>`,
  // handheld mic at the mouth
  () =>
    `<path d="M45.5 52 l6 10" ${Sw(4.4)}/><circle cx="42" cy="47.5" r="5.6" fill="#52525b" ${S}/><path d="M38.5 45 l7 5 M37.6 48.6 l5 3.6 M40.4 43 l5 3.6" stroke="#d4d4d8" stroke-width="1.3" stroke-linecap="round"/>`,
  // bow
  (t) =>
    `<path d="M32 ${t + 1} l-8 -5 v10z M32 ${t + 1} l8 -5 v10z" fill="#ff5fa2" ${S}/><circle cx="32" cy="${t + 1}" r="2.4" fill="#ff5fa2" ${S}/>`,
  // mustache
  () => `<path d="M32 42 q-4 -3 -8 0 q-2 2 -4 0 M32 42 q4 -3 8 0 q2 2 4 0" fill="${INK}" ${S}/>`,
  // party hat
  (t) =>
    `<path d="M24 ${t + 3} l8 -17 l8 17z" fill="#ffd23f" ${S}/><path d="M27 ${t - 3} l7 2 M29.5 ${t - 9} l4.5 1.5" stroke="#ff4d6d" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="${t - 14}" r="2.4" fill="#ff4d6d" ${S}/>`,
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: tiny seeded PRNG, so each part is independent of the others. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AvatarParts {
  bg: number;
  skin: number;
  head: number;
  eyes: number;
  mouth: number;
  acc: number;
  blush: boolean;
}

/** Normalised seed: the face follows the name, ignoring case and outer whitespace. */
export function avatarSeed(name: string): string {
  return name.trim().toLowerCase();
}

export function avatarParts(seed: string): AvatarParts {
  const r = rng(hash(avatarSeed(seed)));
  const pick = (n: number) => Math.floor(r() * n);
  return {
    bg: pick(AVATAR_BG.length),
    skin: pick(SKIN.length),
    head: pick(HEADS.length),
    eyes: pick(EYES.length),
    mouth: pick(MOUTHS.length),
    acc: pick(ACCESSORIES.length),
    blush: r() < 0.45,
  };
}

function wrap(bg: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%"><rect width="64" height="64" fill="${bg}"/><path d="M-4 52 q18 -8 36 0 t36 0 v16 h-72z" fill="#00000014"/>${body}</svg>`;
}

/** The face for `seed` as a standalone SVG string (64×64 viewBox). */
export function avatarSvg(seed: string): string {
  const p = avatarParts(seed);
  const head = HEADS[p.head]!;
  // Glasses (4) and mustache (7) belong on the face; hats go on top of the head.
  const acc = ACCESSORIES[p.acc]!(head.top);
  const blush = p.blush
    ? `<ellipse cx="21.5" cy="42" rx="3" ry="2" fill="#ff6b8a66"/><ellipse cx="42.5" cy="42" rx="3" ry="2" fill="#ff6b8a66"/>`
    : '';
  const body = head.svg(SKIN[p.skin]!) + blush + EYES[p.eyes]! + MOUTHS[p.mouth]! + acc;
  return wrap(AVATAR_BG[p.bg]!, body);
}

/** Anonymous "mystery dubber" face for the showcase. */
export function mysteryAvatarSvg(): string {
  return wrap(
    '#2a1e45',
    `<circle cx="32" cy="37" r="18" fill="#3b2d5c" stroke="#ffffff55" stroke-width="2.6" stroke-dasharray="5 4"/><text x="32" y="45" text-anchor="middle" font-family="Bricolage Grotesque Variable, sans-serif" font-weight="800" font-size="24" fill="#ffd23f">?</text>`,
  );
}

/** `data:` URL, e.g. for drawing the face onto a canvas. */
export function avatarDataUrl(seed: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(seed))}`;
}

const FIRST = [
  'Captain',
  'Sir',
  'Lady',
  'Doctor',
  'Big',
  'Lil',
  'DJ',
  'Professor',
  'Agent',
  'Count',
  'Auntie',
  'MC',
] as const;
const LAST = [
  'Mumble',
  'Reverb',
  'Feedback',
  'Static',
  'Squeak',
  'Echo',
  'Boom Mic',
  'Falsetto',
  'Gravel',
  'Wobble',
  'Hiss',
  'Mixtape',
  'Kazoo',
  'Overdub',
] as const;

/** A silly name for the 🎲 button (always ≤ 20 chars). */
export function randomSillyName(rand: () => number = Math.random): string {
  const a = FIRST[Math.floor(rand() * FIRST.length)]!;
  const b = LAST[Math.floor(rand() * LAST.length)]!;
  return `${a} ${b}`;
}
