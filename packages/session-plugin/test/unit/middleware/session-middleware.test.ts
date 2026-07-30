/**
 * Unit tests for the session middleware's load/commit bracketing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISession } from '@hono-enterprise/common';

import { deriveKeyRing } from '../../../src/codec/crypto.ts';
import { sessionMiddleware } from '../../../src/middleware/session-middleware.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import type { SessionPluginOptions } from '../../../src/options.ts';
import { SESSION_STATE_KEY, SessionService } from '../../../src/services/session-service.ts';
import { makeClock, makeContext } from '../../fixtures/context.ts';

const SECRET = 'm'.repeat(32);

async function makeMiddleware(options: SessionPluginOptions = {}) {
  const clock = makeClock();
  const service = new SessionService(
    resolveSessionConfig(options),
    await deriveKeyRing(crypto.subtle, [SECRET], options.mode ?? 'encrypt'),
    {
      subtle: crypto.subtle,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now: clock.now,
      uuid: clock.uuid,
    },
  );
  return { middleware: sessionMiddleware(service), service, clock };
}

describe('sessionMiddleware', () => {
  it('parks the session in ctx.state before the handler runs', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx } = makeContext();
    let seen: unknown;

    await middleware(ctx, () => {
      seen = ctx.state.get(SESSION_STATE_KEY);
      return Promise.resolve();
    });

    expect(seen).toBeDefined();
    expect((seen as ISession).isNew).toBe(true);
  });

  it('commits after the handler, so a handler mutation is persisted', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();

    await middleware(ctx, () => {
      (ctx.state.get(SESSION_STATE_KEY) as ISession).set('a', 1);
      return Promise.resolve();
    });

    expect(response.setCookies().length).toBe(1);
  });

  it('emits no cookie when the handler only reads', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();

    await middleware(ctx, () => {
      (ctx.state.get(SESSION_STATE_KEY) as ISession).get('a');
      return Promise.resolve();
    });

    expect(response.setCookies().length).toBe(0);
  });

  it('appends the cookie even after the handler ended the response', async () => {
    // The property the whole design rests on: the kernel's response builder
    // appends headers without consulting whether a terminal method ran.
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();

    await middleware(ctx, () => {
      (ctx.state.get(SESSION_STATE_KEY) as ISession).set('a', 1);
      ctx.response.json({ done: true });
      return Promise.resolve();
    });

    expect(response.ended).toBe(true);
    expect(response.setCookies().length).toBe(1);
  });

  it('preserves a cookie another producer already set', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();

    await middleware(ctx, () => {
      ctx.response.appendHeader('set-cookie', 'other=value; Path=/');
      (ctx.state.get(SESSION_STATE_KEY) as ISession).set('a', 1);
      return Promise.resolve();
    });

    const cookies = response.setCookies();
    expect(cookies.length).toBe(2);
    expect(cookies.some((c) => c.startsWith('other=value'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('hono_session='))).toBe(true);
  });

  it('does not commit when the handler throws', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();

    await expect(middleware(ctx, () => {
      (ctx.state.get(SESSION_STATE_KEY) as ISession).set('a', 1);
      return Promise.reject(new Error('handler blew up'));
    })).rejects.toThrow('handler blew up');

    // A failed request must not persist a half-applied mutation.
    expect(response.setCookies().length).toBe(0);
  });

  it('restores a session from the cookie it previously emitted', async () => {
    const { middleware } = await makeMiddleware();

    const write = makeContext();
    await middleware(write.ctx, () => {
      (write.ctx.state.get(SESSION_STATE_KEY) as ISession).set('count', 7);
      return Promise.resolve();
    });
    const header = write.response.setCookies()[0].split(';')[0];

    const read = makeContext({ headers: { cookie: header } });
    let restored: ISession | undefined;
    await middleware(read.ctx, () => {
      restored = read.ctx.state.get(SESSION_STATE_KEY) as ISession;
      return Promise.resolve();
    });

    expect(restored?.get<number>('count')).toBe(7);
    expect(restored?.isNew).toBe(false);
  });

  it('commits every response when rolling is on', async () => {
    const { middleware } = await makeMiddleware({ rolling: true });

    const write = makeContext();
    await middleware(write.ctx, () => {
      (write.ctx.state.get(SESSION_STATE_KEY) as ISession).set('a', 1);
      return Promise.resolve();
    });
    const header = write.response.setCookies()[0].split(';')[0];

    const read = makeContext({ headers: { cookie: header } });
    await middleware(read.ctx, () => Promise.resolve());

    expect(read.response.setCookies().length).toBe(1);
  });

  it('treats a tampered cookie as a fresh session without throwing', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx } = makeContext({ headers: { cookie: 'hono_session=v1.bogus.AQID.AQID' } });

    let session: ISession | undefined;
    await middleware(ctx, () => {
      session = ctx.state.get(SESSION_STATE_KEY) as ISession;
      return Promise.resolve();
    });

    expect(session?.isNew).toBe(true);
  });
});
