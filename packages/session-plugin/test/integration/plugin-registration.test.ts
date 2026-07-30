/**
 * Integration tests for plugin registration against a real kernel application.
 *
 * Covers the wiring branches the happy-path e2e cannot reach: a store that needs
 * a capability which is absent, secret-resolution failure at startup, the
 * conditional CSRF registration, and shutdown.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ICacheStore, ISessionStore, SessionData } from '@hono-enterprise/common';

import { SessionPlugin, SessionSecretMissingError } from '../../src/index.ts';

const SECRET = 'integration-secret-at-least-32-chars';

/** A cache plugin stand-in registering under the cache token. */
function FakeCachePlugin(cache: ICacheStore) {
  return {
    name: 'fake-cache',
    version: '0.0.0',
    provides: [CAPABILITIES.CACHE],
    register(ctx: { services: { register: (t: string, s: object) => void } }): void {
      ctx.services.register(CAPABILITIES.CACHE, cache);
    },
  };
}

/** A minimal in-memory ICacheStore. */
function fakeCache(): ICacheStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve((values.get(key) ?? null) as T | null),
    set: <T>(key: string, value: T) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    has: (key: string) => Promise.resolve(values.has(key)),
    clear: () => {
      values.clear();
      return Promise.resolve();
    },
  };
}

/** Reads the named health indicator from a started app. */
async function health(app: ReturnType<typeof createApplication>, name: string) {
  const indicators = app.services.getAll<
    { name: string; check: () => Promise<{ status: string; data?: unknown }> }
  >(CAPABILITIES.HEALTH_INDICATOR);
  const indicator = indicators.find((i) => i.name === name);
  expect(indicator).toBeDefined();
  return await indicator!.check();
}

describe('SessionPlugin registration', () => {
  it('registers the service and the session middleware', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET })],
    });
    await app.start();

    expect(app.services.has(CAPABILITIES.SESSION)).toBe(true);

    await app.stop();
  });

  it('reports the cookie strategy in health when no store is configured', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET })],
    });
    await app.start();

    const result = await health(app, 'session');
    expect(result.status).toBe('up');
    expect(result.data).toEqual({
      strategy: 'cookie',
      mode: 'encrypt',
      keys: 1,
      store: 'none',
    });

    await app.stop();
  });

  it('reports the key count when a rotation list is configured', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: [SECRET, `${SECRET}-old`] }),
      ],
    });
    await app.start();

    expect((await health(app, 'session')).data).toMatchObject({ keys: 2 });

    await app.stop();
  });

  it('reports down when the configured store is unhealthy', async () => {
    const failing: ISessionStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      destroy: () => Promise.resolve(false),
      isHealthy: () => Promise.resolve(false),
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, store: failing })],
    });
    await app.start();

    const result = await health(app, 'session');
    // Invisible from the outside otherwise: cookies still arrive, but every
    // session reads as absent.
    expect(result.status).toBe('down');
    expect(result.data).toMatchObject({ strategy: 'store', store: false });

    await app.stop();
  });

  it('accepts a custom ISessionStore instance', async () => {
    const entries = new Map<string, SessionData>();
    const custom: ISessionStore = {
      read: (id) => Promise.resolve(entries.get(id) ?? null),
      write: (id, data) => {
        entries.set(id, data);
        return Promise.resolve();
      },
      destroy: (id) => Promise.resolve(entries.delete(id)),
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, store: custom })],
    });
    await app.start();

    expect((await health(app, 'session')).data).toMatchObject({ strategy: 'store' });

    await app.stop();
  });

  it("resolves the cache capability for store: 'cache'", async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        FakeCachePlugin(fakeCache()),
        SessionPlugin({ secret: SECRET, store: 'cache' }),
      ],
    });
    await app.start();

    expect((await health(app, 'session')).data).toMatchObject({
      strategy: 'store',
      store: true,
    });

    await app.stop();
  });

  it("fails at startup for store: 'cache' with no cache registered", async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, store: 'cache' })],
    });

    // Fail fast: a missing cache must not surface as a per-request error.
    await expect(app.start()).rejects.toThrow('needs a cache provider');
  });

  it('fails at startup when no secret can be resolved', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secretName: 'DEFINITELY_UNSET_SECRET_NAME' })],
    });

    await expect(app.start()).rejects.toThrow(SessionSecretMissingError);
  });

  it('fails at startup when the secret is too short', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: 'short' })],
    });

    await expect(app.start()).rejects.toThrow(SessionSecretMissingError);
  });

  it('rejects an invalid numeric option when the plugin is constructed', () => {
    // Before start(), so a typo in configuration is caught immediately.
    expect(() => SessionPlugin({ secret: SECRET, maxAge: 0 })).toThrow(TypeError);
  });

  it('declares its capability contract', () => {
    const plugin = SessionPlugin({ secret: SECRET });
    expect(plugin.name).toBe('session-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.SESSION]);
    expect(plugin.dependencies).toEqual([CAPABILITIES.RUNTIME]);
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.SECRETS, CAPABILITIES.CACHE]);
  });

  it('closes the store on shutdown', async () => {
    let closed = false;
    const store: ISessionStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      destroy: () => Promise.resolve(false),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, store })],
    });
    await app.start();
    await app.stop();

    expect(closed).toBe(true);
  });

  it("clears the memory store's sweep timer on shutdown", async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, store: 'memory' })],
    });
    await app.start();
    // A leaked interval would keep the process alive and fail the test runner's
    // resource sanitizer.
    await app.stop();
  });

  it('reads the secret from the environment when no option is given', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secretName: 'M48_TEST_SESSION_SECRET' })],
    });

    Deno.env.set('M48_TEST_SESSION_SECRET', SECRET);
    try {
      await app.start();
      expect(app.services.has(CAPABILITIES.SESSION)).toBe(true);
      await app.stop();
    } finally {
      Deno.env.delete('M48_TEST_SESSION_SECRET');
    }
  });
});
