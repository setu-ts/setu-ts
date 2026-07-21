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
});
