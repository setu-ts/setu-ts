/**
 * Guarded real-import integration test for auto-instrumentation packages.
 *
 * When the OTel npm packages are installed, this test exercises the real
 * imports and verifies the constructors resolve. When absent, it skips.
 *
 * @module
 * @since 0.24.1
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// Probe whether npm: imports are available
function canImportNpm(): boolean {
  try {
    const state = Deno.permissions.querySync({ name: 'import' }).state;
    return state === 'granted';
  } catch {
    return false;
  }
}

describe('Auto-instrumentation real-imports', () => {
  it(
    {
      name: 'should load @opentelemetry/instrumentation-http',
      ignore: !canImportNpm(),
    },
    async () => {
      const mod = await import('npm:@opentelemetry/instrumentation-http@^0.220.0');
      expect(mod.HttpInstrumentation).toBeDefined();
      expect(typeof mod.HttpInstrumentation).toBe('function');

      const instance = new mod.HttpInstrumentation();
      expect(typeof instance.setTracerProvider).toBe('function');
      expect(typeof instance.enable).toBe('function');
      expect(typeof instance.disable).toBe('function');
    },
  );

  it(
    {
      name: 'should load @opentelemetry/instrumentation-undici',
      ignore: !canImportNpm(),
    },
    async () => {
      const mod = await import('npm:@opentelemetry/instrumentation-undici@^0.30.0');
      expect(mod.UndiciInstrumentation).toBeDefined();
      expect(typeof mod.UndiciInstrumentation).toBe('function');

      const instance = new mod.UndiciInstrumentation();
      expect(typeof instance.setTracerProvider).toBe('function');
      expect(typeof instance.enable).toBe('function');
      expect(typeof instance.disable).toBe('function');
    },
  );

  it(
    {
      name: 'should load @opentelemetry/instrumentation-ioredis',
      ignore: !canImportNpm(),
    },
    async () => {
      const mod = await import('npm:@opentelemetry/instrumentation-ioredis@^0.68.0');
      expect(mod.IORedisInstrumentation).toBeDefined();
      expect(typeof mod.IORedisInstrumentation).toBe('function');

      const instance = new mod.IORedisInstrumentation();
      expect(typeof instance.setTracerProvider).toBe('function');
      expect(typeof instance.enable).toBe('function');
      expect(typeof instance.disable).toBe('function');
    },
  );

  it(
    {
      name: 'should load @opentelemetry/instrumentation-amqplib',
      ignore: !canImportNpm(),
    },
    async () => {
      const mod = await import('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
      expect(mod.AmqplibInstrumentation).toBeDefined();
      expect(typeof mod.AmqplibInstrumentation).toBe('function');

      const instance = new mod.AmqplibInstrumentation();
      expect(typeof instance.setTracerProvider).toBe('function');
      expect(typeof instance.enable).toBe('function');
      expect(typeof instance.disable).toBe('function');
    },
  );

  it(
    {
      name: 'should load @opentelemetry/instrumentation-kafkajs',
      ignore: !canImportNpm(),
    },
    async () => {
      const mod = await import('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
      expect(mod.KafkaJsInstrumentation).toBeDefined();
      expect(typeof mod.KafkaJsInstrumentation).toBe('function');

      const instance = new mod.KafkaJsInstrumentation();
      expect(typeof instance.setTracerProvider).toBe('function');
      expect(typeof instance.enable).toBe('function');
      expect(typeof instance.disable).toBe('function');
    },
  );

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
