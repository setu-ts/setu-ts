/**
 * The starter bounds the request body by default: one `runtime.maxBodyBytes`
 * feeds both the read bound (chunked bodies included) and the declared-length
 * check, and an explicit `requestSize` is kept as given.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STARTER_MAX_BODY_BYTES,
  starterHttpSecurityOptions,
  starterRuntimeOptions,
} from '../../src/app.ts';

describe('starter body limit', () => {
  it('defaults to 1 MiB for both the read and the declared length', () => {
    expect(DEFAULT_STARTER_MAX_BODY_BYTES).toBe(1_048_576);
    expect(starterRuntimeOptions({})).toEqual({ maxBodyBytes: 1_048_576 });
    expect(starterHttpSecurityOptions({})).toEqual({ requestSize: { maxBodySize: 1_048_576 } });
  });

  it('feeds one runtime.maxBodyBytes to both layers and keeps other runtime options', () => {
    const options = { runtime: { maxBodyBytes: 5 * 1_048_576 } };
    expect(starterRuntimeOptions(options)).toEqual({ maxBodyBytes: 5_242_880 });
    expect(starterHttpSecurityOptions(options).requestSize).toEqual({ maxBodySize: 5_242_880 });
    expect(starterRuntimeOptions({ runtime: {} })).toEqual({ maxBodyBytes: 1_048_576 });
  });

  it('keeps the other httpSecurity arms when it adds requestSize', () => {
    expect(starterHttpSecurityOptions({ httpSecurity: { cors: { origin: '*' } } })).toEqual({
      cors: { origin: '*' },
      requestSize: { maxBodySize: 1_048_576 },
    });
  });

  it('keeps an explicit requestSize as given, disabled included', () => {
    for (const requestSize of [{ maxBodySize: 10 }, { enabled: false }]) {
      const httpSecurity = { requestSize };
      expect(starterHttpSecurityOptions({ httpSecurity })).toBe(httpSecurity);
    }
  });
});
