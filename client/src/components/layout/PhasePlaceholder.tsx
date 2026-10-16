import { Construction } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/** Stand-in for phase screens that a later task fills in. */
export function PhasePlaceholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="mx-auto w-full max-w-xl animate-fade-up">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Construction className="size-10 text-orange-300" />
        <h2 className="font-display text-3xl font-bold">{title}</h2>
        {hint && <p className="text-sm text-zinc-400">{hint}</p>}
      </CardContent>
    </Card>
  );
}
