/**
 * X20-2 end to end: a write against a read-only provider answers `501 Not
 * Implemented` with the class's own sentence, not a masked `500`.
 *
 * BOTH entry points are driven because funnelling through one throw site is
 * the claim under test: `SecretsService.rotate()` delegates to
 * `provider.set()`, so the HTTP route and a direct provider `set` must answer
 * identically — and each is asserted under `'default'` and `'rfc9457'`, the
 * two formats the framework serves (the M56 lesson: the media type is keyed
 * off the responder, not the hint, so the format is part of the claim).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IRequestContext, ISecretManager } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { type ErrorFormat, errorHandler } from '@setu-ts/exceptions';

import { EnvProvider, ReadOnlySecretProviderError, SecretsPlugin } from '../../src/index.ts';

function bootReadOnlyApp(format: ErrorFormat): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [RuntimePlugin(), SecretsPlugin()],
  });
  app.middleware.add(errorHandler({ format }), { priority: 10, name: 'errors' });
  app.router.post('/rotate/:name', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      const name = ctx.params['name'] ?? '';
      await secrets.rotate(name, 'next-value');
      return ctx.response.json({});
    },
  });
  app.router.post('/direct/:name', {
    handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
      // A provider write that bypasses the service, straight through the
      // same throw site `rotate()` reaches.
      const provider = new EnvProvider({ APP_TOKEN: 'x' }, { prefix: 'APP_' });
      const name = ctx.params['name'] ?? '';
      await provider.set(name, 'next-value');
      return ctx.response.json({});
    },
  });
  return app;
}

describe('a read-only provider write answers 501 (X20-2)', () => {
  for (const format of ['rfc9457', 'default'] as const) {
    it(`rotate through the service answers 501 under '${format}'`, async () => {
      const app = bootReadOnlyApp(format);
      await app.start();
      try {
        const response = await app.inject({
          method: 'POST',
          url: 'http://localhost/rotate/token',
        });
        expect(response.statusCode, format).toBe(501);
        expect(response.headers.get('content-type') ?? '', format).toContain(
          format === 'rfc9457' ? 'application/problem+json' : 'application/json',
        );
        const body = response.json() as Record<string, unknown>;
        if (format === 'rfc9457') {
          expect(body).toEqual({
            type: 'about:blank',
            title: 'Not Implemented',
            status: 501,
            detail:
              "The 'EnvProvider' secrets provider is read-only and cannot store or rotate secrets.",
            instance: '/rotate/token',
          });
        } else {
          // The `default` format is `{ statusCode, message, details }` — the
          // status member is `statusCode`, the title is `message`, and the
          // disclosure rides `details.detail`.
          expect(body.statusCode).toBe(501);
          expect(body.message).toBe('Not Implemented');
          expect((body.details as Record<string, unknown>).detail).toBe(
            "The 'EnvProvider' secrets provider is read-only and cannot store or rotate secrets.",
          );
        }
        // The service's own diagnostic message stays log-only.
        expect(JSON.stringify(body)).not.toContain('cannot be rotated at runtime');
      } finally {
        await app.stop();
      }
    });

    it(`a direct provider set answers 501 under '${format}' — one throw site, both doors`, async () => {
      const app = bootReadOnlyApp(format);
      await app.start();
      try {
        const response = await app.inject({
          method: 'POST',
          url: 'http://localhost/direct/token',
        });
        expect(response.statusCode, format).toBe(501);
        const body = response.json() as Record<string, unknown>;
        if (format === 'rfc9457') {
          expect(body.status).toBe(501);
          expect(body.detail).toBe(
            "The 'EnvProvider' secrets provider is read-only and cannot store or rotate secrets.",
          );
        } else {
          expect(body.statusCode).toBe(501);
          expect((body.details as Record<string, unknown>).detail).toBe(
            "The 'EnvProvider' secrets provider is read-only and cannot store or rotate secrets.",
          );
        }
      } finally {
        await app.stop();
      }
    });
  }

  it('the rejection is class-typed at the call site — the instanceof a retry loop needs', async () => {
    const provider = new EnvProvider({}, {});
    try {
      await provider.set('k', 'v');
      throw new Error('set should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlySecretProviderError);
      expect((error as ReadOnlySecretProviderError).provider).toBe('EnvProvider');
    }
  });
});
