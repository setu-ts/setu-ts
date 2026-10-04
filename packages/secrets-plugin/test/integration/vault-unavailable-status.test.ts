/**
 * M101a V8-4 end to end: a Vault that never answers costs the caller at most
 * `requestTimeoutMs` and answers `503 Service Unavailable` with the fixed
 * sentence — not a 60 s hang, and not a masked `500`.
 *
 * A real kernel app with the real `RuntimePlugin` timers (the plugin hands
 * them to the provider) and a hanging injected `http`. The read cache is off,
 * so every request reaches the provider.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IRequestContext, ISecretManager } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';

import { SecretsPlugin } from '../../src/index.ts';

const BOUND_MS = 100;

describe('an unreachable Vault answers 503 within the bound (M101a V8-4)', () => {
  it('a hanging read reaches the caller as Problem Details 503', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SecretsPlugin({
          provider: 'vault',
          options: {
            address: 'https://vault.invalid',
            token: 'tok',
            cacheTtl: 0,
            requestTimeoutMs: BOUND_MS,
            http: () => new Promise<Response>(() => {}),
          },
        }),
      ],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
    app.router.get('/secret', {
      handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
        const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
        return ctx.response.json({ value: await secrets.get('database/password') });
      },
    });
    await app.start();
    try {
      const started = performance.now();
      const response = await app.inject({ method: 'GET', url: 'http://localhost/secret' });
      const elapsed = performance.now() - started;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'The secrets provider is temporarily unreachable.',
        instance: '/secret',
      });
      // Within the bound, with slack for scheduling — never the transport's
      // own (minutes-long) timeout.
      expect(elapsed).toBeLessThan(BOUND_MS * 10);
    } finally {
      await app.stop();
    }
  });
});
