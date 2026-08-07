import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '../../src/test-app.ts';
import { inject } from '../../src/inject.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { CAPABILITIES } from '@setu-ts/common';

describe('createTestApp — integration with real app', () => {
  it('post-start route registration works through inject()', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime',
      service: {
        platform: () => 'deno' as const,
        version: () => '1.0',
        hostname: () => 'localhost',
        uuid: () => 'test-uuid',
        randomBytes: () => new Uint8Array(0),
        subtle: null as unknown as SubtleCrypto,
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: clearInterval.bind(globalThis),
        env: {} as Record<string, string>,
        exit: () => {
          throw new Error('exit');
        },
      },
      provides: CAPABILITIES.RUNTIME,
    });

    // We cannot include the HTTP_ADAPTER mock here because that would require
    // providing CAPABILITIES.HTTP_ADAPTER, which is only in the real RuntimePlugin.
    // But inject() only needs CAPABILITIES.RUNTIME, so this mock suffices.
    const app = await createTestApp({ plugins: [runtimeMock] });

    // Register route AFTER createTestApp returns (post-start)
    app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));

    const res = await inject(app, '/users');
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: number }>>();
    expect(body).toEqual([{ id: 1 }]);

    await app.stop();
  });

  it('mock service is resolvable from app.services after start', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime',
      service: {
        platform: () => 'deno' as const,
        version: () => '1.0',
        hostname: () => 'localhost',
        uuid: () => 'test-uuid',
        randomBytes: () => new Uint8Array(0),
        subtle: null as unknown as SubtleCrypto,
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: clearInterval.bind(globalThis),
        env: {} as Record<string, string>,
        exit: () => {
          throw new Error('exit');
        },
      },
      provides: CAPABILITIES.RUNTIME,
    });

    const mockDb = createMockPlugin({
      name: 'database',
      service: { query: () => [{ id: 1 }] },
      provides: CAPABILITIES.DATABASE,
    });

    const app = await createTestApp({ plugins: [runtimeMock, mockDb] });

    // The mock's service should be resolvable under its token
    const dbService = app.services.get<typeof mockDb extends { service: infer T } ? T : never>(
      CAPABILITIES.DATABASE,
    );
    expect(dbService).toBeDefined();

    // getAll should include single registrations (matching kernel semantics)
    const allDb = app.services.getAll(CAPABILITIES.DATABASE);
    expect(allDb.length).toBeGreaterThanOrEqual(1);

    await app.stop();
  });

  it('app.stop() resolves without error', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime',
      service: {
        platform: () => 'deno' as const,
        version: () => '1.0',
        hostname: () => 'localhost',
        uuid: () => 'test-uuid',
        randomBytes: () => new Uint8Array(0),
        subtle: null as unknown as SubtleCrypto,
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: clearInterval.bind(globalThis),
        env: {} as Record<string, string>,
        exit: () => {
          throw new Error('exit');
        },
      },
      provides: CAPABILITIES.RUNTIME,
    });

    const app = await createTestApp({ plugins: [runtimeMock] });
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
