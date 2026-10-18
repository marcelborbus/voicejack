import { describe, expect, it } from 'vitest';
import { TrackBodySchema } from '@dub/shared';
import { hashMessage, normalizeErrorMessage, routeName } from '../src/lib/analytics';

describe('client analytics (V15)', () => {
  it('reports route names, never codes or paths', () => {
    expect(routeName('/')).toBe('home');
    expect(routeName('/r/ABC234')).toBe('room');
    expect(routeName('/admin/analytics')).toBe('admin');
    expect(routeName('/datenschutz')).toBe('datenschutz');
    expect(routeName('/whatever/secret')).toBe('not_found');
    for (const p of ['/', '/r/ABC234', '/library', '/nope']) {
      expect(TrackBodySchema.safeParse({ e: 'page_view', route: routeName(p) }).success).toBe(true);
    }
  });

  it('normalizes error messages so equal errors hash equal and personal bits are dropped', () => {
    const a = normalizeErrorMessage(
      'TypeError: cannot read "name" of player 12 in room ABC234 at https://x.test/r/ABC234',
    );
    const b = normalizeErrorMessage(
      'TypeError: cannot read "other" of player 7 in room QWE789 at https://x.test/r/QWE789',
    );
    expect(a).toBe(b);
    expect(a).not.toMatch(/ABC234|https|name/);
    expect(hashMessage(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashMessage(a)).toBe(hashMessage(b));
    expect(hashMessage('x')).not.toBe(hashMessage('y'));
  });
});
