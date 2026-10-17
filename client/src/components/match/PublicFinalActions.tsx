import { Home as HomeIcon, Shuffle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useMe } from '@/state/room';
import { leaveRoom } from '@/state/session';
import { getSavedName } from '@/state/storage';
import { joinQueue } from './queueStore';

/** After a public game (V08): queue again, or go home. There is no lobby to go back to. */
export function PublicFinalActions() {
  const navigate = useNavigate();
  const me = useMe();
  return (
    <div className="flex flex-col gap-3" data-testid="public-final-actions">
      <Button
        size="lg"
        data-testid="play-again"
        onClick={() => {
          const name = getSavedName().trim() || me?.name || 'Player';
          leaveRoom();
          joinQueue(name);
          navigate('/');
        }}
      >
        <Shuffle /> Play again
      </Button>
      <Button
        size="lg"
        variant="secondary"
        data-testid="final-home"
        onClick={() => {
          leaveRoom();
          navigate('/');
        }}
      >
        <HomeIcon /> Home
      </Button>
    </div>
  );
}
