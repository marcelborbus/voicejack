import { DOODLE_WALLPAPER } from '@/components/doodles';

/**
 * Brand glow: a radial gradient instead of a `blur(120px)` filter on a solid circle. Same look,
 * but no filter to re-rasterise: the three 120 px blurs behind the whole app were a big part of
 * Firefox's per-frame cost whenever anything animated on top (#49, #50).
 */
function glow(rgb: string, alpha: number): string {
  return `radial-gradient(closest-side, rgb(${rgb} / ${alpha}) 0%, rgb(${rgb} / ${alpha * 0.55}) 45%, transparent 100%)`;
}

/** Decorative, fixed background: brand glows and a sparse doodle wallpaper ("studio wall"). */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -left-[17.5rem] -top-[17.5rem] size-[51rem]"
        style={{ backgroundImage: glow('192 38 211', 0.16) }}
      />
      <div
        className="absolute -right-[19.5rem] top-[calc(33.333%-7.5rem)] size-[47rem]"
        style={{ backgroundImage: glow('249 115 22', 0.12) }}
      />
      <div
        className="absolute -bottom-[21.5rem] left-[calc(25%-7.5rem)] size-[45rem]"
        style={{ backgroundImage: glow('124 58 237', 0.18) }}
      />
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage: DOODLE_WALLPAPER,
          backgroundSize: '320px 320px',
          maskImage: 'radial-gradient(ellipse at 50% 35%, black 30%, transparent 85%)',
        }}
      />
    </div>
  );
}
