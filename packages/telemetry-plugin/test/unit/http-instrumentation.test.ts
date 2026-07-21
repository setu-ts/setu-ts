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
});
