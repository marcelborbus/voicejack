import type { FastifyServerOptions } from 'fastify';

/**
 * Fastify logger options without personal data (V13, owner privacy request): request logs carry
 * only method, path (query string dropped: it can hold tokens) and status. No client IP
 * (`remoteAddress`, `ip`, `X-Forwarded-For`), port, host or headers.
 */
export function loggerOptions(level: string): Exclude<FastifyServerOptions['logger'], undefined> {
  return {
    level,
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        url: stripQuery(req.url),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

export function stripQuery(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}
