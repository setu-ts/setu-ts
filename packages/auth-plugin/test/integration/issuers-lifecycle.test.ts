/**
 * Outside-issuer lifecycle and failure containment through a real kernel app:
 * `app.stop()` aborts an in-flight key-set fetch, and a throwing logger does
 * not abort the rest of the strategy chain.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireAuth } from '../../src/index.ts';
import type { IAuthHttp, TrustedIssuer } from '../../src/index.ts';
import { generateTestKey, signToken } from '../fixtures/issuer-tokens.ts';

const ISS = 'https://idp.test';

const issuer: TrustedIssuer = {
  name: 'idp',
  issuer: ISS,
  audience: 'api',
  keys: { jwksUri: 'https://idp.test/jwks' },
  toPrincipal: (claims) => ({ id: String(claims.sub) }),
};

function throwingLogger(): IPlugin {
  const boom = (): never => {
    throw new Error('logger transport down');
  };
  const logger: ILogger = {
    level: 'trace',
    fatal: boom,
    error: boom,
    warn: boom,
    info: boom,
    debug: boom,
    trace: boom,
    child: () => logger,
  };
  return {
    name: 'throwing-logger',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    register: (ctx) => ctx.services.register(CAPABILITIES.LOGGER, logger),
  };
}

describe('outside issuers — lifecycle and containment', () => {
  it('aborts an in-flight key-set fetch when the application stops', async () => {
    let aborted = false;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    const http: IAuthHttp = {
      get: (_url, { signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      },
      post: () => Promise.reject(new Error('post is not expected by this fixture')),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ http, issuers: [{ ...issuer, keySet: { fetchTimeoutMs: 60_000 } }] }),
      ],
    });
    await app.start();
    const key = await generateTestKey('ES256', 'k1');
    const token = await signToken(key, { iss: ISS, aud: 'api', sub: 'u', exp: 9_999_999_999 });
    const pending = app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${token}` },
    });
    await fetching;
    const stoppedAt = performance.now();
    await app.stop();
    // Far below the 60 s fetch timeout: it was the stop that aborted it.
    expect(performance.now() - stoppedAt).toBeLessThan(10_000);
    expect(aborted).toBe(true);
    await pending;
  });

  it('keeps authenticating through later strategies when the logger throws', async () => {
    const http: IAuthHttp = {
      get: () => Promise.resolve({ status: 503, body: '' }),
      post: () => Promise.reject(new Error('post is not expected by this fixture')),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        throwingLogger(),
        AuthPlugin({
          http,
          issuers: [issuer],
          apiKey: { validate: (key) => Promise.resolve(key === 'k' ? { id: 'api-user' } : null) },
        }),
      ],
    });
    app.router.get('/me', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json(ctx.request.user),
    });
    await app.start();
    try {
      const key = await generateTestKey('ES256', 'k1');
      const token = await signToken(key, { iss: ISS, aud: 'api', sub: 'u', exp: 9_999_999_999 });
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${token}`, 'x-api-key': 'k' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 'api-user' });
    } finally {
      await app.stop();
    }
  });
});
