import { useEffect, useId, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { friendsApi } from './api';

/** v1.2 #44: account-menu switch "Discoverable by name" (friend search). Default on. */
export function DiscoverableToggle({ className }: { className?: string }) {
  const id = useId();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    friendsApi
      .settings()
      .then((s) => live && setOn(s.discoverable))
      .catch(() => live && setOn(null));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <label htmlFor={id} className="text-sm">
        <span className="block font-semibold">Discoverable by name</span>
        <span className="text-xs text-zinc-400">Others can find you in friend search.</span>
      </label>
      <Switch
        id={id}
        data-testid="discoverable-toggle"
        checked={on ?? true}
        disabled={on === null}
        onCheckedChange={async (v) => {
          const prev = on;
          setOn(v);
          try {
            setOn((await friendsApi.setSettings({ discoverable: v })).discoverable);
          } catch {
            setOn(prev);
            toast('Could not save that', { variant: 'warning' });
          }
        }}
      />
    </div>
  );
}
