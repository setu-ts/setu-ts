/**
 * `splitWorkerEnv` — the partition that keeps a KV namespace out of
 * `IRuntimeServices.env`, where it would stringify to `[object Object]` and
 * silently corrupt configuration.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { splitWorkerEnv } from '../../src/index.ts';

describe('splitWorkerEnv', () => {
  it('separates string variables from object bindings', () => {
    const kv = { get: () => {} };
    const bucket = { head: () => {} };

    const { vars, bindings } = splitWorkerEnv({
      API_KEY: 'secret',
      REGION: 'weur',
      CACHE_KV: kv,
      UPLOADS: bucket,
    });

    expect(vars).toEqual({ API_KEY: 'secret', REGION: 'weur' });
    expect(bindings).toEqual({ CACHE_KV: kv, UPLOADS: bucket });
  });

  it('never lets a binding reach the string half', () => {
    const { vars } = splitWorkerEnv({ CACHE_KV: { get: () => {} } });
    // The defect this function exists to prevent: a config reader iterating
    // `env` and seeing '[object Object]'.
    expect(vars).toEqual({});
    expect(Object.values(vars)).not.toContain('[object Object]');
  });

  it('drops values that are neither a string nor an object', () => {
    const { vars, bindings } = splitWorkerEnv({
      COUNT: 42,
      ENABLED: true,
      NOTHING: null,
      ABSENT: undefined,
    });

    // Coercing a number would put a value in `env` that was never a variable;
    // treating null as a binding would hand a caller something with no methods.
    expect(vars).toEqual({});
    expect(bindings).toEqual({});
  });

  it('keeps an empty string, which is a legitimate variable value', () => {
    expect(splitWorkerEnv({ FLAG: '' }).vars).toEqual({ FLAG: '' });
  });

  it('treats an array binding as a binding, not a variable', () => {
    const { vars, bindings } = splitWorkerEnv({ LIST: ['a'] });
    expect(vars).toEqual({});
    expect(bindings).toEqual({ LIST: ['a'] });
  });

  it('returns two empty halves for an empty env', () => {
    expect(splitWorkerEnv({})).toEqual({ vars: {}, bindings: {} });
  });
});
