import { useParams } from 'react-router';
import { Lobby } from './phases/Lobby';

export function Room() {
  const { code } = useParams();
  return (
    <div className="flex flex-col gap-6">
      <p className="font-mono text-sm text-zinc-500">Room {code}</p>
      <Lobby />
    </div>
  );
}
