/**
 * Tests for the database (ioredis) instrumentation loader.
 *
 * @module
 * @since 0.2.0
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createIORedisInstrumentation,
  loadIORedisInstrumentation,
} from '../../src/instrumentation/database-instrumentation.ts';

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

  // --- Loader seam: zero-argument importFn (M70e §3.5) ---
  //
  // The default importFn is a real literal `import()`; the guarded
  // `instrumentation-real-import.test.ts` drives it when the package is
  // present. The vacuous `try { … } catch { /* not installed */ }` pair is
  // gone: it passed whether or not the real package loaded.

  it('loadIORedisInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ IORedisInstrumentation: class {} });
    };
    const result = await loadIORedisInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-ioredis@^0.68.0');
  });

  it('loadIORedisInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadIORedisInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});
