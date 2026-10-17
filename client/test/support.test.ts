import { describe, expect, it } from 'vitest';
import { formatEur, parseCosts } from '@/components/support/costs';
import costsJson from '../public/costs.json';

describe('support prompt costs (V11)', () => {
  it('parses the shipped costs.json', () => {
    expect(parseCosts(costsJson)).toMatchObject({ monthlyEur: 5, players: 100 });
  });

  it('rejects malformed bodies', () => {
    expect(parseCosts(null)).toBeNull();
    expect(parseCosts('5')).toBeNull();
    expect(parseCosts({ monthlyEur: '5', players: 100 })).toBeNull();
    expect(parseCosts({ monthlyEur: 5, players: 0 })).toBeNull();
    expect(parseCosts({ monthlyEur: Number.NaN, players: 10 })).toBeNull();
  });

  it('formats euros', () => {
    expect(formatEur(5)).toBe('€5');
    expect(formatEur(3.49)).toBe('€3.49');
  });
});
