/**
 * Type-level tests: these assertions are verified by the compiler during
 * `deno check`/`deno test`. Runtime assertions cover the exported constants.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assertType } from '@std/testing/types';
import type { IsExact } from '@std/testing/types';
import { PLUGIN_PRIORITY } from '../../src/types.ts';
import type { HealthStatus, HttpMethod, LogLevel, RuntimePlatform } from '../../src/types.ts';
import { err, ok } from '../../src/result.ts';
import type { Result } from '../../src/result.ts';
import { none, some } from '../../src/option.ts';
import type { Option } from '../../src/option.ts';
import type { StandardCapability } from '../../src/tokens.ts';
import { CAPABILITIES } from '../../src/tokens.ts';

describe('shared types', () => {
  it('should type HttpMethod as the standard verb union', () => {
    assertType<
      IsExact<HttpMethod, 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'>
    >(true);
  });

  it('should type RuntimePlatform with all supported runtimes', () => {
    assertType<IsExact<RuntimePlatform, 'node' | 'deno' | 'bun' | 'cloudflare-workers'>>(true);
  });

  it('should type HealthStatus and LogLevel as unions', () => {
    assertType<IsExact<HealthStatus, 'up' | 'down' | 'degraded'>>(true);
    assertType<IsExact<LogLevel, 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'>>(true);
  });

  it('should include standard tokens in StandardCapability', () => {
    const logger: StandardCapability = CAPABILITIES.LOGGER;
    expect(logger).toBe('logger');
  });

  it('should order PLUGIN_PRIORITY bands from highest to lowest', () => {
    expect(PLUGIN_PRIORITY.HIGHEST).toBeLessThan(PLUGIN_PRIORITY.HIGH);
    expect(PLUGIN_PRIORITY.HIGH).toBeLessThan(PLUGIN_PRIORITY.NORMAL);
    expect(PLUGIN_PRIORITY.NORMAL).toBeLessThan(PLUGIN_PRIORITY.LOW);
    expect(PLUGIN_PRIORITY.LOW).toBeLessThan(PLUGIN_PRIORITY.LOWEST);
  });
});

describe('utility type narrowing', () => {
  it('should narrow Result via the success discriminant', () => {
    const result: Result<number, Error> = Math.random() >= 0 ? ok(1) : err(new Error('x'));
    if (result.success) {
      assertType<IsExact<typeof result.value, number>>(true);
    } else {
      assertType<IsExact<typeof result.error, Error>>(true);
    }
    expect(result.success).toBe(true);
  });

  it('should narrow Option via the present discriminant', () => {
    const option: Option<string> = Math.random() >= 0 ? some('x') : none();
    if (option.present) {
      assertType<IsExact<typeof option.value, string>>(true);
    }
    expect(option.present).toBe(true);
  });
});
