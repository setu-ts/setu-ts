/** An HTTP-layer error thrown from transaction work is served as the application's own. */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler, HttpError, serviceUnavailable } from '@setu-ts/exceptions';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

async function statusOf(thrown: () => Error): Promise<number> {
  const app = createApplication({ plugins: [RuntimePlugin(), DatabasePlugin({ type: 'memory' })] });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }));
  app.router.post('/write', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      await ctx.services
        .get<IDatabaseService>(CAPABILITIES.DATABASE)
        .transaction(() => Promise.reject(thrown()));
      return ctx.response.json({});
    },
  });
  await app.start();
  try {
    return (await app.inject({ method: 'POST', url: '/write' })).statusCode;
  } finally {
    await app.stop();
  }
}

describe('transaction work leaves an HTTP-layer error as the application raised it', () => {
  it('a 503 whose message copies the SQLite NOT NULL text is served 503, not 400', async () => {
    expect(await statusOf(() => serviceUnavailable('NOT NULL constraint failed: items.name'))).toBe(
      503,
    );
  });
  it('an HttpError carrying the Prisma FK code P2003 is served at its own status', async () => {
    expect(
      await statusOf(() => Object.assign(new HttpError(502, 'Upstream'), { code: 'P2003' })),
    ).toBe(502);
  });
  it('the same message and code without a statusCode are still read as database signals', async () => {
    expect(await statusOf(() => new Error('NOT NULL constraint failed: items.name'))).toBe(400);
    expect(await statusOf(() => Object.assign(new Error('fk'), { code: 'P2003' }))).toBe(409);
  });
});
