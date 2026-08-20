/**
 * Tests for the HTTP and Fetch instrumentation loaders.
 *
 * @module
 * @since 0.2.0
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createFetchInstrumentation,
  createHttpInstrumentation,
  loadFetchInstrumentation,
  loadHttpInstrumentation,
} from '../../src/instrumentation/http-instrumentation.ts';

describe('http-instrumentation', () => {
  it('should construct HttpInstrumentation via createHttpInstrumentation', () => {
    const fakeMod = {
      HttpInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createHttpInstrumentation(fakeMod, { ignoreUrls: ['/health'] });
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({
      ignoreUrls: ['/health'],
    });
  });

  it('should construct HttpInstrumentation with undefined config', () => {
    const fakeMod = {
      HttpInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createHttpInstrumentation(fakeMod, undefined);
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toBeUndefined();
  });

  it('should construct UndiciInstrumentation via createFetchInstrumentation', () => {
    const fakeMod = {
      UndiciInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createFetchInstrumentation(fakeMod, {});
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({});
  });

  // --- Loader seam: zero-argument importFn (M70e §3.5) ---
  //
  // The default importFn is a real literal `import()`; the guarded
  // `instrumentation-real-import.test.ts` drives it when the packages are
  // present. Here the seam is driven with an injected zero-argument importFn so
  // every branch is hermetic — no network, no dependence on the packages being
  // installed. The vacuous `try { … } catch { /* not installed */ }` pair is
  // gone: it passed whether or not the real package loaded.

  it('loadHttpInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ HttpInstrumentation: class {} });
    };
    const result = await loadHttpInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    // The reported specifier must equal the literal in the default import.
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-http@^0.220.0');
  });

  it('loadFetchInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ UndiciInstrumentation: class {} });
    };
    const result = await loadFetchInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-undici@^0.30.0');
  });

  it('loadHttpInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadHttpInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });

  it('loadFetchInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadFetchInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});
