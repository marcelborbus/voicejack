import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setSfxEnabled, useSfxEnabled } from '@/lib/sfx';

/** Header toggle for UI sounds (not voice chat, not the clips). */
export function SoundToggle() {
  const on = useSfxEnabled();
  const label = on ? 'Mute game sounds' : 'Unmute game sounds';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={!on}
          data-testid="sfx-toggle"
          onClick={() => setSfxEnabled(!on)}
        >
          {on ? <Volume2 /> : <VolumeX className="text-zinc-500" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
