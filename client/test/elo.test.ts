import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MeUser } from '@dub/shared';
import { RankedButton } from '@/components/elo/RankedButton';
import { EloBadge } from '@/components/elo/EloBadge';

// Zustand renders its initial state on the server, so the profile store is faked here.
const me = vi.hoisted(() => ({ state: { user: null as unknown, status: 'ready' } }));
vi.mock('@/state/me', () => ({
  useMe: (sel: (s: typeof me.state) => unknown) => sel(me.state),
}));
const useMe = { setState: (s: typeof me.state) => void (me.state = s) };

const user = (publicGamesPlayed: number): MeUser => ({
  id: 'u1',
  kind: 'guest',
  displayName: 'Ann',
  email: null,
  elo: 1031,
  publicGamesPlayed,
});

const ranked = () => renderToStaticMarkup(createElement(RankedButton, { name: 'Ann' }));
const badge = () => renderToStaticMarkup(createElement(EloBadge));

describe('ranked button (V09)', () => {
  it('hidden below 3 public games, shown from 3', () => {
    useMe.setState({ user: null, status: 'ready' });
    expect(ranked()).toBe('');
    for (const n of [0, 1, 2]) {
      useMe.setState({ user: user(n), status: 'ready' });
      expect(ranked()).toBe('');
    }
    useMe.setState({ user: user(3), status: 'ready' });
    expect(ranked()).toContain('data-testid="ranked-game"');
  });

  it('Elo badge appears after the first public game', () => {
    useMe.setState({ user: user(0), status: 'ready' });
    expect(badge()).toBe('');
    useMe.setState({ user: user(1), status: 'ready' });
    expect(badge()).toContain('1031');
  });
});
