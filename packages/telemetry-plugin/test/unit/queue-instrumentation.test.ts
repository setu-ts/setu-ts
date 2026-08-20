/**
 * Tests for the queue (amqplib + kafkajs) instrumentation loaders.
 *
 * @module
 * @since 0.2.0
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

  // --- Loader seam: zero-argument importFn (M70e §3.5) ---
  //
  // The default importFn is a real literal `import()`; the guarded
  // `instrumentation-real-import.test.ts` drives it when the packages are
  // present. The vacuous `try { … } catch { /* not installed */ }` pair is
  // gone: it passed whether or not the real package loaded.

  it('loadAmqplibInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ AmqplibInstrumentation: class {} });
    };
    const result = await loadAmqplibInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
  });

  it('loadKafkaJsInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ KafkaJsInstrumentation: class {} });
    };
    const result = await loadKafkaJsInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
  });

  it('loadAmqplibInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadAmqplibInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });

  it('loadKafkaJsInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadKafkaJsInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});
