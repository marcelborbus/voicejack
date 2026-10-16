import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-1 animate-fade-up flex-col items-center justify-center gap-4 text-center">
      <p className="font-display text-8xl font-extrabold text-brand">404</p>
      <p className="text-zinc-400">This scene got cut in editing.</p>
      <Button asChild size="lg">
        <Link to="/">Back to the party</Link>
      </Button>
    </div>
  );
}
