import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Datenschutz from '@/pages/legal/Datenschutz';
import Impressum from '@/pages/legal/Impressum';
import { NotConfigured, Operator } from '@/pages/legal/LegalLayout';
import Takedown from '@/pages/legal/Takedown';

function render(Page: ComponentType, path = '/') {
  return renderToString(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Page)),
  );
}

// V12 smoke: the legal routes render (server-side, no DOM needed).
describe('legal pages', () => {
  it('Impressum renders', () => {
    const html = render(Impressum, '/impressum');
    expect(html).toContain('data-testid="legal-impressum"');
    expect(html).toContain('Impressum');
  });

  it('Datenschutz renders German first, with the facts it promises', () => {
    const html = render(Datenschutz, '/datenschutz').replaceAll('<!-- -->', '');
    expect(html).toContain('data-testid="legal-datenschutz"');
    expect(html).toContain('Datenschutzerklärung');
    expect(html).toContain('Stand:');
    for (const fact of ['vj_session', 'stun.nextcloud.com', 'Hetzner', 'Liberapay', '90 Tagen']) {
      expect(html).toContain(fact);
    }
  });

  it('Takedown renders', () => {
    const html = render(Takedown, '/takedown');
    expect(html).toContain('data-testid="legal-takedown"');
    expect(html).toContain('Report clip');
  });

  it('shows the operator, or the banner when not configured', () => {
    const op = renderToString(
      createElement(Operator, {
        legal: {
          name: 'Erika Mustermann',
          address: 'Str. 1\n12345 Ort',
          emailUser: 'e',
          emailDomain: 'example.org',
        },
      }),
    );
    expect(op).toContain('Erika Mustermann');
    expect(op).toContain('12345 Ort');
    expect(op).toContain('e@example.org');
    expect(op).not.toContain('mailto:');
    expect(renderToString(createElement(NotConfigured))).toContain('Impressum not configured');
  });
});
