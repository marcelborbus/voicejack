import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '@/lib/toast';
import { clearMatch, clearQueueError, useQueue, wireQueue } from './queueStore';

/** On `matchFound`, opens the room; surfaces queue errors (e.g. BLOCKED) as a toast. */
export function useMatchNavigation(): void {
  const navigate = useNavigate();
  const match = useQueue((s) => s.match);
  const error = useQueue((s) => s.error);
  useEffect(() => wireQueue(), []);
  useEffect(() => {
    if (!match) return;
    clearMatch();
    navigate(`/r/${match}`);
  }, [match, navigate]);
  useEffect(() => {
    if (!error) return;
    clearQueueError();
    toast("Can't join a random game", { variant: 'warning', description: error });
  }, [error]);
}
