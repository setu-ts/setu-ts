/**
 * Tests for the HTTP and Fetch instrumentation loaders.
 *
 * @module
 * @since 0.2.0
 */
import { describe, expect, it, vi } from 'vitest';
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
    expect(result.specifier).toBe('@opentelemetry/instrumentation-http');
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
    expect(result.specifier).toBe('@opentelemetry/instrumentation-undici');
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

describe('the guarded default imports (M113d §3.1)', () => {
  it('loadHttpInstrumentation rejects when the http instrumentation is absent', async () => {
    const { loadHttpInstrumentation } = await import(
      '../../src/instrumentation/http-instrumentation.ts'
    );
    vi.doMock('@opentelemetry/instrumentation-http', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadHttpInstrumentation(undefined);
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/instrumentation-http');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/instrumentation-http');
    }
  });

  it('loadFetchInstrumentation rejects when the undici instrumentation is absent', async () => {
    const { loadFetchInstrumentation } = await import(
      '../../src/instrumentation/http-instrumentation.ts'
    );
    vi.doMock('@opentelemetry/instrumentation-undici', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadFetchInstrumentation(undefined);
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/instrumentation-undici');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/instrumentation-undici');
    }
  });
});
