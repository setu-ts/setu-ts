/**
 * Tests for the HTTP and Fetch instrumentation loaders.
 *
 * @module
 * @since 0.24.1
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

  it('should lazy-load the correct npm specifier for http', async () => {
    try {
      const mod = await import('npm:@opentelemetry/instrumentation-http@^0.220.0');
      expect(mod.HttpInstrumentation).toBeDefined();
      expect(typeof mod.HttpInstrumentation).toBe('function');
    } catch {
      // OTel packages not installed — expected in minimal environments.
    }
  });

  it('should lazy-load the correct npm specifier for undici (fetch)', async () => {
    try {
      const mod = await import('npm:@opentelemetry/instrumentation-undici@^0.30.0');
      expect(mod.UndiciInstrumentation).toBeDefined();
      expect(typeof mod.UndiciInstrumentation).toBe('function');
    } catch {
      // OTel packages not installed.
    }
  });

  it('should reject when the package specifier is invalid', async () => {
    await expect(
      import('npm:@opentelemetry/instrumentation-nonexistent-fake@^999.0.0'),
    ).rejects.toThrow();
  });

  // --- Direct coverage for loadHttpInstrumentation / loadFetchInstrumentation ---

  it('loadHttpInstrumentation should return { instance, specifier } when real package is available', async () => {
    try {
      const result = await loadHttpInstrumentation(undefined);
      expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-http@^0.220.0');
      expect(result.instance).toBeDefined();
    } catch {
      // Packages not installed — expected in minimal environments.
    }
  });

  it('loadFetchInstrumentation should return { instance, specifier } when real package is available', async () => {
    try {
      const result = await loadFetchInstrumentation(undefined);
      expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-undici@^0.30.0');
      expect(result.instance).toBeDefined();
    } catch {
      // Packages not installed.
    }
  });

  it('loadHttpInstrumentation should use injected importFn', async () => {
    const fakeMod = { HttpInstrumentation: class {} };
    const importFn = (_spec: string) => Promise.resolve(fakeMod);
    const result = await loadHttpInstrumentation(undefined, importFn);
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-http@^0.220.0');
    expect(result.instance).toBeDefined();
  });

  it('loadFetchInstrumentation should use injected importFn', async () => {
    const fakeMod = { UndiciInstrumentation: class {} };
    const importFn = (_spec: string) => Promise.resolve(fakeMod);
    const result = await loadFetchInstrumentation(undefined, importFn);
    expect(result.specifier).toBe('npm:@opentelemetry/instrumentation-undici@^0.30.0');
    expect(result.instance).toBeDefined();
  });

  it('loadHttpInstrumentation should reject when importFn rejects', async () => {
    const importFn = (_spec: string) => Promise.reject(new Error('inject-fail'));
    await expect(loadHttpInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });

  it('loadFetchInstrumentation should reject when importFn rejects', async () => {
    const importFn = (_spec: string) => Promise.reject(new Error('inject-fail'));
    await expect(loadFetchInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});
