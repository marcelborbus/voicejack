import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/http/logger.js';

describe('loggerOptions (no client IPs in logs)', () => {
  it('logs method, path and status but no IP, port, headers or query', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const opts = loggerOptions('info') as object;
    const app = Fastify({ logger: { ...opts, stream }, trustProxy: true });
    app.get('/x', async () => ({ ok: true }));
    await app.inject({
      method: 'GET',
      url: '/x?token=secret',
      remoteAddress: '203.0.113.7',
      headers: { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'ua-test' },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('"url":"/x"');
    expect(all).toContain('"statusCode":200');
    for (const bad of ['203.0.113.7', '198.51.100.9', 'remoteAddress', 'secret', 'ua-test']) {
      expect(all).not.toContain(bad);
    }
  });
});
