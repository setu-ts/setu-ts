import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolveCacheControl, IMMUTABLE_PATTERN } from '../../src/http/cache-control.ts';

describe('resolveCacheControl', () => {
  it('should return immutable for hashed assets', () => {
    const result = resolveCacheControl('index-a1b2c3d4.js', {});
    expect(result).toBe('public, max-age=31536000, immutable');
  });

  it('should return mutable for non-hashed assets', () => {
    const result = resolveCacheControl('index.html', {});
    expect(result).toBe('public, max-age=0, must-revalidate');
  });

  it('should use string override verbatim', () => {
    const result = resolveCacheControl('index.html', { cacheControl: 'no-cache' });
    expect(result).toBe('no-cache');
  });

  it('should call function override with relative path', () => {
    const fn = (_path: string) => 'custom';
    const result = resolveCacheControl('test.js', { cacheControl: fn });
    expect(result).toBe('custom');
  });

  it('should detect hash pattern', () => {
    expect(IMMUTABLE_PATTERN.test('index-a1b2c3d4.js')).toBe(true);
    expect(IMMUTABLE_PATTERN.test('style.css')).toBe(false);
    expect(IMMUTABLE_PATTERN.test('app.12345678.min.js')).toBe(true);
  });
});
