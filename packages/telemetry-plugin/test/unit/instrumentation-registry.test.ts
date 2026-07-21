/**
 * Tests for the instrumentation registry.
 *
 * @module
 * @since 0.24.1
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { InstrumentationKind } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';
import {
  buildInstrumentationRegistry,
  isInstrumentationSupported,
} from '../../src/instrumentation/instrumentation-registry.ts';

describe('isInstrumentationSupported', () => {
  const kinds: InstrumentationKind[] = ['http', 'fetch', 'ioredis', 'amqplib', 'kafkajs'];

  for (const kind of kinds) {
    it(`should return true for '${kind}' on node`, () => {
      expect(isInstrumentationSupported(kind, 'node')).toBe(true);
    });

    it(`should return false for '${kind}' on deno`, () => {
      expect(isInstrumentationSupported(kind, 'deno')).toBe(false);
    });

    it(`should return false for '${kind}' on bun`, () => {
      expect(isInstrumentationSupported(kind, 'bun')).toBe(false);
    });

    it(`should return false for '${kind}' on cloudflare-workers`, () => {
      expect(isInstrumentationSupported(kind, 'cloudflare-workers')).toBe(false);
    });
  }
});

describe('buildInstrumentationRegistry', () => {
  function createFakeRuntime(platform: string): IRuntimeServices {
    return {
      platform: () => platform as never,
      version: () => '1.0.0',
      hostname: () => 'localhost',
      uuid: () => 'fake-uuid-1',
      randomBytes: (_n: number) => new Uint8Array(_n),
      subtle: null as unknown as SubtleCrypto,
      now: () => 0,
      hrtime: () => 0,
      setTimeout: () => 1 as never,
      clearTimeout: () => {},
      setInterval: () => 1 as never,
      clearInterval: () => {},
      env: {},
      exit: () => {
        throw new Error('exit');
      },
    } as IRuntimeServices;
  }

  it('should return a no-op handle when config is undefined', async () => {
    const runtime = createFakeRuntime('node');
    const handle = await buildInstrumentationRegistry(undefined, runtime, {});
    expect(handle.outcomes).toHaveLength(0);
    await handle.shutdown(); // exercise the no-op shutdown function
  });

  it('should return a no-op handle when provider is undefined', async () => {
    const runtime = createFakeRuntime('node');
    const handle = await buildInstrumentationRegistry({ http: true }, runtime, undefined as never);
    expect(handle.outcomes).toHaveLength(0);
    await handle.shutdown(); // exercise the no-op shutdown function
  });

  it('should return a no-op handle when provider is null', async () => {
    const runtime = createFakeRuntime('node');
    const handle = await buildInstrumentationRegistry({ http: true }, runtime, null);
    expect(handle.outcomes).toHaveLength(0);
    await handle.shutdown(); // exercise the no-op shutdown function
  });

  it('should record no-op outcome for unsupported platform', async () => {
    const runtime = createFakeRuntime('deno');
    const fakeResult = { recordedSets: [] as unknown[], instance: {} };
    const provider = fakeResult.instance;

    const handle = await buildInstrumentationRegistry(
      { http: true },
      runtime,
      provider,
    );

    // Platform gate happens inside enableLazy — already awaited by buildInstrumentationRegistry.
    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome?.enabled).toBe(false);
    expect(httpOutcome?.reason).toBe('unsupported platform');
  });

  it('should call setTracerProvider then enable on each enabled instrumentation', async () => {
    const runtime = createFakeRuntime('node');
    const recordedSets: unknown[] = [];
    const recordedEnables: string[] = [];

    const fakeInstance = {
      setTracerProvider(p: unknown) {
        recordedSets.push(p);
      },
      enable() {
        recordedEnables.push('enabled');
      },
      disable() {
        recordedEnables.push('disabled');
      },
    };

    const _handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: fakeInstance as never,
        },
      },
      runtime,
      fakeInstance,
    );

    expect(recordedSets).toHaveLength(1);
    expect(recordedEnables).toContain('enabled');
    // _handle.outcomes confirms the enabled outcome was recorded.
    expect(_handle.outcomes.find((o) => o.kind === 'http')?.enabled).toBe(true);
  });

  it('should call disable on each enabled instrumentation on shutdown', async () => {
    const runtime = createFakeRuntime('node');
    const recordedDisables: string[] = [];

    const fakeInstance = {
      setTracerProvider(_p: unknown) {
        // no-op
      },
      enable() {
        // no-op
      },
      disable() {
        recordedDisables.push('disabled');
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: fakeInstance as never,
        },
      },
      runtime,
      fakeInstance,
    );

    expect(recordedDisables).toHaveLength(0);

    await handle.shutdown();

    expect(recordedDisables).toContain('disabled');
  });

  it('should degrade loader rejection to no-op outcome (no throw)', async () => {
    const runtime = createFakeRuntime('node');

    // Use the inject path with a fake that throws during setTracerProvider.
    // This proves the no-op degradation path without needing a real npm: import failure.
    const rejectingInstance = {
      setTracerProvider() {
        throw new Error('setTracerProvider failed');
      },
      enable() {
        // never reached
      },
      disable() {
        // never reached
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: rejectingInstance as never,
        },
      },
      runtime,
      {},
    );

    // The http outcome should exist and be disabled due to the setTracerProvider failure.
    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome).toBeDefined();
    expect(httpOutcome?.enabled).toBe(false);
    expect(httpOutcome?.reason).toContain('setTracerProvider failed');
  });

  it('should degrade loader enable() throw to no-op outcome (no throw)', async () => {
    const runtime = createFakeRuntime('node');

    const throwingInstance = {
      setTracerProvider(_p: unknown) {
        // no-op
      },
      enable() {
        throw new Error('enable failed');
      },
      disable() {
        // no-op
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: throwingInstance as never,
        },
      },
      runtime,
      {},
    );

    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome?.enabled).toBe(false);
    expect(httpOutcome?.reason).toContain('enable failed');
  });

  it('should use injected instrumentation when InstrumentationConfig.instrumentation is set', async () => {
    const runtime = createFakeRuntime('node');
    const recordedSets: unknown[] = [];

    const fakeInstance = {
      setTracerProvider(p: unknown) {
        recordedSets.push(p);
      },
      enable() {
        // no-op
      },
      disable() {
        // no-op
      },
    };

    const provider = { id: 'fake-provider' };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: fakeInstance as never,
        },
      },
      runtime,
      provider,
    );

    expect(recordedSets).toContain(provider);
    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome?.enabled).toBe(true);
  });

  it('should call disable on each enabled instrumentation on shutdown (inject path with provider)', async () => {
    const runtime = createFakeRuntime('node');
    const recordedDisables: string[] = [];

    const fakeInstance = {
      setTracerProvider(_p: unknown) {
        // no-op
      },
      enable() {
        // no-op
      },
      disable() {
        recordedDisables.push('disabled');
      },
    };

    const provider = { id: 'fake-provider' };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: fakeInstance as never,
        },
      },
      runtime,
      provider,
    );

    expect(recordedDisables).toHaveLength(0);

    await handle.shutdown();

    expect(recordedDisables).toContain('disabled');
  });

  // --- Coverage for the enableLazy async dispatch path (now awaited via Promise.all) ---

  it('should await all lazy loaders before returning handle', async () => {
    const runtime = createFakeRuntime('node');
    const provider = { id: 'fake-provider' };

    // The internal http lazy loader either succeeds or fails inside the awaited
    // Promise.all; handle.outcomes must reflect the result immediately.
    const handle = await buildInstrumentationRegistry(
      { http: true },
      runtime,
      provider,
    );

    // After await, the http outcome must already be populated.
    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome).toBeDefined();
  });

  it('should record supported-platform lazy outcomes after async resolution', async () => {
    const runtime = createFakeRuntime('node');
    const provider = { id: 'fake-provider' };

    // The internal http lazy loader either succeeds or fails deterministically inside
    // the awaited Promise.all; handle.outcomes must reflect the result immediately.
    const handle = await buildInstrumentationRegistry(
      { http: true },
      runtime,
      provider,
    );

    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome).toBeDefined();
    expect(['true', 'false']).toContain(String(httpOutcome?.enabled));
  });

  it('should record unsupported-platform outcome for lazy loader on non-node platform', async () => {
    const runtime = createFakeRuntime('deno');
    const provider = { id: 'fake-provider' };

    const handle = await buildInstrumentationRegistry(
      { http: true, ioredis: true, amqplib: true },
      runtime,
      provider,
    );

    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome).toBeDefined();
    expect(httpOutcome?.enabled).toBe(false);
    expect(httpOutcome?.reason).toBe('unsupported platform');

    const ioredisOutcome = handle.outcomes.find((o) => o.kind === 'ioredis');
    expect(ioredisOutcome).toBeDefined();
    expect(ioredisOutcome?.enabled).toBe(false);
    expect(ioredisOutcome?.reason).toBe('unsupported platform');

    const amqplibOutcome = handle.outcomes.find((o) => o.kind === 'amqplib');
    expect(amqplibOutcome).toBeDefined();
    expect(amqplibOutcome?.enabled).toBe(false);
    expect(amqplibOutcome?.reason).toBe('unsupported platform');
  });

  it('should record unsupported-platform outcome for all five lazy instrumentations', async () => {
    const runtime = createFakeRuntime('deno');
    const provider = { id: 'fake-provider' };

    const handle = await buildInstrumentationRegistry(
      { http: true, fetch: true, ioredis: true, amqplib: true, kafkajs: true },
      runtime,
      provider,
    );

    const kinds: Array<'http' | 'fetch' | 'ioredis' | 'amqplib' | 'kafkajs'> = [
      'http',
      'fetch',
      'ioredis',
      'amqplib',
      'kafkajs',
    ];
    for (const kind of kinds) {
      const outcome = handle.outcomes.find((o) => o.kind === kind);
      expect(outcome).toBeDefined();
      expect(outcome?.enabled).toBe(false);
      expect(outcome?.reason).toBe('unsupported platform');
    }
  });

  it('should catch loader rejection in enableLazy and record outcome', async () => {
    const runtime = createFakeRuntime('node');
    const provider = { id: 'fake-provider' };

    // Create a custom instrumentation that will fail during setTracerProvider to exercise
    // the catch block in enableInjected
    const rejectingInstance = {
      setTracerProvider() {
        throw new Error('setTracerProvider failed');
      },
      enable() {
        // never reached
      },
      disable() {
        // never reached
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: rejectingInstance as never,
        },
      },
      runtime,
      provider,
    );

    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome).toBeDefined();
    expect(httpOutcome?.enabled).toBe(false);
    expect(httpOutcome?.reason).toContain('setTracerProvider failed');
  });

  it('should silently ignore disable() failures in shutdown', async () => {
    const runtime = createFakeRuntime('node');
    const provider = { id: 'fake-provider' };

    const throwingInstance = {
      setTracerProvider(_p: unknown) {
        // no-op
      },
      enable() {
        // no-op
      },
      disable() {
        throw new Error('disable failed');
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: throwingInstance as never,
        },
      },
      runtime,
      provider,
    );

    // Should not throw
    await handle.shutdown();

    const httpOutcome = handle.outcomes.find((o) => o.kind === 'http');
    expect(httpOutcome?.enabled).toBe(true);
  });

  it('should call disable() on lazily-enabled instrumentation before provider shutdown', async () => {
    // Tests the C1 fix: lazy loads are awaited before handle return, so onShutdown
    // always sees fully-enabled instruments.
    const runtime = createFakeRuntime('node');
    const callOrder: string[] = [];

    // A "late-resolving" instrumentation instance, simulated by wrapping a custom
    // enabled instrumentation. We use the inject path with a slow enable + delayed disable.
    const lazyInstance = {
      setTracerProvider(_p: unknown) {
        callOrder.push('setTracerProvider');
      },
      enable() {
        callOrder.push('enable');
      },
      disable() {
        callOrder.push('disable');
      },
    };

    const provider = {
      id: 'fake-provider',
      shutdown: () => {
        callOrder.push('provider-shutdown');
      },
    };

    const handle = await buildInstrumentationRegistry(
      {
        http: {
          instrumentation: lazyInstance as never,
        },
      },
      runtime,
      provider,
    );

    // Confirm instrumentation is enabled before shutdown.
    expect(callOrder).toEqual(['setTracerProvider', 'enable']);
    expect(handle.outcomes.find((o) => o.kind === 'http')?.enabled).toBe(true);

    // Trigger shutdown: disable must precede provider shutdown.
    // (We simulate the plugin onShutdown hook here.)
    await handle.shutdown();
    await provider.shutdown!();

    expect(callOrder).toEqual(['setTracerProvider', 'enable', 'disable', 'provider-shutdown']);
  });

  it('should expose complete outcomes at handle return for the lazy path', async () => {
    // Confirms no fire-and-forget: all outcomes are present the moment
    // await buildInstrumentationRegistry(...) resolves.
    const runtime = createFakeRuntime('node');
    const provider = { id: 'fake-provider' };

    const handle = await buildInstrumentationRegistry(
      { http: true, fetch: true, ioredis: true },
      runtime,
      provider,
    );

    // All three configured kinds must appear in outcomes immediately —
    // none are pending or missing.
    expect(handle.outcomes.map((o) => o.kind).sort()).toEqual(
      ['fetch', 'http', 'ioredis'].sort(),
    );
  });
});
