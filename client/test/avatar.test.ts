import { describe, expect, it } from 'vitest';
import { avatarParts, avatarSvg, randomSillyName } from '@/lib/avatar';

describe('avatar', () => {
  it('is deterministic and follows the name (case/space-insensitive)', () => {
    expect(avatarSvg('Alice')).toBe(avatarSvg('Alice'));
    expect(avatarSvg('  alice ')).toBe(avatarSvg('Alice'));
    expect(avatarSvg('Alice')).not.toBe(avatarSvg('Bob'));
  });

  it('spreads names over many distinct faces', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(JSON.stringify(avatarParts(`player${i}`)));
    expect(seen.size).toBeGreaterThan(180);
  });

  it('never embeds the name in the SVG', () => {
    const svg = avatarSvg('<script>alert(1)</script>');
    expect(svg).not.toContain('script');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('silly names fit the name limit', () => {
    let x = 0;
    const rand = () => (x = (x * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 300; i++) expect(randomSillyName(rand).length).toBeLessThanOrEqual(20);
  });
});

describe('avatar svg is well-formed XML (usable as an <img>/canvas source)', () => {
  it('has no duplicated attributes on any element', () => {
    for (let i = 0; i < 300; i++) {
      const svg = avatarSvg(`p${i}`);
      for (const tag of svg.match(/<[a-z]+\s[^>]*>/g) ?? []) {
        const names = [...tag.matchAll(/\s([a-z-]+)=/g)].map((m) => m[1]);
        expect(new Set(names).size, tag).toBe(names.length);
      }
    }
  });
});
