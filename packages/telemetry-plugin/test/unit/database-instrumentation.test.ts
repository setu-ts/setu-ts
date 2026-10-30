/**
 * Tests for the database (ioredis) instrumentation loader.
 *
 * @module
 * @since 0.2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import {
  createIORedisInstrumentation,
  loadIORedisInstrumentation,
  createRedisInstrumentation,
  loadRedisInstrumentation,
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
    expect(result.specifier).toBe('@opentelemetry/instrumentation-ioredis');
  });

  it('loadIORedisInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadIORedisInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});

describe('loadIORedisInstrumentation — the guarded default import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { loadIORedisInstrumentation } =
      await import('../../src/instrumentation/database-instrumentation.ts');
    vi.doMock('@opentelemetry/instrumentation-ioredis', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadIORedisInstrumentation(undefined);
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError).toBeInstanceOf(OptionalDependencyUnavailableError);
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/instrumentation-ioredis');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/instrumentation-ioredis');
    }
  });
});

describe('database-instrumentation redis', () => {
  it('should construct RedisInstrumentation via createRedisInstrumentation', () => {
    const fakeMod = {
      RedisInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createRedisInstrumentation(fakeMod, { config: { keyPrefix: 'he:' } });
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toEqual({
      config: { keyPrefix: 'he:' },
    });
  });

  it('should construct RedisInstrumentation with undefined config', () => {
    const fakeMod = {
      RedisInstrumentation: class {
        public configPassed: unknown;
        constructor(config: unknown) {
          this.configPassed = config;
        }
      },
    };

    const instance = createRedisInstrumentation(fakeMod, undefined);
    expect(instance).toBeDefined();
    expect((instance as { configPassed: unknown }).configPassed).toBeUndefined();
  });

  // --- Loader seam: zero-argument importFn (M70e §3.5) ---
  //
  // The default importFn is a real literal `import()`; the guarded
  // `instrumentation-real-import.test.ts` drives it when the package is
  // present. The vacuous `try { … } catch { /* not installed */ }` pair is
  // gone: it passed whether or not the real package loaded.

  it('loadRedisInstrumentation should use an injected zero-argument importFn', async () => {
    let calls = 0;
    const importFn = () => {
      calls++;
      return Promise.resolve({ RedisInstrumentation: class {} });
    };
    const result = await loadRedisInstrumentation(undefined, importFn);
    expect(calls).toBe(1);
    expect(result.instance).toBeDefined();
    expect(result.specifier).toBe('@opentelemetry/instrumentation-redis');
  });

  it('loadRedisInstrumentation should reject when importFn rejects', async () => {
    const importFn = () => Promise.reject(new Error('inject-fail'));
    await expect(loadRedisInstrumentation(undefined, importFn)).rejects.toThrow('inject-fail');
  });
});

describe('loadRedisInstrumentation — the guarded default import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { loadRedisInstrumentation } =
      await import('../../src/instrumentation/database-instrumentation.ts');
    vi.doMock('@opentelemetry/instrumentation-redis', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadRedisInstrumentation(undefined);
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError).toBeInstanceOf(OptionalDependencyUnavailableError);
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/instrumentation-redis');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/instrumentation-redis');
    }
  });
});
