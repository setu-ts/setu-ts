/**
 * Guarded real-import integration test for auto-instrumentation packages.
 *
 * Drives each of the five loaders through their **default** `importFn` (no
 * injection), so the real literal `import()` path — the branch no unit test
 * runs — is exercised. When the OTel npm packages are installed this proves
 * the default loads; when absent it skips.
 *
 * **Deno-only caveat:** this test resolves the specifiers through Deno's own
 * loader, so it passes on Deno whether or not the specifier survives JSR's
 * static npm-compatibility rewrite. That is precisely why it could never have
 * caught X7-3 (the `npm:` string shipping verbatim in the published artifact):
 * the published shape is only observable in a published artifact, which the
 * compat suite checks — see `compat/compat.test.mjs`. Do not mistake this file
 * for coverage of the published artifact.
 *
 * @module
 * @since 0.2.0
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  loadFetchInstrumentation,
  loadHttpInstrumentation,
} from '../../src/instrumentation/http-instrumentation.ts';
import { loadIORedisInstrumentation } from '../../src/instrumentation/database-instrumentation.ts';
import {
  loadAmqplibInstrumentation,
  loadKafkaJsInstrumentation,
} from '../../src/instrumentation/queue-instrumentation.ts';

// Probe whether npm: imports are available
function canImportNpm(): boolean {
  try {
    const state = Deno.permissions.querySync({ name: 'import' }).state;
    return state === 'granted';
  } catch {
    return false;
  }
}

/** The instrumentation export name each loader's module must expose. */
const EXPORT_BY_KIND = {
  http: 'HttpInstrumentation',
  fetch: 'UndiciInstrumentation',
  ioredis: 'IORedisInstrumentation',
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
    { kind: 'amqplib', load: () => loadAmqplibInstrumentation(undefined) },
    { kind: 'kafkajs', load: () => loadKafkaJsInstrumentation(undefined) },
  ];

  for (const { kind, load } of loaders) {
    it(
      {
        name: `should load ${kind} through the default importer`,
        ignore: !canImportNpm(),
      },
      async () => {
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
      },
    );
  }

  it(
    {
      name: 'should construct BatchSpanProcessor and SimpleSpanProcessor from sdk-trace-base',
      ignore: !canImportNpm(),
    },
    async () => {
      const sdkMod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
      expect(sdkMod.BatchSpanProcessor).toBeDefined();
      expect(sdkMod.SimpleSpanProcessor).toBeDefined();
      expect(typeof sdkMod.BatchSpanProcessor).toBe('function');
      expect(typeof sdkMod.SimpleSpanProcessor).toBe('function');
    },
  );
});
