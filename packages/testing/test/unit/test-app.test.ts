import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '../../src/test-app.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';

// Fake runtime service for mock-based tests (unit tier)
const fakeRuntime: IRuntimeServices = {
  platform: () => 'deno',
  version: () => '0.0.0',
  hostname: () => 'localhost',
  uuid: () => 'test-uuid',
  randomBytes: (_length: number) => new Uint8Array(0),
  subtle: null as unknown as SubtleCrypto,
  now: () => 0,
  hrtime: () => 0,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: clearTimeout.bind(globalThis),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: clearInterval.bind(globalThis),
  env: {} as Readonly<Record<string, string | undefined>>,
  exit: () => {
    throw new Error('exit');
  },
};

describe('createTestApp', () => {
  it('rejects with kernel mandatory-runtime message when plugins lacks runtime capability', async () => {
    // Empty plugin list — no runtime provider
    try {
      await createTestApp({ plugins: [] });
      expect(false).toBe(true); // should not reach here
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain("No plugin provides the mandatory 'runtime' capability");
    }
  });

  it('autoStart: false with empty list resolves without calling start()', async () => {
    const app = await createTestApp({ plugins: [], autoStart: false });
    // If start() were called, this would have thrown because no runtime provider.
    expect(app).toBeDefined();
    await app.stop();
  });

  it('autoStart: false app accepts middleware.add then subsequent start()', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime-mock',
      service: fakeRuntime,
      provides: CAPABILITIES.RUNTIME,
    });

    // Create an app with autoStart: false and the runtime mock
    const app2 = await createTestApp({
      plugins: [runtimeMock],
      autoStart: false,
    });
    // The app was NOT started yet, so middleware.add should work.
    app2.middleware.add(async (_ctx, next) => {
      await next();
    });
    await app2.start();
    await app2.stop();
  });

  it('auto-started app throws on middleware.add after start()', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime-mock',
      service: fakeRuntime,
      provides: CAPABILITIES.RUNTIME,
    });

    const app = await createTestApp({ plugins: [runtimeMock] });
    let threw = false;
    try {
      app.middleware.add(async (_ctx, next) => {
        await next();
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await app.stop();
  });

  it('second start() throws "Application has already been started."', async () => {
    const runtimeMock = createMockPlugin({
      name: 'runtime-mock',
      service: fakeRuntime,
      provides: CAPABILITIES.RUNTIME,
    });

    const app = await createTestApp({ plugins: [runtimeMock] });
    let threw = false;
    try {
      await app.start();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await app.stop();
  });

  it('createTestApp() with undefined options rejects (no runtime provider)', async () => {
    try {
      await createTestApp();
      expect(false).toBe(true); // should not reach here
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain("No plugin provides the mandatory 'runtime' capability");
    }
  });
});
