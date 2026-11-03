import { describe, it, expect } from 'vitest';
import {
  IDEMPOTENCY_METADATA,
  idempotencyMetadataOf,
  withIdempotencyMetadata,
} from '../../src/index.ts';
import type { MiddlewareFunction } from '../../src/index.ts';
describe('idempotency metadata', () => {
  it('preserves middleware identity and behavior with a non-enumerable brand', async () => {
    let called = false;
    const fn: MiddlewareFunction = async (_ctx, next) => {
      called = true;
      await next();
    };
    expect(withIdempotencyMetadata(fn, { idempotent: true })).toBe(fn);
    expect(idempotencyMetadataOf(fn)).toEqual({ idempotent: true });
    expect(Object.keys(fn)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(fn, IDEMPOTENCY_METADATA)?.enumerable).toBe(false);
    await fn({} as Parameters<MiddlewareFunction>[0], () => Promise.resolve());
    expect(called).toBe(true);
  });
  it.each([undefined, null, 1, 'yes', true, {}, { idempotent: false }])(
    'ignores forged metadata %j',
    (value) => {
      const fn: MiddlewareFunction = () => {};
      Object.defineProperty(fn, IDEMPOTENCY_METADATA, { value });
      expect(idempotencyMetadataOf(fn)).toBeUndefined();
    },
  );
});
