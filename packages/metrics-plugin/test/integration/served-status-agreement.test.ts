/**
 * M131b: the status label HTTP metrics record for a thrown error is the status
 * the request is actually served with, with and without `errorHandler`.
 *
 * Without `errorHandler` the kernel's fallback serves a 400–499 status hint as
 * hinted and everything else as `500`; with it, the error responder decides.
 * The collector reads `responder?.statusFor?.(error) ?? fallbackErrorStatus(error)`,
 * so this drives both entry points under the same throws and compares the
 * served status to the scraped label.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { withHttpStatusHint } from '@setu-ts/common';
import { errorHandler, notFound } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { MetricsPlugin } from '../../src/index.ts';

const THROWS = {
  '/conflict': () =>
    withHttpStatusHint(new Error('stale'), {
      status: 409,
      title: 'Conflict',
      detail: 'Stale version.',
    }),
  '/outage': () =>
    withHttpStatusHint(new Error('down'), {
      status: 503,
      title: 'Unavailable',
      detail: 'Try later.',
    }),
  '/missing': () => notFound('missing'),
  '/fault': () => new Error('fault'),
} as const;

describe('metrics label the served status for a thrown error (M131b)', () => {
  for (const handler of [false, true]) {
    it(`agrees with the response (errorHandler=${handler})`, async () => {
      const app = createApplication({ plugins: [RuntimePlugin(), MetricsPlugin()] });
      if (handler) app.middleware.add(errorHandler(), { priority: 0 });
      for (const [path, make] of Object.entries(THROWS))
        app.router.get(path, () => {
          throw make();
        });
      await app.start();
      try {
        const served = new Map<string, number>();
        for (const path of Object.keys(THROWS)) {
          const res = await app.inject({ method: 'GET', url: `http://localhost${path}` });
          served.set(path, res.statusCode);
        }
        const scrape = (await app.inject({ method: 'GET', url: 'http://localhost/metrics' })).body;
        for (const status of new Set(served.values())) {
          const count = [...served.values()].filter((value) => value === status).length;
          expect(scrape).toMatch(
            new RegExp(`http_requests_total\\{[^}]*status="${status}"[^}]*\\} ${count}\\b`),
          );
        }
        // Without errorHandler the kernel serves a 4xx hint — the 409 hint and a
        // 4xx HttpError, which carries one — and 500 for the rest.
        if (!handler)
          expect(Object.fromEntries(served)).toEqual({
            '/conflict': 409,
            '/outage': 500,
            '/missing': 404,
            '/fault': 500,
          });
      } finally {
        await app.stop();
      }
    });
  }
});
