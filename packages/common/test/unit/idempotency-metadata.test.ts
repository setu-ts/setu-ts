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
  it('reads a brand carrying its key header and whether the key is required', () => {
    const fn: MiddlewareFunction = () => {};
    const brand = { idempotent: true, keyHeader: 'Idempotency-Key', required: false } as const;
    withIdempotencyMetadata(fn, brand);
    expect(idempotencyMetadataOf(fn)).toEqual(brand);
  });
  it.each([
    undefined,
    null,
    1,
    'yes',
    true,
    {},
    { idempotent: false },
    { idempotent: true, keyHeader: 1 },
    { idempotent: true, required: 'no' },
  ])('ignores forged metadata %j', (value) => {
    const fn: MiddlewareFunction = () => {};
    Object.defineProperty(fn, IDEMPOTENCY_METADATA, { value });
    expect(idempotencyMetadataOf(fn)).toBeUndefined();
  });
});
