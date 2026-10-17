/**
 * Doodle kit (docs/design-v1.1.md §4): hand-drawn SVG accents. All decorative (`aria-hidden`).
 * Strokes use `currentColor`, so colour them with a text-* class.
 */
import { cn } from '@/lib/utils';

type P = { className?: string };
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Wobbly underline that draws itself. Stretch it under a word. */
export function Squiggle({ className }: P) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 200 16"
      preserveAspectRatio="none"
      className={cn('h-3 w-full', className)}
    >
      <path
        {...stroke}
        strokeWidth="5"
        pathLength={1}
        className="stroke-draw"
        d="M3 10 C 22 3, 34 14, 52 8 S 84 3, 102 9 S 136 14, 152 7 S 184 4, 197 9"
      />
    </svg>
  );
}

export function Sparkle({ className }: P) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={cn('size-6', className)}>
      <path
        {...stroke}
        strokeWidth="2.2"
        d="M12 2.5c.6 4.6 2.6 6.9 7.5 9.5-4.9 2.4-6.9 4.6-7.5 9.5-.8-4.9-2.7-7.1-7.5-9.5 4.8-2.6 6.8-4.9 7.5-9.5Z"
      />
    </svg>
  );
}

/** Curly hand-drawn arrow pointing right/down (rotate as needed). */
export function CurlyArrow({ className }: P) {
  return (
    <svg aria-hidden viewBox="0 0 64 48" className={cn('h-10 w-14', className)}>
      <path
        {...stroke}
        strokeWidth="2.6"
        d="M4 8c10-6 26-4 26 8 0 9-12 9-11 1 1-9 18-8 26 3 4 6 6 12 7 20"
      />
      <path {...stroke} strokeWidth="2.6" d="M45 33l7 8 6-10" />
    </svg>
  );
}

/** Scribbled sound wave. */
export function WaveScribble({ className }: P) {
  return (
    <svg aria-hidden viewBox="0 0 48 24" className={cn('h-6 w-12', className)}>
      <path {...stroke} strokeWidth="2.4" d="M2 12h5l3-7 4 14 4-17 4 20 4-15 4 10 3-5h13" />
    </svg>
  );
}

/** Doodle mic with a cable curling into a 3.5 mm jack plug (the brand motif). */
export function MicJack({ className }: P) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={cn('size-16', className)}>
      <rect
        x="20"
        y="4"
        width="16"
        height="26"
        rx="8"
        {...stroke}
        fill="currentColor"
        fillOpacity=".14"
        strokeWidth="2.8"
      />
      <path {...stroke} strokeWidth="2.2" d="M23 13h10M23 19h10" opacity=".7" />
      <path {...stroke} strokeWidth="2.8" d="M14 22c0 9 6 15 14 15s14-6 14-15" />
      <path {...stroke} strokeWidth="2.8" d="M28 37v6c0 9 18 4 20 12" />
      {/* plug: sleeve, ring, tip */}
      <path {...stroke} strokeWidth="2.8" d="M46 54l4 3" />
      <path fill="currentColor" d="M49 55.5l6 4.2-1.6 2.3-6-4.2z" />
      <path {...stroke} strokeWidth="2.2" d="M55.6 60.2l2.6 1.8" />
    </svg>
  );
}

/** Tiled doodle wallpaper (used by the Backdrop) as a CSS `url()`. */
export const DOODLE_WALLPAPER = (() => {
  const s =
    'fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><g ${s}>
  <g transform="translate(28 30) rotate(-14)"><rect x="0" y="0" width="14" height="22" rx="7"/><path d="M-6 14c0 8 5 12 13 12s13-4 13-12M7 26v7c0 7 14 3 16 10"/></g>
  <g transform="translate(196 22) rotate(10)"><path d="M0 18h46l-4-14H-2z"/><path d="M6 4l8 14M18 4l8 14M30 4l8 14"/><rect x="-2" y="18" width="48" height="26" rx="3"/></g>
  <g transform="translate(110 118)"><path d="M0 12h6l3-8 4 16 4-18 4 20 4-14 3 6h8"/></g>
  <g transform="translate(250 140) rotate(-8)"><path d="M10 0c.5 4 2.2 6 6.5 8.2-4.3 2-6 4-6.5 8.2-.7-4.2-2.4-6.2-6.5-8.2 4.1-2.2 5.8-4.2 6.5-8.2Z"/></g>
  <g transform="translate(30 200) rotate(6)"><path d="M0 6c0-4 3-6 7-6h30c4 0 7 2 7 6v14c0 4-3 6-7 6H16l-9 8 2-8H7c-4 0-7-2-7-6z"/><path d="M10 12h22M10 18h14"/></g>
  <g transform="translate(170 230) rotate(-30)"><path d="M0 0h20M20 -4v8M24 -3v6M28 -2.5h8v5h-8z"/><path d="M-30 0c-10 0-14 10-24 6"/></g>
  <g transform="translate(270 270) rotate(18)"><circle cx="0" cy="0" r="9"/><path d="M-3 -2v4M3 -2v4M-4 4c2 2 6 2 8 0"/></g>
  <g transform="translate(110 290) rotate(-6)"><path d="M0 6l4-6 4 6-4 6zM20 0v12M14 6h12"/></g>
</g></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
})();
