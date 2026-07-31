/**
 * Integration tests for `createFullStackAppFromConfig`.
 *
 * These drive the REAL path: real runtime services over the real process
 * environment, a real configuration load, and a real kernel boot — because the
 * whole point of the factory is the ordering between those three, which a fake
 * runtime would let pass while the ordering was wrong.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IConfig } from '@hono-enterprise/common';

import { createFullStackAppFromConfig } from '../../src/from-config.ts';

/** Sets env vars for the duration of one case, then restores the environment. */
async function withEnv(
  vars: Readonly<Record<string, string>>,
  run: () => Promise<void>,
): Promise<void> {
  for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
  try {
    await run();
  } finally {
    for (const key of Object.keys(vars)) Deno.env.delete(key);
  }
}

describe('createFullStackAppFromConfig | configuration drives composition', () => {
  it('a value from the environment reaches a gated plugin arm', async () => {
    await withEnv({ HONOE_M36C_REALTIME: 'on' }, async () => {
      const app = await createFullStackAppFromConfig((config) =>
        config.get<string>('HONOE_M36C_REALTIME') === 'on' ? { realtime: { sse: {} } } : {}
      );
      await app.start();

      expect(app.services.has(CAPABILITIES.SSE)).toBe(true);
    });
  });

  it('the same resolver registers nothing when the value is absent', async () => {
    // The negative half: without it the assertion above would pass even if the
    // arm were registered unconditionally.
    const app = await createFullStackAppFromConfig((config) =>
      config.get<string>('HONOE_M36C_REALTIME') === 'on' ? { realtime: { sse: {} } } : {}
    );
    await app.start();

    expect(app.services.has(CAPABILITIES.SSE)).toBe(false);
  });

  it('forwards its loading options to the loader', async () => {
    await withEnv(
      { HONOE_M36C_HOST: 'db.internal', HONOE_M36C_URL: 'pg://${HONOE_M36C_HOST}/x' },
      async () => {
        let seen: string | undefined;
        const app = await createFullStackAppFromConfig((config) => {
          seen = config.get<string>('HONOE_M36C_URL');
          return {};
        }, { config: { expandVariables: false } });
        await app.start();

        // Non-default option honoured: the reference is left literal.
        expect(seen).toBe('pg://${HONOE_M36C_HOST}/x');
      },
    );
  });

  it('expands references by default, so the option above is what changed it', async () => {
    await withEnv(
      { HONOE_M36C_HOST: 'db.internal', HONOE_M36C_URL: 'pg://${HONOE_M36C_HOST}/x' },
      async () => {
        let seen: string | undefined;
        const app = await createFullStackAppFromConfig((config) => {
          seen = config.get<string>('HONOE_M36C_URL');
          return {};
        });
        await app.start();

        expect(seen).toBe('pg://db.internal/x');
      },
    );
  });
});

describe('createFullStackAppFromConfig | the env override', () => {
  // Cloudflare Workers is the case this exists for: bindings arrive as the
  // `env` argument of the fetch handler, never process-wide, so runtime
  // services built before a request report an EMPTY environment there. Without
  // the override the resolver sees nothing and a `getOrThrow` composition
  // fails on the first request — and every request after it, because the boot
  // promise is memoised.
  it('reads configuration from the supplied env instead of the platform', async () => {
    let seen: string | undefined;

    const app = await createFullStackAppFromConfig((config) => {
      seen = config.get<string>('HONOE_M36C_BINDING');
      return {};
    }, { env: { HONOE_M36C_BINDING: 'from-the-binding' } });
    await app.start();

    expect(seen).toBe('from-the-binding');
  });

  it('drives a plugin arm from a binding the platform environment does not have', async () => {
    // The end the override exists for: composition decided by a Workers
    // binding. This value is NOT in Deno.env, so it can only come from `env`.
    const app = await createFullStackAppFromConfig(
      (config) =>
        config.get<string>('HONOE_M36C_REALTIME') === 'on' ? { realtime: { sse: {} } } : {},
      { env: { HONOE_M36C_REALTIME: 'on' } },
    );
    await app.start();

    expect(app.services.has(CAPABILITIES.SSE)).toBe(true);
  });

  it('ignores non-string bindings, which are not configuration', async () => {
    // A real Workers env mixes strings with KV/D1/R2 namespace objects.
    let value: unknown;
    let hasBinding = false;

    const app = await createFullStackAppFromConfig((config) => {
      value = config.get('HONOE_M36C_TEXT');
      hasBinding = config.has('HONOE_M36C_KV');
      return {};
    }, { env: { HONOE_M36C_TEXT: 'kept', HONOE_M36C_KV: { get: () => undefined } } });
    await app.start();

    expect(value).toBe('kept');
    expect(hasBinding).toBe(false);
  });

  it('falls back to the platform environment when no env is supplied', async () => {
    await withEnv({ HONOE_M36C_PLATFORM: 'from-platform' }, async () => {
      let seen: string | undefined;

      const app = await createFullStackAppFromConfig((config) => {
        seen = config.get<string>('HONOE_M36C_PLATFORM');
        return {};
      });
      await app.start();

      expect(seen).toBe('from-platform');
    });
  });

  it('the supplied env replaces the platform environment rather than merging', async () => {
    // Workers has no process environment to merge with, and merging would let
    // a developer machine's variables mask a missing binding in production.
    await withEnv({ HONOE_M36C_PLATFORM: 'from-platform' }, async () => {
      let seen: string | undefined;

      const app = await createFullStackAppFromConfig((config) => {
        seen = config.get<string>('HONOE_M36C_PLATFORM');
        return {};
      }, { env: { SOMETHING_ELSE: 'x' } });
      await app.start();

      expect(seen).toBeUndefined();
    });
  });
});

describe('createFullStackAppFromConfig | one snapshot', () => {
  it('registers the exact object the resolver received', async () => {
    let seen: IConfig | undefined;

    const app = await createFullStackAppFromConfig((config) => {
      seen = config;
      return {};
    });
    await app.start();

    const registered = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    // Identity, not equality: a second load would produce an equal snapshot and
    // still be the bug this asserts against.
    expect(registered).toBe(seen);
  });

  it('serves the composed value from the same snapshot at request time', async () => {
    await withEnv({ HONOE_M36C_GREETING: 'from-config' }, async () => {
      const app = await createFullStackAppFromConfig((config) => {
        expect(config.get<string>('HONOE_M36C_GREETING')).toBe('from-config');
        return {};
      });
      app.router.get('/greeting', (ctx) => {
        const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
        return ctx.response.text(config.get<string>('HONOE_M36C_GREETING') ?? 'missing');
      });
      await app.start();

      const response = await app.inject({ method: 'GET', url: '/greeting' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('from-config');
    });
  });
});

describe('createFullStackAppFromConfig | failure paths', () => {
  it('rejects with the resolver error and returns no application', async () => {
    await expect(
      createFullStackAppFromConfig(() => {
        throw new Error('resolver failed');
      }),
    ).rejects.toThrow('resolver failed');
  });

  it('rejects when configuration cannot be loaded, before any plugin is built', async () => {
    let resolverCalled = false;

    await expect(
      createFullStackAppFromConfig(() => {
        resolverCalled = true;
        return {};
      }, { config: { envFilePath: '/nonexistent/.env' } }),
    ).rejects.toThrow();

    // Load failure precedes composition: the resolver never ran.
    expect(resolverCalled).toBe(false);
  });
});
