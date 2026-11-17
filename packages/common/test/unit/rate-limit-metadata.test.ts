/**
 * Tests for the route rate-limit metadata brand (M137b §3.4).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_METADATA,
  rateLimitMetadataOf,
  withRateLimitMetadata,
} from '../../src/index.ts';
import type { MiddlewareFunction } from '../../src/index.ts';

describe('route rate-limit metadata', () => {
  it('brands in place, keeping identity and behaviour, under a global symbol', async () => {
    let called = false;
    const fn: MiddlewareFunction = async (_ctx, next) => {
      called = true;
      await next();
    };
    const branded = withRateLimitMetadata(fn, { standardHeaders: true });

    expect(branded).toBe(fn);
    expect(RATE_LIMIT_METADATA).toBe(Symbol.for('setu.rate-limit.metadata'));
    expect(rateLimitMetadataOf(branded)).toEqual({ standardHeaders: true });
    expect(Object.keys(branded)).toEqual([]);
    expect(JSON.stringify({ ...branded })).toBe('{}');
    await branded({} as never, () => Promise.resolve());
    expect(called).toBe(true);
  });

  it('round-trips standardHeaders: false', () => {
    const branded = withRateLimitMetadata((() => {}) as MiddlewareFunction, {
      standardHeaders: false,
    });
    expect(rateLimitMetadataOf(branded)).toEqual({ standardHeaders: false });
  });

  it('reads nothing from an unbranded middleware', () => {
    expect(rateLimitMetadataOf((() => {}) as MiddlewareFunction)).toBeUndefined();
  });

  it.each([null, 'yes', {}, { standardHeaders: 'true' }])(
    'treats a foreign value %j under the symbol as absent',
    (value) => {
      const fn: MiddlewareFunction = () => {};
      Object.defineProperty(fn, RATE_LIMIT_METADATA, { value });
      expect(rateLimitMetadataOf(fn)).toBeUndefined();
    },
  );
});
