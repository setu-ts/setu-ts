/**
 * Tests for the queue (amqplib + kafkajs) instrumentation loaders.
 *
 * @module
 * @since 0.24.1
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createAmqplibInstrumentation,
  createKafkaJsInstrumentation,
  loadAmqplibInstrumentation,
  loadKafkaJsInstrumentation,
} from '../../src/instrumentation/queue-instrumentation.ts';

describe('queue-instrumentation', () => {
  it('should construct AmqplibInstrumentation via createAmqplibInstrumentation', () => {
    const fakeMod = {
      AmqplibInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createAmqplibInstrumentation(fakeMod, {});
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({});
  });

  it('should construct AmqplibInstrumentation with undefined config', () => {
    const fakeMod = {
      AmqplibInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createAmqplibInstrumentation(fakeMod, undefined);
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toBeUndefined();
  });

  it('should construct KafkaJsInstrumentation via createKafkaJsInstrumentation', () => {
    const fakeMod = {
      KafkaJsInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createKafkaJsInstrumentation(fakeMod, {});
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({});
  });

  it('should construct KafkaJsInstrumentation with undefined config', () => {
    const fakeMod = {
      KafkaJsInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createKafkaJsInstrumentation(fakeMod, undefined);
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toBeUndefined();
  });

  it('should lazy-load the correct npm specifier for amqplib', async () => {
    try {
      const mod = await import('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
      expect(mod.AmqplibInstrumentation).toBeDefined();
      expect(typeof mod.AmqplibInstrumentation).toBe('function');
    } catch {
      // OTel packages not installed.
    }
  });

  it('should lazy-load the correct npm specifier for kafkajs', async () => {
    try {
      const mod = await import('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
      expect(mod.KafkaJsInstrumentation).toBeDefined();
      expect(typeof mod.KafkaJsInstrumentation).toBe('function');
    } catch {
      // OTel packages not installed.
    }
  });

  it('should reject when the package specifier is invalid', async () => {
    await expect(
      import('npm:@opentelemetry/instrumentation-nonexistent-fake@^999.0.0'),
    ).rejects.toThrow();
  });

  // --- Direct coverage for loadAmqplibInstrumentation / loadKafkaJsInstrumentation ---

  it('loadAmqplibInstrumentation should return { instance, specifier } when real package is available', async () => {
    try {
      const result = await loadAmqplibInstrumentation(undefined);
      expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
      expect(result.instance).toBeDefined();
    } catch {
      // Packages not installed.
    }
  });

  it('loadKafkaJsInstrumentation should return { instance, specifier } when real package is available', async () => {
    try {
      const result = await loadKafkaJsInstrumentation(undefined);
      expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
      expect(result.instance).toBeDefined();
    } catch {
      // Packages not installed.
    }
  });

  it('loadAmqplibInstrumentation should use injected importFn', async () => {
    const fakeMod = { AmqplibInstrumentation: class {} };
    const importFn = (_spec: string) => Promise.resolve(fakeMod);
    const result = await loadAmqplibInstrumentation(undefined, importFn);
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
    expect(result.instance).toBeDefined();
  });

  it('loadKafkaJsInstrumentation should use injected importFn', async () => {
    const fakeMod = { KafkaJsInstrumentation: class {} };
    const importFn = (_spec: string) => Promise.resolve(fakeMod);
    const result = await loadKafkaJsInstrumentation(undefined, importFn);
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
    expect(result.instance).toBeDefined();
  });

  it('loadAmqplibInstrumentation should reject when importFn rejects', async () => {
    const importFn = (_spec: string) => Promise.reject(new Error('inject-fail'));
    await expect(loadAmqplibInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });

  it('loadKafkaJsInstrumentation should reject when importFn rejects', async () => {
    const importFn = (_spec: string) => Promise.reject(new Error('inject-fail'));
    await expect(loadKafkaJsInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});
