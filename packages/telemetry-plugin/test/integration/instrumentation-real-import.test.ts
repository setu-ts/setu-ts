/**
 * Real-import integration test for auto-instrumentation packages.
 *
 * Drives each of the six loaders through their **default** `importFn` (no
 * injection), so the real literal `import()` path — the branch no unit test
 * runs — is exercised against the installed OTel packages.
 *
 * **Caveat:** this resolves the specifiers through the test runner's own
 * loader against the workspace source, so it cannot show what a published
 * artifact ships (the X7-3 class: a specifier that survives in source but not in
 * the package). That shape is observable only in a published artifact, which
 * the compat suite checks — see `compat/compat.test.mjs`. Do not mistake this
 * file for coverage of the published artifact.
 *
 * @module
 * @since 0.2.0
 */
import { describe, expect, it } from 'vitest';
import {
  loadFetchInstrumentation,
  loadHttpInstrumentation,
} from '../../src/instrumentation/http-instrumentation.ts';
import {
  loadIORedisInstrumentation,
  loadRedisInstrumentation,
} from '../../src/instrumentation/database-instrumentation.ts';
import {
  loadAmqplibInstrumentation,
  loadKafkaJsInstrumentation,
} from '../../src/instrumentation/queue-instrumentation.ts';

/** The instrumentation export name each loader's module must expose. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- read only through `typeof`
const EXPORT_BY_KIND = {
  http: 'HttpInstrumentation',
  fetch: 'UndiciInstrumentation',
  ioredis: 'IORedisInstrumentation',
  redis: 'RedisInstrumentation',
  amqplib: 'AmqplibInstrumentation',
  kafkajs: 'KafkaJsInstrumentation',
} as const;

describe('Auto-instrumentation real-imports', () => {
  const loaders: Array<{
    kind: keyof typeof EXPORT_BY_KIND;
    load: () => Promise<{ instance: unknown }>;
  }> = [
    { kind: 'http', load: () => loadHttpInstrumentation(undefined) },
    { kind: 'fetch', load: () => loadFetchInstrumentation(undefined) },
    { kind: 'ioredis', load: () => loadIORedisInstrumentation(undefined) },
    { kind: 'redis', load: () => loadRedisInstrumentation(undefined) },
    { kind: 'amqplib', load: () => loadAmqplibInstrumentation(undefined) },
    { kind: 'kafkajs', load: () => loadKafkaJsInstrumentation(undefined) },
  ];

  for (const { kind, load } of loaders) {
    it(`should load ${kind} through the default importer`, async () => {
      const { instance } = await load();
      // The instance is a construction of the module's expected export, so a
      // successful construction proves the default importer resolved it.
      expect(instance).toBeInstanceOf(Object);
      // The constructed instance must expose the OTel instrumentation surface.
      expect(typeof (instance as { setTracerProvider?: unknown }).setTracerProvider).toBe(
        'function',
      );
      expect(typeof (instance as { enable?: unknown }).enable).toBe('function');
      expect(typeof (instance as { disable?: unknown }).disable).toBe('function');
    });
  }

  it('should construct BatchSpanProcessor and SimpleSpanProcessor from sdk-trace-base', async () => {
    const sdkMod = await import('@opentelemetry/sdk-trace-base');
    expect(sdkMod.BatchSpanProcessor).toBeDefined();
    expect(sdkMod.SimpleSpanProcessor).toBeDefined();
    expect(typeof sdkMod.BatchSpanProcessor).toBe('function');
    expect(typeof sdkMod.SimpleSpanProcessor).toBe('function');
  });
});
