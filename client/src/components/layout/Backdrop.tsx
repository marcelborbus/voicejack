import { DOODLE_WALLPAPER } from '@/components/doodles';

/** Decorative, fixed background: brand glows and a sparse doodle wallpaper ("studio wall"). */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-40 size-[36rem] rounded-full bg-fuchsia-600/16 blur-[120px]" />
      <div className="absolute -right-48 top-1/3 size-[32rem] rounded-full bg-orange-500/12 blur-[120px]" />
      <div className="absolute -bottom-56 left-1/4 size-[30rem] rounded-full bg-violet-600/18 blur-[120px]" />
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
