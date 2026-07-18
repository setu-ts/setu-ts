/**
 * Tests for self-indicator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createSelfIndicator } from '../../src/indicators/self-indicator.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

describe('createSelfIndicator', () => {
  function createFakeRuntime(overrides?: Partial<IRuntimeServices>): IRuntimeServices {
    return {
      now: () => 1_000_000_000_000,
      hrtime: () => 0,
      platform: () =>
        (overrides?.platform?.() ?? 'node') as import('@hono-enterprise/common').RuntimePlatform,
      version: () => overrides?.version?.() ?? '18.0.0',
      hostname: () => overrides?.hostname?.() ?? 'test-host',
      uuid: () => '00000000-0000-0000-0000-000000000000',
      randomBytes: () => new Uint8Array(32),
      subtle: {} as Crypto['subtle'],
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      env: {} as Record<string, string | undefined>,
      exit: (() => {
        throw new Error('exit called');
      }) as () => never,
      fs: {} as IRuntimeServices['fs'],
    } as IRuntimeServices;
  }

  it('should have name "self"', () => {
    const runtime = createFakeRuntime();
    const indicator = createSelfIndicator(runtime);

    expect(indicator.name).toBe('self');
  });

  it('should always return status "up"', async () => {
    const runtime = createFakeRuntime();
    const indicator = createSelfIndicator(runtime);

    const result = await indicator.check();

    expect(result.status).toBe('up');
  });

  it('should include platform in data', async () => {
    const runtime = createFakeRuntime({
      platform: () => 'linux' as import('@hono-enterprise/common').RuntimePlatform,
    });
    const indicator = createSelfIndicator(runtime);

    const result = await indicator.check();

    expect(result.data).toEqual(
      expect.objectContaining({
        platform: 'linux',
      }),
    );
  });

  it('should include version in data', async () => {
    const runtime = createFakeRuntime({
      version: () => '20.0.0',
    });
    const indicator = createSelfIndicator(runtime);

    const result = await indicator.check();

    expect(result.data).toEqual(
      expect.objectContaining({
        version: '20.0.0',
      }),
    );
  });

  it('should include hostname in data', async () => {
    const runtime = createFakeRuntime({
      hostname: () => 'my-hostname',
    });
    const indicator = createSelfIndicator(runtime);

    const result = await indicator.check();

    expect(result.data).toEqual(
      expect.objectContaining({
        hostname: 'my-hostname',
      }),
    );
  });

  it('should include all platform diagnostics', async () => {
    const runtime = createFakeRuntime({
      platform: () => 'darwin' as import('@hono-enterprise/common').RuntimePlatform,
      version: () => '19.5.0',
      hostname: () => 'localhost',
    });
    const indicator = createSelfIndicator(runtime);

    const result = await indicator.check();

    expect(result.data).toEqual({
      platform: 'darwin',
      version: '19.5.0',
      hostname: 'localhost',
    });
  });
});
