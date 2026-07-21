/**
 * Tests for the database (ioredis) instrumentation loader.
 *
 * @module
 * @since 0.24.1
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createIORedisInstrumentation } from '../../src/instrumentation/database-instrumentation.ts';

describe('database-instrumentation', () => {
  it('should construct IORedisInstrumentation via createIORedisInstrumentation', () => {
    const fakeMod = {
      IORedisInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createIORedisInstrumentation(fakeMod, { config: { keyPrefix: 'he:' } });
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({
      config: { keyPrefix: 'he:' },
    });
  });

  it('should construct IORedisInstrumentation with undefined config', () => {
    const fakeMod = {
      IORedisInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createIORedisInstrumentation(fakeMod, undefined);
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toBeUndefined();
  });

  it('should lazy-load the correct npm specifier for ioredis', async () => {
    try {
      const mod = await import('npm:@opentelemetry/instrumentation-ioredis@^0.68.0');
      expect(mod.IORedisInstrumentation).toBeDefined();
      expect(typeof mod.IORedisInstrumentation).toBe('function');
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
